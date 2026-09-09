import {
  ChangeProcessingResultKind,
  decideChangeProcessingResult,
} from './change-processor.js';
import {
  fingerprintCanonicalProductPayload,
  normalizeCanonicalProductPayload,
} from './product-canonicalization.js';
import { ChangeSource, ProductChangeInput } from './product-change-contract.js';

describe('ChangeProcessor decision table', () => {
  const payload = normalizeCanonicalProductPayload({
    sku: 'SKU-001',
    name: 'Product',
    price: '10.00',
    quantity: 1,
  });
  const fingerprint = fingerprintCanonicalProductPayload(payload);
  const input: ProductChangeInput = {
    productId: 'product-1',
    version: 2,
    source: ChangeSource.Webhook,
    payload,
    observedAt: new Date('2026-01-02T03:04:05.000Z'),
  };

  it('accepts when no product_state exists yet', () => {
    expect(decideChangeProcessingResult(input, null)).toBe(ChangeProcessingResultKind.Accepted);
  });

  it('marks lower incoming versions as STALE so product_state never regresses', () => {
    expect(
      decideChangeProcessingResult(
        { ...input, version: 1 },
        { version: 2, fingerprint },
      ),
    ).toBe(ChangeProcessingResultKind.Stale);
  });

  it('marks same product/version/fingerprint as DUPLICATE and not VERSION_CONFLICT', () => {
    expect(
      decideChangeProcessingResult(input, {
        version: input.version,
        fingerprint,
      }),
    ).toBe(ChangeProcessingResultKind.Duplicate);
  });

  it('marks same product/version with a different fingerprint as VERSION_CONFLICT', () => {
    expect(
      decideChangeProcessingResult(input, {
        version: input.version,
        fingerprint: 'different-fingerprint',
      }),
    ).toBe(ChangeProcessingResultKind.VersionConflict);
  });

  it('accepts newer incoming versions', () => {
    expect(
      decideChangeProcessingResult(input, {
        version: 1,
        fingerprint: 'older-fingerprint',
      }),
    ).toBe(ChangeProcessingResultKind.Accepted);
  });

  it('ignores observedAt and source when deciding duplicate state identity', () => {
    const laterDelivery: ProductChangeInput = {
      ...input,
      source: ChangeSource.Polling,
      observedAt: new Date('2026-01-03T03:04:05.000Z'),
    };

    expect(
      decideChangeProcessingResult(laterDelivery, {
        version: laterDelivery.version,
        fingerprint,
      }),
    ).toBe(ChangeProcessingResultKind.Duplicate);
  });
});
