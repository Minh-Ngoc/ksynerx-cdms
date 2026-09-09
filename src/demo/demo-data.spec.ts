import {
  createDemoScenario,
  DEFAULT_DEMO_SEED,
  DEMO_EXCEL_HEADERS,
  DEMO_SOURCE_PRODUCT_COUNT,
  generateDemoSourceProducts,
} from './demo-data.js';

describe('demo data manifest', () => {
  it('is deterministic for the same Faker seed', () => {
    expect(generateDemoSourceProducts(DEFAULT_DEMO_SEED)).toEqual(generateDemoSourceProducts(DEFAULT_DEMO_SEED));
  });

  it('generates a namespaced source inventory with unique ids and skus', () => {
    const products = generateDemoSourceProducts();

    expect(products).toHaveLength(DEMO_SOURCE_PRODUCT_COUNT);
    expect(new Set(products.map(({ id }) => id)).size).toBe(products.length);
    expect(new Set(products.map(({ sku }) => sku)).size).toBe(products.length);
    expect(products.every(({ id, sku, price, version }) => id.startsWith('demo-') && sku.startsWith('DEMO-') && /^\d+\.\d{2}$/.test(price) && version >= 1)).toBe(true);
  });

  it('keeps the scenario manifest internally consistent with the supported Excel schema', () => {
    const manifest = createDemoScenario();

    expect(DEMO_EXCEL_HEADERS).toEqual(['productId', 'version', 'sku', 'name', 'price', 'quantity', 'observedAt']);
    expect(manifest.pollingProductIds).toHaveLength(15);
    expect(manifest.webhookProducts).toHaveLength(10);
    expect(manifest.validExcelRows).toHaveLength(11);
    expect(manifest.partialExcelRows).toHaveLength(8);
    expect([...manifest.validExcelRows, ...manifest.partialExcelRows].every(({ productId, version, price }) => productId.startsWith('demo-') && version >= 1 && /^\d+\.\d{2}$/.test(price))).toBe(true);
    expect(manifest.replayProductIds).toHaveLength(5);
    expect(manifest.staleProductIds).toHaveLength(5);
    expect(manifest.conflictProductIds).toHaveLength(3);
  });
});
