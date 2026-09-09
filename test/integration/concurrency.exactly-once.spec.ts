import { Queue, Worker } from 'bullmq';
import { DataSource } from 'typeorm';

import {
  ChangeProcessingResultKind,
  ChangeProcessor,
  PRODUCT_CHANGE_ACCEPTED_EVENT_TYPE,
} from '../../src/modules/changes/change-processor.js';
import { normalizeCanonicalProductPayload } from '../../src/modules/changes/product-canonicalization.js';
import { ChangeSource, type ProductChangeInput } from '../../src/modules/changes/product-change-contract.js';
import { ProductLockService } from '../../src/modules/changes/product-lock.service.js';
import { createAppDataSourceFromEnvironment } from '../../src/database/data-source.js';
import { CHANGE_QUEUE_JOB_NAME, QUEUE_JOB_OPTIONS, QUEUE_NAMES } from '../../src/modules/queue/queue.constants.js';
import { deserializeChangeJobData, serializeChangeJobData } from '../../src/modules/queue/queue-wire-contracts.js';

describe('PostgreSQL exactly-once effect under concurrent delivery', () => {
  const redisConnection = {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
  };

  let dataSource: DataSource;
  let processor: ChangeProcessor;

  beforeAll(async () => {
    dataSource = createAppDataSourceFromEnvironment(process.env);
    await dataSource.initialize();
    processor = new ChangeProcessor(dataSource, new ProductLockService());
  });

  beforeEach(async () => {
    await dataSource.dropDatabase();
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('persists exactly one accepted change, state row, history row, and outbox row for 100 simultaneous identical first writes', async () => {
    const input = change('product-100-identical', 1, 'SKU-100');
    const results = await releaseTogether(100, () => processor.process(input));

    expect(countResults(results, ChangeProcessingResultKind.Accepted)).toBe(1);
    expect(countResults(results, ChangeProcessingResultKind.Duplicate)).toBe(99);
    await expectProductInvariant(input.productId, { version: 1, changes: 1, outbox: 1 });
  });

  it('separately proves the missing-row first-write race is serialized by the per-product advisory lock', async () => {
    const input = change('product-first-write-race', 1, 'SKU-FIRST-WRITE');
    const results = await releaseTogether(24, () => processor.process(input));

    expect(countResults(results, ChangeProcessingResultKind.Accepted)).toBe(1);
    expect(countResults(results, ChangeProcessingResultKind.Duplicate)).toBe(23);
    await expectProductInvariant(input.productId, { version: 1, changes: 1, outbox: 1 });
  });

  it('allows either lock acquisition order for v5/v6 but never regresses durable state below v6', async () => {
    for (let round = 0; round < 6; round += 1) {
      const productId = `product-v5-v6-${round}`;
      const v5 = change(productId, 5, `SKU-V5-${round}`);
      const v6 = change(productId, 6, `SKU-V6-${round}`);
      const results = await releaseTogether(2, (index) => processor.process(index === 0 ? v5 : v6));

      expect(results.every((result) => [
        ChangeProcessingResultKind.Accepted,
        ChangeProcessingResultKind.Stale,
      ].includes(result.result))).toBe(true);
      await expectProductInvariant(productId, { version: 6, changes: expect.any(Number), outbox: expect.any(Number) });

      const [{ changes, outbox }] = await dataSource.query(
        `
          SELECT
            (SELECT count(*)::int FROM product_changes WHERE product_id = $1) AS changes,
            (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1) AS outbox
        `,
        [productId],
      );
      expect(changes).toBe(outbox);
      expect(changes).toBeGreaterThanOrEqual(1);
      expect(changes).toBeLessThanOrEqual(2);
    }
  });

  it('treats concurrent same-version different payloads as conflict rather than last-writer-wins', async () => {
    const productId = 'product-same-version-conflict';
    const first = change(productId, 4, 'SKU-CONFLICT-A');
    const second = change(productId, 4, 'SKU-CONFLICT-B');
    const results = await releaseTogether(40, (index) => processor.process(index % 2 === 0 ? first : second));

    expect(countResults(results, ChangeProcessingResultKind.Accepted)).toBe(1);
    expect(countResults(results, ChangeProcessingResultKind.Duplicate)).toBeGreaterThan(0);
    expect(countResults(results, ChangeProcessingResultKind.VersionConflict)).toBeGreaterThan(0);
    await expectProductInvariant(productId, { version: 4, changes: 1, outbox: 1 });

    const [state] = await dataSource.query('SELECT payload FROM product_state WHERE product_id = $1', [productId]);
    expect([first.payload, second.payload]).toContainEqual(state.payload);
  });

  it('keeps advisory-lock serialization per product instead of creating cross-product state corruption', async () => {
    const inputs = Array.from({ length: 16 }, (_, index) => change(`product-distinct-${index}`, 1, `SKU-DISTINCT-${index}`));
    const results = await releaseTogether(inputs.length, (index) => processor.process(inputs[index]!));

    expect(results.every((result) => result.result === ChangeProcessingResultKind.Accepted)).toBe(true);
    const [{ states, changes, outbox }] = await dataSource.query(
      `
        SELECT
          (SELECT count(*)::int FROM product_state WHERE product_id LIKE 'product-distinct-%') AS states,
          (SELECT count(*)::int FROM product_changes WHERE product_id LIKE 'product-distinct-%') AS changes,
          (SELECT count(*)::int FROM outbox_events WHERE aggregate_id LIKE 'product-distinct-%') AS outbox
      `,
    );
    expect({ states, changes, outbox }).toEqual({ states: 16, changes: 16, outbox: 16 });
  });

  it('keeps one logical PostgreSQL effect when a real BullMQ worker runs duplicate jobs with concurrency above one', async () => {
    const input = change('product-bullmq-concurrency', 8, 'SKU-BULLMQ');
    const queue = new Queue(QUEUE_NAMES.change, { connection: redisConnection });
    await queue.drain(true);

    const workerStart = createBarrier(8);
    let activeWorkers = 0;
    let peakWorkers = 0;
    let completed = 0;
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: Error) => void;
    const allCompleted = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    const worker = new Worker(
      QUEUE_NAMES.change,
      async (job) => {
        activeWorkers += 1;
        peakWorkers = Math.max(peakWorkers, activeWorkers);
        try {
          // This gate proves BullMQ invokes multiple handlers concurrently. It does not guard
          // ChangeProcessor or database state; once released, each handler races through PostgreSQL.
          await workerStart.wait();
          return processor.process(deserializeChangeJobData(job.data));
        } finally {
          activeWorkers -= 1;
        }
      },
      { connection: redisConnection, concurrency: 8 },
    );
    worker.on('completed', () => {
      completed += 1;
      if (completed === 16) resolveCompleted();
    });
    worker.on('failed', (_job, error) => rejectCompleted(error));
    worker.on('error', rejectCompleted);

    try {
      await Promise.all(Array.from({ length: 16 }, () =>
        queue.add(CHANGE_QUEUE_JOB_NAME, serializeChangeJobData(input), QUEUE_JOB_OPTIONS),
      ));
      await allCompleted;

      expect(peakWorkers).toBeGreaterThan(1);
      await expectProductInvariant(input.productId, { version: 8, changes: 1, outbox: 1 });
    } finally {
      await worker.close();
      await queue.close();
    }
  });

  function change(productId: string, version: number, sku: string): ProductChangeInput {
    return {
      productId,
      version,
      source: ChangeSource.Webhook,
      payload: normalizeCanonicalProductPayload({
        sku,
        name: 'Concurrent Product',
        price: '10.00',
        quantity: 1,
      }),
      observedAt: new Date('2026-01-02T03:04:05.000Z'),
    };
  }

  async function expectProductInvariant(
    productId: string,
    expected: { version: number; changes: number | ReturnType<typeof expect.any>; outbox: number | ReturnType<typeof expect.any> },
  ): Promise<void> {
    const [state] = await dataSource.query('SELECT product_id, version FROM product_state WHERE product_id = $1', [productId]);
    const [{ changes }] = await dataSource.query('SELECT count(*)::int AS changes FROM product_changes WHERE product_id = $1', [productId]);
    const [{ outbox }] = await dataSource.query(
      'SELECT count(*)::int AS outbox FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2',
      [productId, PRODUCT_CHANGE_ACCEPTED_EVENT_TYPE],
    );

    expect(state).toEqual({ product_id: productId, version: expected.version });
    expect(changes).toEqual(expected.changes);
    expect(outbox).toEqual(expected.outbox);
  }
});

function countResults(
  results: Array<{ result: ChangeProcessingResultKind }>,
  kind: ChangeProcessingResultKind,
): number {
  return results.filter((result) => result.result === kind).length;
}

function createBarrier(participants: number): { wait(): Promise<void> } {
  let arrived = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });

  return {
    async wait(): Promise<void> {
      arrived += 1;
      if (arrived === participants) release();
      await released;
    },
  };
}

async function releaseTogether<T>(
  attempts: number,
  operation: (index: number) => Promise<T>,
): Promise<T[]> {
  const barrier = createBarrier(attempts);
  return Promise.all(Array.from({ length: attempts }, async (_value, index) => {
    await barrier.wait();
    return operation(index);
  }));
}
