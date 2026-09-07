import { ChangeSource, ProductChangeInput } from '../changes/product-change-contract.js';

export interface ExcelProductRowRepresentation {
  productId: string;
  version: number;
  sku: string;
  name: string;
  price: string | number;
  quantity: number;
  observedAt: Date;
}

export function normalizeExcelProductChange(
  _row: ExcelProductRowRepresentation,
): ProductChangeInput {
  void ChangeSource.Excel;
  throw new Error('Task 7 must implement Excel row product normalization');
}
