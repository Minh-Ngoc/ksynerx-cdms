import { InventoryWebhookDto } from './dto/webhook-contracts.js';
import { ChangeSource, ProductChangeInput } from '../changes/product-change-contract.js';
import {
  normalizeCanonicalProductPayload,
  ProductCanonicalizationError,
} from '../changes/product-canonicalization.js';

export function normalizeWebhookProductChange(
  dto: InventoryWebhookDto,
): ProductChangeInput {
  if (typeof dto.productId !== 'string' || dto.productId.trim().length === 0) {
    throw new ProductCanonicalizationError('productId must not be empty');
  }

  if (!Number.isInteger(dto.version) || dto.version < 1) {
    throw new ProductCanonicalizationError('version must be a positive integer');
  }

  const observedAt =
    dto.observedAt === undefined ? new Date(0) : new Date(dto.observedAt);
  if (Number.isNaN(observedAt.getTime())) {
    throw new ProductCanonicalizationError('observedAt must be a valid timestamp');
  }

  return {
    productId: dto.productId.trim(),
    version: dto.version,
    source: ChangeSource.Webhook,
    payload: normalizeCanonicalProductPayload(dto.payload),
    observedAt,
  };
}
