import { DataSource } from 'typeorm';

import { createAppDataSourceFromEnvironment } from '../../src/database/data-source.js';
import { InventoryService } from '../../src/modules/inventory/inventory.service.js';
import {
  INVENTORY_PRODUCTS_CHECKPOINT_NAME,
  PollingChangeEnqueuer,
  PollingCheckpointStore,
  PollingCursor,
  PollingService,
} from '../../src/modules/ingestion/polling/polling.service.js';

describe('polling composite cursor integration contract', () => {
  let dataSource: DataSource;
  let inventory: InventoryService;
  let checkpointStore: PostgresCheckpointStore;
  let producer: RecordingChangeProducer;

  beforeEach(async () => {
    dataSource = createAppDataSourceFromEnvironment(process.env);
    await dataSource.initialize();
    await dataSource.dropDatabase();
    await dataSource.runMigrations();

    inventory = new InventoryService(dataSource);
    checkpointStore = new PostgresCheckpointStore(dataSource);
    producer = new RecordingChangeProducer();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('stores exactly updatedAt and productId after a fully accepted first page', async () => {
    await insertProduct('product-a', '2026-09-07T00:00:00.001Z');
    await insertProduct('product-b', '2026-09-07T00:00:00.002Z');
    const service = new PollingService(inventory, checkpointStore, producer);

    await expect(service.pollOnce()).resolves.toEqual({ enqueued: 2, checkpointAdvanced: true });

    const checkpoint = await readCheckpoint();
    expect(checkpoint).toEqual({
      name: INVENTORY_PRODUCTS_CHECKPOINT_NAME,
      product_id: 'product-b',
      updated_at: new Date('2026-09-07T00:00:00.002Z'),
    });
  });

  it('keeps the previous PostgreSQL checkpoint when a partial page enqueue fails', async () => {
    await writeCheckpoint('2026-09-07T00:00:00.000Z', 'product-0');
    await insertProduct('product-1', '2026-09-07T00:00:00.001Z');
    await insertProduct('product-2', '2026-09-07T00:00:00.002Z');
    await insertProduct('product-3', '2026-09-07T00:00:00.003Z');
    producer.failOnProductId = 'product-3';
    const service = new PollingService(inventory, checkpointStore, producer);

    await expect(service.pollOnce()).rejects.toThrow('enqueue failed for product-3');

    expect(await readCheckpoint()).toMatchObject({
      product_id: 'product-0',
      updated_at: new Date('2026-09-07T00:00:00.000Z'),
    });
  });

  it('uses deterministic timestamp then productId ordering for same-timestamp and cross-timestamp rows', async () => {
    await insertProduct('product-z', '2026-09-07T00:00:00.001Z');
    await insertProduct('product-a', '2026-09-07T00:00:00.002Z');
    await insertProduct('product-b', '2026-09-07T00:00:00.002Z');
    await insertProduct('product-c', '2026-09-07T00:00:00.002Z');
    await insertProduct('product-a-later', '2026-09-07T00:00:00.003Z');

    const allRows = await inventory.list({});
    expect(allRows.map((product) => product.id)).toEqual([
      'product-z',
      'product-a',
      'product-b',
      'product-c',
      'product-a-later',
    ]);

    const continuation = await inventory.list({
      updatedAfter: '2026-09-07T00:00:00.002Z',
      afterProductId: 'product-b',
    });

    expect(continuation.map((product) => product.id)).toEqual(['product-c', 'product-a-later']);
  });

  it('allows safe duplicate re-poll when checkpoint write fails after queue acceptance', async () => {
    await writeCheckpoint('2026-09-07T00:00:00.000Z', 'product-0');
    await insertProduct('product-1', '2026-09-07T00:00:00.001Z');
    checkpointStore.failWrite = true;
    const service = new PollingService(inventory, checkpointStore, producer);

    await expect(service.pollOnce()).rejects.toThrow('checkpoint write failed');

    expect(producer.productIds).toEqual(['product-1']);
    expect(await readCheckpoint()).toMatchObject({
      product_id: 'product-0',
      updated_at: new Date('2026-09-07T00:00:00.000Z'),
    });
  });

  async function insertProduct(id: string, updatedAt: string): Promise<void> {
    await dataSource.query(
      `
        INSERT INTO inventory_products (id, sku, name, price, quantity, version, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
      `,
      [id, `SKU-${id}`, `Product ${id}`, '12.30', 9, 7, updatedAt],
    );
  }

  async function writeCheckpoint(updatedAt: string, productId: string): Promise<void> {
    await dataSource.query(
      `
        INSERT INTO polling_checkpoints (name, updated_at, product_id)
        VALUES ($1, $2, $3)
      `,
      [INVENTORY_PRODUCTS_CHECKPOINT_NAME, updatedAt, productId],
    );
  }

  async function readCheckpoint(): Promise<{ name: string; updated_at: Date; product_id: string }> {
    const [row] = await dataSource.query(
      `
        SELECT name, updated_at, product_id
        FROM polling_checkpoints
        WHERE name = $1
      `,
      [INVENTORY_PRODUCTS_CHECKPOINT_NAME],
    );

    return row;
  }
});

class PostgresCheckpointStore implements PollingCheckpointStore {
  failWrite = false;

  constructor(private readonly dataSource: DataSource) {}

  async read(name: string): Promise<PollingCursor | null> {
    const [row] = await this.dataSource.query(
      `
        SELECT updated_at, product_id
        FROM polling_checkpoints
        WHERE name = $1
      `,
      [name],
    );

    if (!row) {
      return null;
    }

    return { updatedAt: row.updated_at, productId: row.product_id };
  }

  async write(name: string, cursor: PollingCursor): Promise<void> {
    if (this.failWrite) {
      throw new Error('checkpoint write failed');
    }

    await this.dataSource.query(
      `
        INSERT INTO polling_checkpoints (name, updated_at, product_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (name)
        DO UPDATE SET updated_at = EXCLUDED.updated_at, product_id = EXCLUDED.product_id
      `,
      [name, cursor.updatedAt, cursor.productId],
    );
  }
}

class RecordingChangeProducer implements PollingChangeEnqueuer {
  failOnProductId: string | undefined;
  productIds: string[] = [];

  async enqueueChange(input: { productId: string }) {
    this.productIds.push(input.productId);
    if (input.productId === this.failOnProductId) {
      throw new Error(`enqueue failed for ${input.productId}`);
    }

    return { id: `job-${input.productId}` };
  }
}
