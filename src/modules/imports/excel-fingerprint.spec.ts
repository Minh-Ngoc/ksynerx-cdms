import { fingerprintCanonicalProductPayload } from '../changes/product-canonicalization.js';
import { ChangeSource } from '../changes/product-change-contract.js';
import { normalizeWebhookProductChange } from '../ingestion/webhook-normalizer.js';
import { normalizeExcelProductChange } from './excel-row-normalizer.js';

describe('Excel row normalization before fingerprinting', () => {
  it('normalizes accepted Excel decimal representations to the same canonical payload as webhook input', () => {
    const excel = normalizeExcelProductChange({
      productId: 'product-1',
      version: 4,
      sku: 'SKU-001',
      name: 'Product',
      price: '100.0',
      quantity: 3,
      observedAt: new Date('2026-01-02T03:04:05.000Z'),
    });
    const webhook = normalizeWebhookProductChange({
      productId: 'product-1',
      version: 4,
      payload: {
        sku: 'SKU-001',
        name: 'Product',
        price: '100',
        quantity: 3,
      },
    });

    expect(excel.source).toBe(ChangeSource.Excel);
    expect(webhook.source).toBe(ChangeSource.Webhook);
    expect(excel.payload).toEqual(webhook.payload);
    expect(fingerprintCanonicalProductPayload(excel.payload)).toBe(
      fingerprintCanonicalProductPayload(webhook.payload),
    );
  });

  it('rejects malformed Excel row values at the normalization boundary', () => {
    expect(() =>
      normalizeExcelProductChange({
        productId: 'product-1',
        version: 4,
        sku: 'SKU-001',
        name: 'Product',
        price: 'not-a-decimal',
        quantity: 3,
        observedAt: new Date('2026-01-02T03:04:05.000Z'),
      }),
    ).toThrow();
  });
});
