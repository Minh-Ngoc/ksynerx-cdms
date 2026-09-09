import { ChangeSource, ProductChangeInput } from '../changes/product-change-contract.js';
import {
  normalizeCanonicalProductPayload,
  ProductCanonicalizationError,
} from '../changes/product-canonicalization.js';

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
  row: ExcelProductRowRepresentation,
): ProductChangeInput {
  if (typeof row.productId !== 'string' || row.productId.trim().length === 0) {
    throw new ProductCanonicalizationError('productId must not be empty');
  }

  if (!Number.isInteger(row.version) || row.version < 1) {
    throw new ProductCanonicalizationError('version must be a positive integer');
  }

  if (Number.isNaN(row.observedAt.getTime())) {
    throw new ProductCanonicalizationError('observedAt must be a valid timestamp');
  }

  return {
    productId: row.productId.trim(),
    version: row.version,
    source: ChangeSource.Excel,
    payload: normalizeCanonicalProductPayload({
      ...row,
      // Excel numeric cells have already passed through the parser's number representation.
      // Converting to text without rounding lets the shared decimal validator reject unsafe
      // values instead of hiding precision loss behind a formatted two-decimal string.
      price: typeof row.price === 'number' ? String(row.price) : row.price,
    }),
    observedAt: row.observedAt,
  };
}
