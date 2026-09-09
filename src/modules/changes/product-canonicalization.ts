import { createHash } from 'node:crypto';

import { CanonicalProductPayload } from './product-change-contract.js';

const DECIMAL_18_2_PATTERN = /^(?<whole>0|[1-9]\d{0,15})(?:\.(?<fraction>\d{1,2}))?$/;
const CANONICAL_PAYLOAD_KEYS = ['sku', 'name', 'price', 'quantity'] as const;

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

function normalizeRequiredString(value: unknown, fieldName: 'sku' | 'name'): string {
  if (typeof value !== 'string') {
    throw new ProductCanonicalizationError(`${fieldName} must be a string`);
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ProductCanonicalizationError(`${fieldName} must not be empty`);
  }

  return normalized;
}

function normalizePrice(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProductCanonicalizationError('price must be a decimal string');
  }

  const match = DECIMAL_18_2_PATTERN.exec(value.trim());
  if (match === null) {
    throw new ProductCanonicalizationError('price must be compatible with NUMERIC(18,2)');
  }

  const whole = match.groups?.whole;
  const fraction = match.groups?.fraction ?? '';

  if (whole === undefined) {
    throw new ProductCanonicalizationError('price must include a whole-number component');
  }

  // Price is normalized as text so values used for fingerprinting never pass through
  // JavaScript binary floating point. This preserves large NUMERIC(18,2) values exactly
  // and keeps equivalent source representations deterministic.
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function normalizeQuantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProductCanonicalizationError('quantity must be an integer');
  }

  return value;
}

export function normalizeCanonicalProductPayload(
  input: ProductPayloadInput,
): CanonicalProductPayload {
  return {
    sku: normalizeRequiredString(input.sku, 'sku'),
    name: normalizeRequiredString(input.name, 'name'),
    price: normalizePrice(input.price),
    quantity: normalizeQuantity(input.quantity),
  };
}

export function serializeCanonicalProductPayload(payload: CanonicalProductPayload): string {
  // Fingerprints must be independent of caller object insertion order. The SPEC payload is
  // flat, so explicit key order is clearer than a generic canonical JSON framework here.
  return `{${CANONICAL_PAYLOAD_KEYS.map((key) => `${JSON.stringify(key)}:${JSON.stringify(payload[key])}`).join(',')}}`;
}

export function fingerprintCanonicalProductPayload(payload: CanonicalProductPayload): string {
  // Only canonical product state enters the hash. Delivery metadata such as productId,
  // version, source, and observedAt is handled by later processing rules, so including it
  // would create false conflicts for identical product states delivered through different paths.
  return createHash('sha256').update(serializeCanonicalProductPayload(payload)).digest('hex');
}
