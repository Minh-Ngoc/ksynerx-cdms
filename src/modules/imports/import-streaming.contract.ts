import { ProductChangeInput } from '../changes/product-change-contract.js';

export const REQUIRED_IMPORT_HEADERS = [
  'productId',
  'version',
  'sku',
  'name',
  'price',
  'quantity',
  'observedAt',
] as const;

export interface ImportBatch {
  importId: string;
  batchId: string;
  rows: readonly ImportBatchRow[];
}

export interface ImportBatchRow {
  rowNumber: number;
  change: ProductChangeInput;
}

export interface ImportBatchQueue {
  enqueueImportBatch(batch: ImportBatch): Promise<void>;
}

export interface ImportIngestionProgressPort {
  recordReadableRow(importId: string): Promise<void>;
  recordMalformedRow(input: {
    importId: string;
    rowNumber: number;
    error: string;
  }): Promise<void>;
}

export interface ImportIngestionLifecyclePort {
  markEnqueueCompleted(importId: string, completedAt: Date): Promise<void>;
  markIngestionFailed(importId: string, error: string): Promise<void>;
}

export interface ImportStreamingOptions {
  batchSize: number;
  maxPendingBatches: number;
  maxFileSizeBytes: number;
  redisRetryTimeoutMs: number;
}

export interface ImportProducerResult {
  status: 'PROCESSING';
  enqueueCompletedAt: Date;
}

export class ImportUploadTooLargeError extends Error {}

export class ImportWorkbookParseError extends Error {}

export class ImportEnqueueRetryTimeoutError extends Error {}
