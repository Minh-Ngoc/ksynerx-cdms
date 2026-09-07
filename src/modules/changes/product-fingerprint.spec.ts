import {
  fingerprintCanonicalProductPayload,
  normalizeCanonicalProductPayload,
  ProductCanonicalizationError,
  serializeCanonicalProductPayload,
} from './product-canonicalization.js';
import { CanonicalProductPayload } from './product-change-contract.js';

describe('canonical product payload normalization and fingerprinting', () => {
  it.each([
    ['0', '0.00'],
    ['0.1', '0.10'],
    ['1', '1.00'],
    ['1.2', '1.20'],
    ['1.20', '1.20'],
    ['100', '100.00'],
    ['100.0', '100.00'],
    ['100.00', '100.00'],
    ['9999999999999999.99', '9999999999999999.99'],
  ])('canonicalizes decimal price %s to %s without floating-point conversion', (price, expected) => {
    expect(
      normalizeCanonicalProductPayload({
        sku: 'SKU-001',
        name: 'Product',
        price,
        quantity: 3,
      }),
    ).toMatchObject({ price: expected });
  });

  it('preserves decimal identity that would be unsafe through JavaScript Number', () => {
    expect(
      normalizeCanonicalProductPayload({
        sku: 'SKU-001',
        name: 'Product',
        price: '9999999999999999.99',
        quantity: 3,
      }),
    ).toMatchObject({ price: '9999999999999999.99' });
  });

  it('trims surrounding sku/name whitespace while preserving internal spaces and case', () => {
    expect(
      normalizeCanonicalProductPayload({
        sku: '  SKU-AbC-001  ',
        name: '  Product  Name  ',
        price: '100',
        quantity: 3,
      }),
    ).toEqual({
      sku: 'SKU-AbC-001',
      name: 'Product  Name',
      price: '100.00',
      quantity: 3,
    });
  });

  it('keeps quantity as an integer and rejects float coercion', () => {
    expect(
      normalizeCanonicalProductPayload({
        sku: 'SKU-001',
        name: 'Product',
        price: '100',
        quantity: 3,
      }),
    ).toMatchObject({ quantity: 3 });

    expect(() =>
      normalizeCanonicalProductPayload({
        sku: 'SKU-001',
        name: 'Product',
        price: '100',
        quantity: 3.7,
      }),
    ).toThrow(ProductCanonicalizationError);
  });

  it('serializes canonical payload fields in deterministic SPEC order', () => {
    const payload: CanonicalProductPayload = {
      name: 'Product  Name',
      quantity: 3,
      price: '100.00',
      sku: 'SKU-001',
    } as CanonicalProductPayload;

    expect(serializeCanonicalProductPayload(payload)).toBe(
      '{"sku":"SKU-001","name":"Product  Name","price":"100.00","quantity":3}',
    );
  });

  it('produces the documented SHA-256 fixture from the exact canonical string', () => {
    const payload: CanonicalProductPayload = {
      sku: 'SKU-001',
      name: 'Product  Name',
      price: '100.00',
      quantity: 3,
    };

    expect(serializeCanonicalProductPayload(payload)).toBe(
      '{"sku":"SKU-001","name":"Product  Name","price":"100.00","quantity":3}',
    );
    expect(fingerprintCanonicalProductPayload(payload)).toBe(
      '12d13ce54de233c70fbf0e3fb2ce8ed034ec64408f84b2f913ec42bf43aba3f4',
    );
  });

  it('fingerprints equal canonical product state identically regardless of insertion order', () => {
    const first = normalizeCanonicalProductPayload({
      sku: 'SKU-001',
      name: 'Product',
      price: '100',
      quantity: 3,
    });
    const second = normalizeCanonicalProductPayload({
      quantity: 3,
      price: '100.00',
      name: 'Product',
      sku: 'SKU-001',
    });

    expect(first).toEqual(second);
    expect(fingerprintCanonicalProductPayload(first)).toBe(
      fingerprintCanonicalProductPayload(second),
    );
  });

  it.each([
    [{ sku: 'SKU-002', name: 'Product', price: '100.00', quantity: 3 }],
    [{ sku: 'SKU-001', name: 'Other Product', price: '100.00', quantity: 3 }],
    [{ sku: 'SKU-001', name: 'Product', price: '100.01', quantity: 3 }],
    [{ sku: 'SKU-001', name: 'Product', price: '100.00', quantity: 4 }],
  ] satisfies [CanonicalProductPayload][])(
    'changes fingerprint when canonical state changes: %p',
    (changedPayload) => {
      const base: CanonicalProductPayload = {
        sku: 'SKU-001',
        name: 'Product',
        price: '100.00',
        quantity: 3,
      };

      expect(fingerprintCanonicalProductPayload(changedPayload)).not.toBe(
        fingerprintCanonicalProductPayload(base),
      );
    },
  );

  it('does not treat fingerprint as global identity across product/version metadata', () => {
    const sameState: CanonicalProductPayload = {
      sku: 'SKU-001',
      name: 'Product',
      price: '100.00',
      quantity: 3,
    };

    const productA = {
      productId: 'product-a',
      version: 1,
      fingerprint: fingerprintCanonicalProductPayload(sameState),
    };
    const productB = {
      productId: 'product-b',
      version: 8,
      fingerprint: fingerprintCanonicalProductPayload(sameState),
    };

    expect(productA.fingerprint).toBe(productB.fingerprint);
    expect(productA.productId).not.toBe(productB.productId);
    expect(productA.version).not.toBe(productB.version);
  });
});
