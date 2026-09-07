import { CanonicalProductPayload } from './product-change-contract.js';

export class ProductCanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductCanonicalizationError';
  }
}

export type ProductPayloadInput = {
  sku: unknown;
  name: unknown;
  price: unknown;
  quantity: unknown;
};

export function normalizeCanonicalProductPayload(
  _input: ProductPayloadInput,
): CanonicalProductPayload {
  throw new ProductCanonicalizationError('Task 7 must implement canonical product payload normalization');
}

export function serializeCanonicalProductPayload(_payload: CanonicalProductPayload): string {
  throw new ProductCanonicalizationError('Task 7 must implement deterministic product payload serialization');
}

export function fingerprintCanonicalProductPayload(_payload: CanonicalProductPayload): string {
  throw new ProductCanonicalizationError('Task 7 must implement SHA-256 product payload fingerprinting');
}
