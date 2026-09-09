import { DataSource } from 'typeorm';

import {
  ChangeProcessingResultKind,
  ChangeProcessor,
  PRODUCT_CHANGE_ACCEPTED_EVENT_TYPE,
} from '../../src/modules/changes/change-processor.js';
import {
  fingerprintCanonicalProductPayload,
  normalizeCanonicalProductPayload,
} from '../../src/modules/changes/product-canonicalization.js';
import { ChangeSource, ProductChangeInput } from '../../src/modules/changes/product-change-contract.js';
import { ProductLockService } from '../../src/modules/changes/product-lock.service.js';
import { createAppDataSourceFromEnvironment } from '../../src/database/data-source.js';

describe('ChangeProcessor transactional behavior', () => {
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
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('atomically persists history, latest state, and a pending outbox event for ACCEPTED', async () => {
    const input = changeInput('product-accepted', 1, 'SKU-ACCEPTED');

    await expect(processor.process(input)).resolves.toEqual({
      result: ChangeProcessingResultKind.Accepted,
      productId: input.productId,
      version: input.version,
    });

    await expectPersistedState(input);
    await expectPersistedAcceptedChange(input);
    await expectPendingOutboxEvent(input);
  });

  it('makes a second identical delivery DUPLICATE with no extra history, state mutation, or outbox event', async () => {
    const first = changeInput('product-duplicate', 1, 'SKU-DUPLICATE', ChangeSource.Webhook);
    const second = {
      ...first,
      source: ChangeSource.Polling,
      observedAt: new Date('2026-01-03T03:04:05.000Z'),
    };

    await expect(processor.process(first)).resolves.toMatchObject({
      result: ChangeProcessingResultKind.Accepted,
    });
    await expect(processor.process(second)).resolves.toEqual({
      result: ChangeProcessingResultKind.Duplicate,
      productId: second.productId,
      version: second.version,
    });

    await expectPersistedState(first);
    await expectPersistedAcceptedChange(first);
    await expectPendingOutboxEvent(first);
  });

  it('keeps newer state when an older version arrives as STALE with no side effects', async () => {
    const newer = changeInput('product-stale', 2, 'SKU-STALE');
    const stale = changeInput('product-stale', 1, 'SKU-STALE');

    await expect(processor.process(newer)).resolves.toMatchObject({
      result: ChangeProcessingResultKind.Accepted,
    });
    await expect(processor.process(stale)).resolves.toEqual({
      result: ChangeProcessingResultKind.Stale,
      productId: stale.productId,
      version: stale.version,
    });

    await expectPersistedState(newer);
    await expectPersistedAcceptedChange(newer);
    await expectPendingOutboxEvent(newer);
  });

  it('rejects same-version different-fingerprint input as VERSION_CONFLICT without accepted side effects', async () => {
    const accepted = changeInput('product-conflict', 1, 'SKU-CONFLICT-A');
    const conflicting = changeInput('product-conflict', 1, 'SKU-CONFLICT-B');

    await expect(processor.process(accepted)).resolves.toMatchObject({
      result: ChangeProcessingResultKind.Accepted,
    });
    await expect(processor.process(conflicting)).resolves.toEqual({
      result: ChangeProcessingResultKind.VersionConflict,
      productId: conflicting.productId,
      version: conflicting.version,
    });

    await expectPersistedState(accepted);
    await expectPersistedAcceptedChange(accepted);
    await expectPendingOutboxEvent(accepted);
  });

  it('serializes the missing-row first-write race into one ACCEPTED result and one DUPLICATE result', async () => {
    const input = changeInput('product-first-race', 1, 'SKU-FIRST-RACE');

    const results = await Promise.all([processor.process(input), processor.process(input)]);

    expect(results.map((result) => result.result).sort()).toEqual([
      ChangeProcessingResultKind.Accepted,
      ChangeProcessingResultKind.Duplicate,
    ].sort());
    await expectPersistedState(input);
    await expectPersistedAcceptedChange(input);
    await expectPendingOutboxEvent(input);
  });

  it('serializes same-version different-payload races into one ACCEPTED result and one VERSION_CONFLICT result', async () => {
    const first = changeInput('product-conflict-race', 1, 'SKU-CONFLICT-RACE-A');
    const second = changeInput('product-conflict-race', 1, 'SKU-CONFLICT-RACE-B');

    const results = await Promise.all([processor.process(first), processor.process(second)]);

    expect(results.map((result) => result.result).sort()).toEqual([
      ChangeProcessingResultKind.Accepted,
      ChangeProcessingResultKind.VersionConflict,
    ].sort());
    await expectPersistedChangeCount(first.productId, 1);
    await expectPendingOutboxCount(first.productId, 1);
  });

  it('leaves final product_state at version 6 for concurrent v5/v6 deliveries regardless of commit order', async () => {
    const v5 = changeInput('product-newer-race', 5, 'SKU-NEWER-RACE');
    const v6 = changeInput('product-newer-race', 6, 'SKU-NEWER-RACE');

    const results = await Promise.all([processor.process(v5), processor.process(v6)]);
    const resultKinds = results.map((result) => result.result);

    expect(resultKinds).toContain(ChangeProcessingResultKind.Accepted);
    expect(resultKinds.every((result) => [ChangeProcessingResultKind.Accepted, ChangeProcessingResultKind.Stale].includes(result))).toBe(true);

    const [state] = await dataSource.query('SELECT version FROM product_state WHERE product_id = $1', [
      v5.productId,
    ]);
    expect(state.version).toBe(6);
  });

  it('rolls back all accepted-write side effects if a later outbox insert fails', async () => {
    const input = changeInput('product-rollback', 1, 'SKU-ROLLBACK');

    await dataSource.query('ALTER TABLE outbox_events ADD CONSTRAINT ck_force_outbox_failure CHECK (false) NOT VALID');

    await expect(processor.process(input)).rejects.toThrow('ck_force_outbox_failure');
    await expectPersistedChangeCount(input.productId, 0);
    await expectStateMissing(input.productId);
    await expectPendingOutboxCount(input.productId, 0);
  });

  function changeInput(
    productId: string,
    version: number,
    sku: string,
    source: ChangeSource = ChangeSource.Webhook,
  ): ProductChangeInput {
    const payload = normalizeCanonicalProductPayload({
      sku,
      name: 'Product',
      price: '10.00',
      quantity: 1,
    });

    return {
      productId,
      version,
      source,
      payload,
      observedAt: new Date('2026-01-02T03:04:05.000Z'),
    };
  }

  async function expectPersistedState(input: ProductChangeInput): Promise<void> {
    const [state] = await dataSource.query(
      'SELECT product_id, version, fingerprint, payload FROM product_state WHERE product_id = $1',
      [input.productId],
    );

    expect(state).toMatchObject({
      product_id: input.productId,
      version: input.version,
      fingerprint: fingerprintCanonicalProductPayload(input.payload),
      payload: input.payload,
    });
  }

  async function expectStateMissing(productId: string): Promise<void> {
    const rows = await dataSource.query('SELECT product_id FROM product_state WHERE product_id = $1', [productId]);
    expect(rows).toEqual([]);
  }

  async function expectPersistedChangeCount(productId: string, expectedCount: number): Promise<void> {
    const [{ count }] = await dataSource.query(
      'SELECT count(*)::int AS count FROM product_changes WHERE product_id = $1',
      [productId],
    );
    expect(count).toBe(expectedCount);
  }

  async function expectPersistedAcceptedChange(input: ProductChangeInput): Promise<void> {
    const rows = await dataSource.query(
      `
        SELECT product_id, version, fingerprint, source, payload
        FROM product_changes
        WHERE product_id = $1
      `,
      [input.productId],
    );

    expect(rows).toEqual([
      {
        product_id: input.productId,
        version: input.version,
        fingerprint: fingerprintCanonicalProductPayload(input.payload),
        source: input.source,
        payload: input.payload,
      },
    ]);
  }

  async function expectPendingOutboxEvent(input: ProductChangeInput): Promise<void> {
    const rows = await dataSource.query(
      `
        SELECT aggregate_id, event_type, payload, status, attempts
        FROM outbox_events
        WHERE aggregate_id = $1
          AND event_type = $2
          AND status = 'PENDING'
          AND attempts = 0
      `,
      [input.productId, PRODUCT_CHANGE_ACCEPTED_EVENT_TYPE],
    );

    expect(rows).toEqual([
      {
        aggregate_id: input.productId,
        event_type: PRODUCT_CHANGE_ACCEPTED_EVENT_TYPE,
        payload: {
          productId: input.productId,
          version: input.version,
          fingerprint: fingerprintCanonicalProductPayload(input.payload),
          source: input.source,
          payload: input.payload,
          observedAt: input.observedAt.toISOString(),
        },
        status: 'PENDING',
        attempts: 0,
      },
    ]);
  }

  async function expectPendingOutboxCount(productId: string, expectedCount: number): Promise<void> {
    const [{ count }] = await dataSource.query(
      'SELECT count(*)::int AS count FROM outbox_events WHERE aggregate_id = $1',
      [productId],
    );
    expect(count).toBe(expectedCount);
  }
});
