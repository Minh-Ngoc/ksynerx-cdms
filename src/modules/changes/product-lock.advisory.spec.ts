import {
  PRODUCT_LOCK_KEY_DERIVATION_CONTRACT,
  ProductLockService,
} from './product-lock.service.js';

describe('ProductLockService advisory key contract', () => {
  const service = new ProductLockService();

  it.each([
    ['product-001', '-1336201113986245942'],
    ['product-002', '5002171236766551277'],
    ['sản-phẩm-001', '-6758094107655962726'],
  ])('derives a stable signed 64-bit key fixture for %s', (productId, expectedKey) => {
    expect(service.deriveAdvisoryKey(productId)).toEqual({
      value: BigInt(expectedKey),
      parameter: expectedKey,
    });
  });

  it('returns a string SQL parameter so arbitrary int64 values never pass through JS Number', () => {
    const key = service.deriveAdvisoryKey('product-001');

    expect(typeof key.value).toBe('bigint');
    expect(typeof key.parameter).toBe('string');
    expect(Number.isSafeInteger(Number(key.parameter))).toBe(false);
  });

  it('documents the deterministic hash algorithm and collision semantics', () => {
    expect(PRODUCT_LOCK_KEY_DERIVATION_CONTRACT).toEqual({
      algorithm: 'sha256(productId UTF-8) first 8 bytes interpreted as signed 64-bit big-endian',
      collisionBehavior:
        'A 64-bit hash collision serializes unrelated products but does not corrupt data because advisory locks only add ordering.',
    });
  });

  it('treats hash collisions as reduced concurrency, not a correctness violation', () => {
    const collisionSemantics = PRODUCT_LOCK_KEY_DERIVATION_CONTRACT.collisionBehavior;

    expect(collisionSemantics).toContain('serializes unrelated products');
    expect(collisionSemantics).toContain('does not corrupt data');
  });
});
