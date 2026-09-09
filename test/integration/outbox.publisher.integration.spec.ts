import { DataSource, EntityManager } from 'typeorm';
import { Queue } from 'bullmq';

import { AppConfigService } from '../../src/config/app-config.service.js';
import { createAppDataSourceFromEnvironment } from '../../src/database/data-source.js';
import { ChangeSource } from '../../src/modules/changes/product-change-contract.js';
import { OutboxStatus } from '../../src/modules/outbox/entities/outbox-event.entity.js';
import { OutboxPublisherRepository } from '../../src/modules/outbox/outbox-publisher.repository.js';
import { OutboxPublisherService } from '../../src/modules/outbox/outbox-publisher.service.js';
import { OutboxDownstreamQueueProducer } from '../../src/modules/queue/outbox-downstream-queue.producer.js';
import { DownstreamOutboxProcessor } from '../../src/modules/queue/processors/downstream-outbox.processor.js';
import { OUTBOX_DOWNSTREAM_JOB_NAME, QUEUE_NAMES } from '../../src/modules/queue/queue.constants.js';

describe('outbox publisher persistence and locking', () => {
  const eventIds = {
    one: '11111111-1111-4111-8111-111111111111',
    two: '22222222-2222-4222-8222-222222222222',
    three: '33333333-3333-4333-8333-333333333333',
    four: '44444444-4444-4444-8444-444444444444',
  } as const;

  let dataSource: DataSource;
  let repository: OutboxPublisherRepository;
  let downstream: RecordingDownstreamProducer;

  beforeEach(async () => {
    dataSource = createAppDataSourceFromEnvironment(process.env);
    await dataSource.initialize();
    await dataSource.dropDatabase();
    await dataSource.runMigrations();
    repository = new OutboxPublisherRepository(dataSource);
    downstream = new RecordingDownstreamProducer();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('publishes only OUTBOX_BATCH_SIZE pending rows and leaves the rest pending', async () => {
    await insertOutboxEvent(eventIds.one, 1);
    await insertOutboxEvent(eventIds.two, 2);
    await insertOutboxEvent(eventIds.three, 3);
    const publisher = new OutboxPublisherService(fakeConfig(2), repository, downstream);

    await expect(publisher.publishBatch()).resolves.toEqual({ published: 2, failed: 0 });

    expect(downstream.eventIds).toEqual([eventIds.one, eventIds.two]);
    await expectOutboxState(eventIds.one, OutboxStatus.Published, 0, null, expect.any(Date));
    await expectOutboxState(eventIds.two, OutboxStatus.Published, 0, null, expect.any(Date));
    await expectOutboxState(eventIds.three, OutboxStatus.Pending, 0, null, null);
  });

  it('records publication failure and keeps the event retryable', async () => {
    await insertOutboxEvent(eventIds.one, 1);
    downstream.failWith = new Error('redis token=secret unavailable');
    const publisher = new OutboxPublisherService(fakeConfig(1), repository, downstream);

    await expect(publisher.publishBatch()).rejects.toThrow('outbox publication failed');

    await expectOutboxState(eventIds.one, OutboxStatus.Pending, 1, 'redis token=[redacted] unavailable', null);
  });

  it('retries a pending event successfully after an earlier publish failure', async () => {
    await insertOutboxEvent(eventIds.one, 1);
    downstream.failOnce = true;
    const publisher = new OutboxPublisherService(fakeConfig(1), repository, downstream);

    await expect(publisher.publishBatch()).rejects.toThrow('outbox publication failed');
    await expect(publisher.publishBatch()).resolves.toEqual({ published: 1, failed: 0 });

    expect(downstream.eventIds).toEqual([eventIds.one, eventIds.one]);
    await expectOutboxState(eventIds.one, OutboxStatus.Published, 1, null, expect.any(Date));
  });

  it('allows duplicate publication when DB mark-published fails after queue acceptance', async () => {
    await insertOutboxEvent(eventIds.one, 1);
    const failingRepository = new MarkPublishedFailingRepository(dataSource);
    const publisherWithMarkFailure = new OutboxPublisherService(fakeConfig(1), failingRepository, downstream);

    await expect(publisherWithMarkFailure.publishBatch()).rejects.toThrow('mark published failed');

    await expectOutboxState(eventIds.one, OutboxStatus.Pending, 0, null, null);

    const publisher = new OutboxPublisherService(fakeConfig(1), repository, downstream);
    await expect(publisher.publishBatch()).resolves.toEqual({ published: 1, failed: 0 });

    expect(downstream.eventIds).toEqual([eventIds.one, eventIds.one]);
    await expectOutboxState(eventIds.one, OutboxStatus.Published, 0, null, expect.any(Date));
  });

  it('uses FOR UPDATE SKIP LOCKED so concurrent publishers claim different pending rows', async () => {
    await insertOutboxEvent(eventIds.one, 1);
    await insertOutboxEvent(eventIds.two, 2);

    const queryRunnerA = dataSource.createQueryRunner();
    const queryRunnerB = dataSource.createQueryRunner();
    await queryRunnerA.connect();
    await queryRunnerB.connect();
    await queryRunnerA.startTransaction();
    await queryRunnerB.startTransaction();

    try {
      const claimedByA = await repository.claimPending(queryRunnerA.manager, 1);
      const claimedByB = await repository.claimPending(queryRunnerB.manager, 1);

      expect(claimedByA.map((event) => event.id)).toEqual([eventIds.one]);
      expect(claimedByB.map((event) => event.id)).toEqual([eventIds.two]);
    } finally {
      await queryRunnerB.rollbackTransaction();
      await queryRunnerA.rollbackTransaction();
      await queryRunnerB.release();
      await queryRunnerA.release();
    }
  });

  it('enqueues a downstream BullMQ job from a committed outbox row', async () => {
    await insertOutboxEvent(eventIds.four, 4);
    const queue = new Queue(QUEUE_NAMES.downstream, {
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    });

    try {
      await queue.drain(true);
      const publisher = new OutboxPublisherService(fakeConfig(1), repository, new OutboxDownstreamQueueProducer(queue));

      await expect(publisher.publishBatch()).resolves.toEqual({ published: 1, failed: 0 });

      const jobs = await queue.getJobs(['waiting', 'delayed'], 0, 10);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.name).toBe(OUTBOX_DOWNSTREAM_JOB_NAME);
      expect(jobs[0]?.data).toEqual(
        expect.objectContaining({
          outboxEventId: eventIds.four,
          aggregateId: `product-${eventIds.four}`,
          eventType: 'PRODUCT_CHANGE_ACCEPTED',
        }),
      );
      await expectOutboxState(eventIds.four, OutboxStatus.Published, 0, null, expect.any(Date));
    } finally {
      await queue.drain(true);
      await queue.close();
    }
  });

  it('keeps duplicate downstream logging deliveries from mutating business state', async () => {
    await dataSource.query(
      `
        INSERT INTO product_state (product_id, version, fingerprint, payload, updated_at)
        VALUES ($1, 1, $2, $3, $4)
      `,
      ['product-duplicate-delivery', 'fingerprint-1', { sku: 'SKU-1' }, new Date('2026-01-02T03:04:05.000Z')],
    );
    await dataSource.query(
      `
        INSERT INTO product_changes (id, product_id, version, fingerprint, source, payload, created_at)
        VALUES ($1, $2, 1, $3, $4, $5, $6)
      `,
      [
        '55555555-5555-4555-8555-555555555555',
        'product-duplicate-delivery',
        'fingerprint-1',
        ChangeSource.Webhook,
        { sku: 'SKU-1' },
        new Date('2026-01-02T03:04:05.000Z'),
      ],
    );
    const before = await businessCounts();
    const processor = new DownstreamOutboxProcessor();

    await processor.process({
      id: 'job-1',
      data: {
        outboxEventId: eventIds.one,
        aggregateId: 'product-duplicate-delivery',
        eventType: 'PRODUCT_CHANGE_ACCEPTED',
        payload: { productId: 'product-duplicate-delivery' },
        createdAt: '2026-01-02T03:04:05.000Z',
      },
    } as never);
    await processor.process({
      id: 'job-2',
      data: {
        outboxEventId: eventIds.one,
        aggregateId: 'product-duplicate-delivery',
        eventType: 'PRODUCT_CHANGE_ACCEPTED',
        payload: { productId: 'product-duplicate-delivery' },
        createdAt: '2026-01-02T03:04:05.000Z',
      },
    } as never);

    await expect(businessCounts()).resolves.toEqual(before);
  });

  async function insertOutboxEvent(id: string, order: number): Promise<void> {
    await dataSource.query(
      `
        INSERT INTO outbox_events (id, aggregate_id, event_type, payload, status, attempts, created_at)
        VALUES ($1, $2, $3, $4, $5, 0, $6)
      `,
      [
        id,
        `product-${id}`,
        'PRODUCT_CHANGE_ACCEPTED',
        { productId: `product-${id}`, version: 1 },
        OutboxStatus.Pending,
        new Date(`2026-01-02T03:04:05.${order}00Z`),
      ],
    );
  }

  async function businessCounts(): Promise<{ stateCount: string; changeCount: string }> {
    const [row] = (await dataSource.query(
      `
        SELECT
          (SELECT count(*) FROM product_state) AS "stateCount",
          (SELECT count(*) FROM product_changes) AS "changeCount"
      `,
    )) as Array<{ stateCount: string; changeCount: string }>;

    return row;
  }

  async function expectOutboxState(
    id: string,
    status: OutboxStatus,
    attempts: number,
    lastError: string | null,
    publishedAt: unknown,
  ): Promise<void> {
    const [row] = await dataSource.query(
      `
        SELECT status, attempts, last_error, published_at
        FROM outbox_events
        WHERE id = $1
      `,
      [id],
    );

    expect(row).toEqual({
      status,
      attempts,
      last_error: lastError,
      published_at: publishedAt,
    });
  }
});

function fakeConfig(batchSize: number): AppConfigService {
  return {
    outbox: { batchSize, pollIntervalMs: 1000 },
  } as AppConfigService;
}

class RecordingDownstreamProducer {
  eventIds: string[] = [];
  failWith: Error | undefined;
  failOnce = false;

  async enqueueOutboxEvent(event: { outboxEventId: string }): Promise<void> {
    this.eventIds.push(event.outboxEventId);

    if (this.failWith !== undefined) {
      throw this.failWith;
    }

    if (this.failOnce) {
      this.failOnce = false;
      throw new Error('redis unavailable');
    }
  }
}

class MarkPublishedFailingRepository extends OutboxPublisherRepository {
  async markPublished(_manager: EntityManager, _id: string): Promise<void> {
    throw new Error('mark published failed');
  }
}
