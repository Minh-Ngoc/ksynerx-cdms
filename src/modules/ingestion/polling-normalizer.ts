import { ChangeSource, ProductChangeInput } from '../changes/product-change-contract.js';

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
  _product: PollingProductRepresentation,
): ProductChangeInput {
  void ChangeSource.Polling;
  throw new Error('Task 7 must implement polling product normalization');
}
