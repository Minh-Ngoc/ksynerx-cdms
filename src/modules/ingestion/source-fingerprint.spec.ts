import { fingerprintCanonicalProductPayload } from '../changes/product-canonicalization.js';
import { ChangeSource } from '../changes/product-change-contract.js';
import { normalizePollingProductChange } from './polling-normalizer.js';
import { normalizeWebhookProductChange } from './webhook-normalizer.js';

describe('source-specific normalization before fingerprinting', () => {
  it('normalizes polling and webhook representations to the same payload and fingerprint', () => {
    const polling = normalizePollingProductChange({
      id: 'product-1',
      version: 4,
      sku: 'SKU-001',
      name: 'Product',
      price: '100.00',
      quantity: 3,
      updatedAt: '2026-01-02T03:04:05.000Z',
    });
    const webhook = normalizeWebhookProductChange({
      productId: 'product-1',
      version: 4,
      payload: {
        sku: ' SKU-001 ',
        name: 'Product',
        price: '100',
        quantity: 3,
      },
      observedAt: '2026-01-03T03:04:05.000Z',
    });

    expect(polling.source).toBe(ChangeSource.Polling);
    expect(webhook.source).toBe(ChangeSource.Webhook);
    expect(polling.payload).toEqual(webhook.payload);
    expect(fingerprintCanonicalProductPayload(polling.payload)).toBe(
      fingerprintCanonicalProductPayload(webhook.payload),
    );
  });

  it('excludes source, observedAt, productId, and version from the product-state fingerprint', () => {
    const first = normalizeWebhookProductChange({
      productId: 'product-a',
      version: 1,
      payload: {
        sku: 'SKU-001',
        name: 'Product',
        price: '100.00',
        quantity: 3,
      },
      observedAt: '2026-01-02T03:04:05.000Z',
    });
    const second = normalizeWebhookProductChange({
      productId: 'product-b',
      version: 8,
      payload: {
        sku: 'SKU-001',
        name: 'Product',
        price: '100',
        quantity: 3,
      },
      observedAt: '2026-01-03T03:04:05.000Z',
    });

    // Fingerprints model product state only. Delivery metadata is compared by later
    // processing rules and must not create false VERSION_CONFLICT results.
    expect(fingerprintCanonicalProductPayload(first.payload)).toBe(
      fingerprintCanonicalProductPayload(second.payload),
    );
  });
});
