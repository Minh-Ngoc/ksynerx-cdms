import { InventoryWebhookDto } from './dto/webhook-contracts.js';
import { ChangeSource, ProductChangeInput } from '../changes/product-change-contract.js';

export function normalizeWebhookProductChange(
  _dto: InventoryWebhookDto,
): ProductChangeInput {
  void ChangeSource.Webhook;
  throw new Error('Task 7 must implement webhook product normalization');
}
