import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { createAppDataSourceFromEnvironment } from '../../src/database/data-source.js';
import { InventoryService } from '../../src/modules/inventory/inventory.service.js';

describe('inventory emulator persistence', () => {
  let dataSource: DataSource;
  let service: InventoryService;

  beforeEach(async () => {
    dataSource = createAppDataSourceFromEnvironment(process.env);
    await dataSource.initialize();
    await dataSource.dropDatabase();
    await dataSource.runMigrations();
    service = new InventoryService(dataSource);
  });

  afterEach(async () => {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('creates version 1 products and preserves exact NUMERIC price strings', async () => {
    const product = await service.create({
      sku: 'SKU-EXACT',
      name: 'Exact Price',
      price: '9999999999999999.99',
      quantity: 7,
    });

    expect(product).toMatchObject({
      sku: 'SKU-EXACT',
      name: 'Exact Price',
      price: '9999999999999999.99',
      quantity: 7,
      version: 1,
    });

    const [stored] = await dataSource.query('SELECT price::text AS price FROM inventory_products WHERE id = $1', [
      product.id,
    ]);

    expect(stored.price).toBe('9999999999999999.99');
  });

  it('maps duplicate SKU create failures narrowly and does not insert a second row', async () => {
    await service.create({ sku: 'SKU-DUP', name: 'First', price: '10.00', quantity: 1 });

    await expect(service.create({ sku: 'SKU-DUP', name: 'Second', price: '11.00', quantity: 2 })).rejects.toBeInstanceOf(
      ConflictException,
    );

    const [{ count }] = await dataSource.query('SELECT count(*)::int AS count FROM inventory_products WHERE sku = $1', [
      'SKU-DUP',
    ]);

    expect(count).toBe(1);
  });

  it('returns missing products as not found', async () => {
    await expect(service.getById('missing-product')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('increments version exactly once and advances updatedAt for each successful patch', async () => {
    const product = await service.create({ sku: 'SKU-PATCH', name: 'Patch Me', price: '10.00', quantity: 1 });

    const updated = await service.update(product.id, { name: 'Patched', price: '10.10' });

    expect(updated).toMatchObject({
      id: product.id,
      sku: 'SKU-PATCH',
      name: 'Patched',
      price: '10.10',
      quantity: 1,
      version: 2,
    });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(product.updatedAt));
  });

  it('does not increment version when a SKU update conflicts', async () => {
    const existing = await service.create({ sku: 'SKU-EXISTS', name: 'Existing', price: '1.00', quantity: 1 });
    const target = await service.create({ sku: 'SKU-TARGET', name: 'Target', price: '2.00', quantity: 2 });

    await expect(service.update(target.id, { sku: existing.sku })).rejects.toBeInstanceOf(ConflictException);

    const unchanged = await service.getById(target.id);
    expect(unchanged.sku).toBe('SKU-TARGET');
    expect(unchanged.version).toBe(1);
  });

  it('lists by updatedAt and id with the stable composite cursor predicate', async () => {
    await insertProduct({ id: 'product-a', sku: 'SKU-A', updatedAt: '2026-09-07T00:00:00.123Z' });
    await insertProduct({ id: 'product-b', sku: 'SKU-B', updatedAt: '2026-09-07T00:00:00.123Z' });
    await insertProduct({ id: 'product-c', sku: 'SKU-C', updatedAt: '2026-09-07T00:00:01.123Z' });

    const firstPage = await service.list({});
    expect(firstPage.map((product) => product.id)).toEqual(['product-a', 'product-b', 'product-c']);

    const continuation = await service.list({
      updatedAfter: '2026-09-07T00:00:00.123Z',
      afterProductId: 'product-a',
    });

    expect(continuation.map((product) => product.id)).toEqual(['product-b', 'product-c']);
  });

  it('does not lose version increments during concurrent successful patches', async () => {
    const product = await service.create({ sku: 'SKU-CONCURRENT', name: 'Concurrent', price: '5.00', quantity: 1 });

    const updates = Array.from({ length: 8 }, (_, index) =>
      service.update(product.id, { quantity: index + 2 }),
    );

    await Promise.all(updates);

    const updated = await service.getById(product.id);
    expect(updated.version).toBe(9);
  });

  it('seeds configured inventory once and leaves existing inventory untouched on restart', async () => {
    await service.seedIfNeeded(3);
    await service.seedIfNeeded(3);

    const products = await service.list({});

    expect(products).toHaveLength(3);
    expect(products.map((product) => product.sku)).toEqual(['DEMO-SKU-0001', 'DEMO-SKU-0002', 'DEMO-SKU-0003']);
    expect(products.every((product) => product.version === 1)).toBe(true);
  });

  async function insertProduct(input: { id: string; sku: string; updatedAt: string }): Promise<void> {
    await dataSource.query(
      `
        INSERT INTO inventory_products (id, sku, name, price, quantity, version, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
      `,
      [input.id, input.sku, input.sku, '1.00', 1, 1, input.updatedAt],
    );
  }
});
