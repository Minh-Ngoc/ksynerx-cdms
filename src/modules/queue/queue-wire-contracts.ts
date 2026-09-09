import { CanonicalProductPayload, ChangeSource, ProductChangeInput } from '../changes/product-change-contract.js';
import { ImportBatch } from '../imports/import-streaming.contract.js';

export interface ChangeJobData {
  productId: string;
  version: number;
  source: ChangeSource;
  payload: CanonicalProductPayload;
  observedAt: string;
}

export function serializeChangeJobData(input: ProductChangeInput): ChangeJobData {
  return {
    productId: input.productId,
    version: input.version,
    source: input.source,
    payload: input.payload,
    observedAt: input.observedAt.toISOString(),
  };
}

export function deserializeChangeJobData(data: ChangeJobData): ProductChangeInput {
  return {
    productId: data.productId,
    version: data.version,
    source: data.source,
    payload: data.payload,
    observedAt: new Date(data.observedAt),
  };
}

export interface ImportBatchJobData {
  importId: string;
  batchId: string;
  rows: Array<{ rowNumber: number; change: ChangeJobData }>;
}

export function serializeImportBatchJobData(batch: ImportBatch): ImportBatchJobData {
  return {
    importId: batch.importId,
    batchId: batch.batchId,
    rows: batch.rows.map((row) => ({
      rowNumber: row.rowNumber,
      change: serializeChangeJobData(row.change),
    })),
  };
}
