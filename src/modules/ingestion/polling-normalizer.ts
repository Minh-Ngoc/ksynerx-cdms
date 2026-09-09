import { ChangeSource, ProductChangeInput } from '../changes/product-change-contract.js';
import {
  normalizeCanonicalProductPayload,
  ProductCanonicalizationError,
} from '../changes/product-canonicalization.js';

export interface PollingProductRepresentation {
  id: string;
  version: number;
  sku: string;
  name: string;
  price: string;
  quantity: number;
  updatedAt: string;
}

export function normalizePollingProductChange(
  product: PollingProductRepresentation,
): ProductChangeInput {
  if (typeof product.id !== 'string' || product.id.trim().length === 0) {
    throw new ProductCanonicalizationError('productId must not be empty');
  }

  if (!Number.isInteger(product.version) || product.version < 1) {
    throw new ProductCanonicalizationError('version must be a positive integer');
  }

  const observedAt = new Date(product.updatedAt);
  if (Number.isNaN(observedAt.getTime())) {
    throw new ProductCanonicalizationError('updatedAt must be a valid timestamp');
  }

  return {
    productId: product.id.trim(),
    version: product.version,
    source: ChangeSource.Polling,
    payload: normalizeCanonicalProductPayload(product),
    observedAt,
  };
}
