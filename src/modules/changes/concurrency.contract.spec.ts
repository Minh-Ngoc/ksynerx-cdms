import {
  ChangeProcessingResultKind,
  decideChangeProcessingResult,
} from './change-processor.js';
import { fingerprintCanonicalProductPayload, normalizeCanonicalProductPayload } from './product-canonicalization.js';
import { ChangeSource, type ProductChangeInput } from './product-change-contract.js';

describe('concurrency semantic contract', () => {
  const payload = normalizeCanonicalProductPayload({
    sku: 'SKU-CONCURRENCY',
    name: 'Concurrency Product',
    price: '10.00',
    quantity: 1,
  });

  it('classifies an equal version and equal fingerprint as DUPLICATE rather than a second accepted write', () => {
    const input = change(4, payload);

    expect(decideChangeProcessingResult(input, {
      version: 4,
      fingerprint: fingerprintCanonicalProductPayload(payload),
    })).toBe(ChangeProcessingResultKind.Duplicate);
  });

  it('classifies an equal version and different fingerprint as VERSION_CONFLICT rather than last-writer-wins', () => {
    const winner = payload;
    const contender = normalizeCanonicalProductPayload({ ...payload, sku: 'SKU-CONFLICTING' });

    expect(decideChangeProcessingResult(change(4, contender), {
      version: 4,
      fingerprint: fingerprintCanonicalProductPayload(winner),
    })).toBe(ChangeProcessingResultKind.VersionConflict);
  });

  it('classifies a lower version as STALE so concurrent higher-version state cannot regress', () => {
    expect(decideChangeProcessingResult(change(5, payload), {
      version: 6,
      fingerprint: fingerprintCanonicalProductPayload(payload),
    })).toBe(ChangeProcessingResultKind.Stale);
  });
});

function change(version: number, payload: ProductChangeInput['payload']): ProductChangeInput {
  return {
    productId: 'product-concurrency-contract',
    version,
    source: ChangeSource.Webhook,
    payload,
    observedAt: new Date('2026-01-02T03:04:05.000Z'),
  };
}
