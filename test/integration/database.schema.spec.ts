import { DataSource, QueryFailedError } from 'typeorm';

import { createAppDataSourceFromEnvironment } from '../../src/database/data-source.js';

describe('database schema migrations', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = createAppDataSourceFromEnvironment(process.env);
    await dataSource.initialize();
    await dataSource.dropDatabase();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('creates and reverts the approved schema from an empty PostgreSQL database', async () => {
    await dataSource.runMigrations();

    await expectExistingTables([
      'inventory_products',
      'product_state',
      'product_changes',
      'outbox_events',
      'import_jobs',
      'import_batch_accounting',
      'polling_checkpoints',
    ]);

    await dataSource.undoLastMigration();
    await dataSource.undoLastMigration();

    await expectMissingTables([
      'inventory_products',
      'product_state',
      'product_changes',
      'outbox_events',
      'import_jobs',
      'import_batch_accounting',
      'polling_checkpoints',
    ]);
  });

  it('enforces product change identity by product and version only', async () => {
    await dataSource.runMigrations();

    await dataSource.query(
      `
        INSERT INTO product_changes (id, product_id, version, fingerprint, source, payload)
        VALUES
          ($1, $2, $3, $4, $5, $6),
          ($7, $8, $9, $10, $11, $12)
      `,
      [
        '11111111-1111-4111-8111-111111111111',
        'product-a',
        1,
        'same-fingerprint',
        'WEBHOOK',
        { sku: 'A', name: 'Alpha', price: '10.00', quantity: 1 },
        '22222222-2222-4222-8222-222222222222',
        'product-b',
        1,
        'same-fingerprint',
        'POLLING',
        { sku: 'B', name: 'Beta', price: '10.00', quantity: 2 },
      ],
    );

    await expect(
      dataSource.query(
        `
          INSERT INTO product_changes (id, product_id, version, fingerprint, source, payload)
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          '33333333-3333-4333-8333-333333333333',
          'product-a',
          1,
          'different-fingerprint',
          'EXCEL',
          { sku: 'A', name: 'Alpha again', price: '11.00', quantity: 3 },
        ],
      ),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('stores inventory price as exact NUMERIC(18,2)', async () => {
    await dataSource.runMigrations();

    await dataSource.query(
      `
        INSERT INTO inventory_products (id, sku, name, price, quantity, version)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      ['product-price', 'SKU-PRICE', 'Price Test', '1234567890123456.78', 5, 1],
    );

    const [{ price, data_type: dataType, numeric_precision: precision, numeric_scale: scale }] = await dataSource.query(
      `
        SELECT price::text AS price, c.data_type, c.numeric_precision, c.numeric_scale
        FROM inventory_products
        JOIN information_schema.columns c
          ON c.table_name = 'inventory_products'
         AND c.column_name = 'price'
        WHERE id = $1
      `,
      ['product-price'],
    );

    expect(price).toBe('1234567890123456.78');
    expect(dataType).toBe('numeric');
    expect(precision).toBe(18);
    expect(scale).toBe(2);
  });

  it('defines import progress defaults and nullable enqueue completion signal', async () => {
    await dataSource.runMigrations();

    await dataSource.query(
      `
        INSERT INTO import_jobs (id, filename, status)
        VALUES ($1, $2, $3)
      `,
      ['44444444-4444-4444-8444-444444444444', 'products.xlsx', 'CREATED'],
    );

    const [job] = await dataSource.query(
      `
        SELECT rows_read, rows_processed, rows_succeeded, rows_failed, enqueue_completed_at, completed_at
        FROM import_jobs
        WHERE id = $1
      `,
      ['44444444-4444-4444-8444-444444444444'],
    );

    expect(job).toEqual({
      rows_read: 0,
      rows_processed: 0,
      rows_succeeded: 0,
      rows_failed: 0,
      enqueue_completed_at: null,
      completed_at: null,
    });
  });

  it('persists the polling checkpoint composite cursor', async () => {
    await dataSource.runMigrations();

    await dataSource.query(
      `
        INSERT INTO polling_checkpoints (name, updated_at, product_id)
        VALUES ($1, $2, $3)
      `,
      ['inventory-products', '2026-09-07T00:00:00.000Z', 'product-99'],
    );

    const [checkpoint] = await dataSource.query(
      `
        SELECT name, updated_at::text, product_id
        FROM polling_checkpoints
        WHERE name = $1
      `,
      ['inventory-products'],
    );

    expect(checkpoint.name).toBe('inventory-products');
    expect(checkpoint.product_id).toBe('product-99');
    expect(checkpoint.updated_at).toContain('2026-09-07');
  });

  async function expectExistingTables(tableNames: string[]): Promise<void> {
    const rows = await dataSource.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
      `,
      [tableNames],
    );

    expect(rows.map((row: { table_name: string }) => row.table_name).sort()).toEqual([...tableNames].sort());
  }

  async function expectMissingTables(tableNames: string[]): Promise<void> {
    const rows = await dataSource.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
      `,
      [tableNames],
    );

    expect(rows).toEqual([]);
  }
});
