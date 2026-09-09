import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, TransformCallback, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Logger } from '@nestjs/common';

import { ProductCanonicalizationError } from '../changes/product-canonicalization.js';
import { normalizeExcelProductChange } from './excel-row-normalizer.js';
import {
  ImportBatch,
  ImportBatchQueue,
  ImportEnqueueRetryTimeoutError,
  ImportIngestionLifecyclePort,
  ImportIngestionProgressPort,
  ImportProducerResult,
  ImportStreamingOptions,
  ImportUploadTooLargeError,
  ImportWorkbookParseError,
  REQUIRED_IMPORT_HEADERS,
} from './import-streaming.contract.js';
import { InternalXlsxStreamingReader, XlsxRow } from './internal-xlsx-streaming-reader.js';

export interface ImportStreamingDependencies {
  workbookReader: Pick<InternalXlsxStreamingReader, 'open'>;
  batchQueue: ImportBatchQueue;
  progress: ImportIngestionProgressPort;
  lifecycle: ImportIngestionLifecyclePort;
  retry?: { now(): number; sleep(milliseconds: number): Promise<void> };
  // Tests may isolate generated staging directories; production deliberately uses the OS temp root.
  stagingDirectory?: string;
}

export class ImportStreamingService {
  private readonly logger = new Logger(ImportStreamingService.name);

  constructor(
    private readonly dependencies: ImportStreamingDependencies,
    private readonly options: ImportStreamingOptions,
  ) {}

  async processUploadStream(file: NodeJS.ReadableStream & { destroy(error?: Error): void }, importId: string): Promise<ImportProducerResult> {
    let directory: string | undefined;
    try {
      // The generated directory is server-owned, so client filename components cannot select a
      // filesystem location or collide with another import. Disk staging preserves streaming input.
      directory = await mkdtemp(join(this.dependencies.stagingDirectory ?? tmpdir(), 'cdms-import-'));
      const filename = join(directory, 'workbook.xlsx');
      await pipeline(file, new UploadByteLimitTransform(this.options.maxFileSizeBytes, file), createWriteStream(filename));
      await this.processStagedWorkbook(filename, importId);
      const enqueueCompletedAt = new Date();
      // This is producer completion only. Task 20 owns the later terminal row processing outcome.
      await this.dependencies.lifecycle.markEnqueueCompleted(importId, enqueueCompletedAt);
      return { status: 'PROCESSING', enqueueCompletedAt };
    } catch (error) {
      await this.dependencies.lifecycle.markIngestionFailed(importId, sanitizeImportFailure(error));
      throw normalizeImportFailure(error);
    } finally {
      if (directory !== undefined) {
        try {
          await rm(directory, { force: true, recursive: true });
        } catch (error) {
          // Cleanup must remain observable without hiding the primary import outcome.
          this.logger.error('Could not remove temporary import staging directory', error);
        }
      }
    }
  }

  private async processStagedWorkbook(filename: string, importId: string): Promise<void> {
    const rows = this.dependencies.workbookReader.open(filename);
    await pipeline(
      rows,
      new ImportRowTransform(importId, this.dependencies.progress),
      new ImportBatchTransform(importId, this.options.batchSize),
      // One unresolved Writable write is intentionally stricter than the configured pending-batch
      // upper bound. It trades enqueue throughput for a simple, end-to-end pressure chain with no
      // promise queue that could let a large workbook run ahead while Redis is unavailable.
      new ImportBatchWritable(this.dependencies.batchQueue, this.options.redisRetryTimeoutMs, this.dependencies.retry),
    );
  }
}

class ImportRowTransform extends Transform {
  private sawHeader = false;

  constructor(private readonly importId: string, private readonly progress: ImportIngestionProgressPort) {
    super({ objectMode: true, readableHighWaterMark: 1, writableHighWaterMark: 1 });
  }

  override _transform(row: XlsxRow, _encoding: BufferEncoding, callback: TransformCallback): void {
    void this.mapRow(row).then((value) => callback(null, value), (error: unknown) => callback(error as Error));
  }

  private async mapRow(row: XlsxRow): Promise<ImportBatch['rows'][number] | undefined> {
    if (!this.sawHeader) {
      this.sawHeader = true;
      assertHeaders(row.cells);
      return undefined;
    }
    try {
      const change = normalizeExcelProductChange({
        productId: cell(row, 0), version: Number(cell(row, 1)), sku: cell(row, 2), name: cell(row, 3),
        price: cell(row, 4), quantity: Number(cell(row, 5)), observedAt: new Date(cell(row, 6)),
      });
      await this.progress.recordReadableRow(this.importId);
      return { rowNumber: row.rowNumber, change };
    } catch (error) {
      if (!(error instanceof ProductCanonicalizationError) && !(error instanceof ImportWorkbookParseError)) throw error;
      // The repository increments read/processed/failed together, preserving durable counter checks.
      await this.progress.recordMalformedRow({ importId: this.importId, rowNumber: row.rowNumber, error: error.message });
      return undefined;
    }
  }

  override _flush(callback: TransformCallback): void {
    callback(this.sawHeader ? undefined : new ImportWorkbookParseError('Workbook has no header row'));
  }
}

class ImportBatchTransform extends Transform {
  private rows: Array<ImportBatch['rows'][number]> = [];
  private nextBatchIndex = 0;

  constructor(private readonly importId: string, private readonly batchSize: number) {
    super({ objectMode: true, readableHighWaterMark: 1, writableHighWaterMark: 1 });
  }

  override _transform(row: ImportBatch['rows'][number] | undefined, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (row === undefined) return callback();
    this.rows.push(row);
    callback(null, this.rows.length === this.batchSize ? this.takeBatch() : undefined);
  }

  override _flush(callback: TransformCallback): void {
    callback(undefined, this.rows.length === 0 ? undefined : this.takeBatch());
  }

  private takeBatch(): ImportBatch {
    // The batch ID is assigned before queue.add and remains part of retry payloads. It is the
    // durable progress-accounting identity, not a substitute for BullMQ's generated job ID.
    const batch = { importId: this.importId, batchId: `${this.importId}:${this.nextBatchIndex++}`, rows: this.rows };
    this.rows = [];
    return batch;
  }
}

class ImportBatchWritable extends Writable {
  constructor(
    private readonly queue: ImportBatchQueue,
    private readonly timeoutMs: number,
    private readonly retry = defaultRetrySupport,
  ) {
    super({ objectMode: true, highWaterMark: 1 });
  }

  override _write(batch: ImportBatch, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void this.enqueue(batch).then(() => callback(), (error: unknown) => callback(error as Error));
  }

  private async enqueue(batch: ImportBatch): Promise<void> {
    const startedAt = this.retry.now();
    while (true) {
      try {
        await this.queue.enqueueImportBatch(batch);
        return;
      } catch {
        const elapsed = this.retry.now() - startedAt;
        if (elapsed >= this.timeoutMs) throw new ImportEnqueueRetryTimeoutError('Import queue did not recover before the retry timeout');
        // Keeping _write unresolved stops the stream pipeline instead of reading/discarding rows.
        await this.retry.sleep(Math.min(100, this.timeoutMs - elapsed));
      }
    }
  }
}

class UploadByteLimitTransform extends Transform {
  private bytesRead = 0;

  constructor(private readonly maximumBytes: number, private readonly source: NodeJS.ReadableStream & { destroy(error?: Error): void }) { super(); }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytesRead += chunk.length;
    if (this.bytesRead > this.maximumBytes) {
      const error = new ImportUploadTooLargeError('Upload exceeds the configured size limit');
      this.source.destroy(error);
      callback(error);
      return;
    }
    callback(null, chunk);
  }
}

function assertHeaders(cells: readonly (string | undefined)[]): void {
  const valid = cells.length === REQUIRED_IMPORT_HEADERS.length && REQUIRED_IMPORT_HEADERS.every((header, index) => cells[index]?.trim() === header);
  if (!valid) throw new ImportWorkbookParseError('Workbook header does not match the required product import schema');
}

function cell(row: XlsxRow, index: number): string {
  const value = row.cells[index];
  if (value === undefined) throw new ProductCanonicalizationError('Required product workbook cell is missing');
  return value;
}

const defaultRetrySupport = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

function normalizeImportFailure(error: unknown): Error {
  if (error instanceof ImportUploadTooLargeError || error instanceof ImportWorkbookParseError || error instanceof ImportEnqueueRetryTimeoutError) return error;
  return new ImportWorkbookParseError('Import ingestion could not complete');
}

function sanitizeImportFailure(error: unknown): string {
  if (error instanceof ImportUploadTooLargeError) return 'Upload exceeds the configured size limit';
  if (error instanceof ImportEnqueueRetryTimeoutError) return 'Import queue did not recover before the retry timeout';
  if (error instanceof ImportWorkbookParseError) return error.message;
  return 'Import ingestion could not complete';
}
