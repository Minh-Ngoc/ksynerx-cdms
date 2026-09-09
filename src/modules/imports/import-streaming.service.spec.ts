import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  ImportBatch,
  ImportBatchQueue,
  ImportEnqueueRetryTimeoutError,
  ImportIngestionLifecyclePort,
  ImportIngestionProgressPort,
  ImportUploadTooLargeError,
  ImportWorkbookParseError,
  ImportStreamingOptions,
  REQUIRED_IMPORT_HEADERS,
} from './import-streaming.contract.js';
import { ImportStreamingService } from './import-streaming.service.js';
import { ExcelProductRowRepresentation, normalizeExcelProductChange } from './excel-row-normalizer.js';
import { InternalXlsxStreamingReader, XlsxRow } from './internal-xlsx-streaming-reader.js';

interface StreamingWorkbook {
  headers: readonly string[];
  rows: AsyncIterable<ExcelProductRowRepresentation>;
}

const OPTIONS: ImportStreamingOptions = {
  batchSize: 2,
  maxPendingBatches: 2,
  maxFileSizeBytes: 1024,
  redisRetryTimeoutMs: 10,
};

class Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;

  constructor() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    this.promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.resolve = resolve;
    this.reject = reject;
  }
}

class StaticWorkbookReader implements Pick<InternalXlsxStreamingReader, 'open'> {
  constructor(private readonly workbook: StreamingWorkbook) {}

  open(_filename: string): Readable {
    return Readable.from(this.rawRows(), { objectMode: true });
  }

  private async *rawRows(): AsyncIterable<XlsxRow> {
    yield { rowNumber: 1, cells: [...this.workbook.headers] };
    let rowNumber = 1;
    for await (const row of this.workbook.rows) {
      rowNumber += 1;
      yield { rowNumber, cells: [row.productId, String(row.version), row.sku, row.name, String(row.price), String(row.quantity), row.observedAt.toISOString()] };
    }
  }
}

class StagedWorkbookReader extends StaticWorkbookReader {
  readonly openedFilenames: string[] = [];

  override open(filename: string): Readable {
    // The service invokes this only after Phase A's write pipeline resolves. The fixture preserves
    // the parser-EOF gate without exposing a direct HTTP-stream parser path.
    expect(existsSync(filename)).toBe(true);
    expect(readFileSync(filename, 'utf8')).toBe('xlsx-bytes');
    this.openedFilenames.push(filename);
    return super.open(filename);
  }
}

class RecordingBatchQueue implements ImportBatchQueue {
  readonly batches: ImportBatch[] = [];
  readonly pending: Deferred<void>[] = [];
  autoResolve = false;
  failuresRemaining = 0;

  async enqueueImportBatch(batch: ImportBatch): Promise<void> {
    this.batches.push(batch);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('Redis unavailable');
    }

    if (this.autoResolve) {
      return;
    }

    const pending = new Deferred<void>();
    this.pending.push(pending);
    return pending.promise;
  }
}

class RecordingProgress implements ImportIngestionProgressPort {
  readonly readableRows: string[] = [];
  readonly malformedRows: Array<{ importId: string; rowNumber: number; error: string }> = [];

  async recordReadableRow(importId: string): Promise<void> {
    this.readableRows.push(importId);
  }

  async recordMalformedRow(input: {
    importId: string;
    rowNumber: number;
    error: string;
  }): Promise<void> {
    this.malformedRows.push(input);
  }
}

class RecordingLifecycle implements ImportIngestionLifecyclePort {
  readonly completed: Array<{ importId: string; completedAt: Date }> = [];
  readonly failures: Array<{ importId: string; error: string }> = [];

  async markEnqueueCompleted(importId: string, completedAt: Date): Promise<void> {
    this.completed.push({ importId, completedAt });
  }

  async markIngestionFailed(importId: string, error: string): Promise<void> {
    this.failures.push({ importId, error });
  }
}

function row(index: number, price: string | number = '10.00'): ExcelProductRowRepresentation {
  return {
    productId: `product-${index}`,
    version: 1,
    sku: `SKU-${index}`,
    name: `Product ${index}`,
    price,
    quantity: index,
    observedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function queuedRow(index: number, price: string | number = '10.00') {
  return {
    rowNumber: index + 1,
    change: normalizeExcelProductChange(row(index, price)),
  };
}

async function* rows(values: readonly ExcelProductRowRepresentation[]): AsyncIterable<ExcelProductRowRepresentation> {
  for (const value of values) {
    yield value;
  }
}

async function* rowsBlockedBeforeEof(
  initialRows: readonly ExcelProductRowRepresentation[],
  eofGate: Promise<void>,
  remainingRows: readonly ExcelProductRowRepresentation[],
): AsyncIterable<ExcelProductRowRepresentation> {
  yield* rows(initialRows);
  await eofGate;
  yield* rows(remainingRows);
}

function createService(
  workbook: StreamingWorkbook,
  queue = new RecordingBatchQueue(),
  options = OPTIONS,
  workbookReader: Pick<InternalXlsxStreamingReader, 'open'> = new StaticWorkbookReader(workbook),
  stagingDirectory?: string,
) {
  const progress = new RecordingProgress();
  const lifecycle = new RecordingLifecycle();
  const service = new ImportStreamingService(
    {
      workbookReader,
      batchQueue: queue,
      progress,
      lifecycle,
      retry: createImmediateRetrySupport(),
      stagingDirectory,
    },
    options,
  );

  return { service, queue, progress, lifecycle };
}

function createImmediateRetrySupport() {
  let now = 0;

  return {
    now: () => now,
    sleep: async () => {
      now += OPTIONS.redisRetryTimeoutMs;
    },
  };
}

function upload(chunks: readonly string[] = ['xlsx-bytes']): Readable {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 200; attempts += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the stream pipeline');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('ImportStreamingService contract for Task 19', () => {
  it('starts parsing only after upload staging, then enqueues a full batch before parser EOF', async () => {
    const eof = new Deferred<void>();
    const queue = new RecordingBatchQueue();
    queue.autoResolve = true;
    const workbook: StreamingWorkbook = {
      headers: REQUIRED_IMPORT_HEADERS,
      rows: rowsBlockedBeforeEof([row(1), row(2)], eof.promise, [row(3), row(4), row(5)]),
    };
    const { service } = createService(
      workbook,
      queue,
      OPTIONS,
      new StagedWorkbookReader(workbook),
    );

    const processing = service.processUploadStream(upload(), 'import-1');
    void processing.catch(() => undefined);

    // After Phase A ends, a path-based parser must enqueue a full batch while later worksheet rows
    // remain unread. This replaces the invalid direct-HTTP-stream assertion without permitting an
    // all-row collection before enqueue.
    await waitUntil(() => queue.batches.length === 1);
    expect(queue.batches).toEqual([{ importId: 'import-1', batchId: 'import-1:0', rows: [queuedRow(1), queuedRow(2)] }]);
    eof.resolve();
    await expect(processing).resolves.toMatchObject({ status: 'PROCESSING' });
    expect(queue.batches.map((batch) => batch.rows)).toEqual([
      [queuedRow(1), queuedRow(2)],
      [queuedRow(3), queuedRow(4)],
      [queuedRow(5)],
    ]);
    expect(queue.batches.map((batch) => batch.batchId)).toEqual(['import-1:0', 'import-1:1', 'import-1:2']);
    expect(queue.batches.every((batch) => batch.rows.length <= 2)).toBe(true);
  });

  it('uses a generated staging path and removes it after producer success', async () => {
    const stagingDirectory = await mkdtemp(join(tmpdir(), 'cdms-import-stage-test-'));
    const workbook = { headers: REQUIRED_IMPORT_HEADERS, rows: rows([row(1)]) };
    const reader = new StagedWorkbookReader(workbook);
    const queue = new RecordingBatchQueue();
    queue.autoResolve = true;
    const { service } = createService(workbook, queue, OPTIONS, reader, stagingDirectory);

    try {
      await expect(service.processUploadStream(upload(), 'import-staged')).resolves.toMatchObject({ status: 'PROCESSING' });
      expect(reader.openedFilenames).toHaveLength(1);
      expect(reader.openedFilenames[0]).toMatch(new RegExp(`^${escapeRegExp(stagingDirectory)}/cdms-import-[^/]+/workbook\\.xlsx$`));
      await expect(readdir(stagingDirectory)).resolves.toEqual([]);
    } finally {
      await rm(stagingDirectory, { force: true, recursive: true });
    }
  });

  it('keeps one queue batch in flight so the pipeline backpressures before producing another batch', async () => {
    const { service, queue } = createService({ headers: REQUIRED_IMPORT_HEADERS, rows: rows([row(1), row(2), row(3), row(4), row(5), row(6)]) });
    const processing = service.processUploadStream(upload(), 'import-2');
    void processing.catch(() => undefined);

    await waitUntil(() => queue.batches.length === 1 && queue.pending.length === 1);
    expect(queue.batches).toHaveLength(1);
    expect(queue.pending).toHaveLength(1);

    queue.pending[0]!.resolve();
    await waitUntil(() => queue.batches.length === 2);
    expect(queue.batches).toHaveLength(2);

    queue.pending.slice(1).forEach((pending) => pending.resolve());
    await waitUntil(() => queue.batches.length === 3);
    expect(queue.batches).toHaveLength(3);
    queue.pending[2]!.resolve();
    await expect(processing).resolves.toMatchObject({ status: 'PROCESSING' });
  });

  it('stops the upload stream at the byte limit instead of buffering or discarding later bytes', async () => {
    const { service, lifecycle } = createService(
      { headers: REQUIRED_IMPORT_HEADERS, rows: rows([row(1)]) },
      undefined,
      { ...OPTIONS, maxFileSizeBytes: 4 },
    );
    const file = upload(['1234', '5', 'unread-after-limit']);

    await expect(service.processUploadStream(file, 'import-3')).rejects.toBeInstanceOf(ImportUploadTooLargeError);
    expect(file.destroyed).toBe(true);
    expect(lifecycle.completed).toHaveLength(0);
    expect(lifecycle.failures).toHaveLength(1);
  });

  it('removes the staged file after an upload-limit failure', async () => {
    const stagingDirectory = await mkdtemp(join(tmpdir(), 'cdms-import-stage-test-'));
    const { service } = createService(
      { headers: REQUIRED_IMPORT_HEADERS, rows: rows([row(1)]) },
      undefined,
      { ...OPTIONS, maxFileSizeBytes: 4 },
      undefined,
      stagingDirectory,
    );

    try {
      await expect(service.processUploadStream(upload(['12345']), 'import-cleanup-failure')).rejects.toBeInstanceOf(ImportUploadTooLargeError);
      await expect(readdir(stagingDirectory)).resolves.toEqual([]);
    } finally {
      await rm(stagingDirectory, { force: true, recursive: true });
    }
  });

  it('retries a failed batch and continues only after Redis accepts it before the timeout', async () => {
    const queue = new RecordingBatchQueue();
    queue.failuresRemaining = 1;
    const { service, lifecycle } = createService(
      { headers: REQUIRED_IMPORT_HEADERS, rows: rows([row(1), row(2)]) },
      queue,
    );

    const processing = service.processUploadStream(upload(), 'import-4');
    void processing.catch(() => undefined);

    await waitUntil(() => queue.batches.length === 2 && queue.pending.length === 1);
    expect(queue.batches).toHaveLength(2);
    queue.pending[0]!.resolve();
    await expect(processing).resolves.toMatchObject({ status: 'PROCESSING' });
    expect(lifecycle.failures).toHaveLength(0);
  });

  it('terminates ingestion after the bounded Redis retry timeout and does not report producer success', async () => {
    const queue = new RecordingBatchQueue();
    queue.failuresRemaining = Number.POSITIVE_INFINITY;
    const { service, lifecycle } = createService(
      { headers: REQUIRED_IMPORT_HEADERS, rows: rows([row(1), row(2)]) },
      queue,
    );

    await expect(service.processUploadStream(upload(), 'import-5')).rejects.toBeInstanceOf(
      ImportEnqueueRetryTimeoutError,
    );
    expect(lifecycle.completed).toHaveLength(0);
    expect(lifecycle.failures).toHaveLength(1);
  });

  it('records malformed readable rows as row-level failures and continues valid rows', async () => {
    const queue = new RecordingBatchQueue();
    queue.autoResolve = true;
    const { service, progress, lifecycle } = createService(
      {
        headers: REQUIRED_IMPORT_HEADERS,
        rows: rows([row(1), { ...row(2), version: 0 }, row(3)]),
      },
      queue,
    );

    const processing = service.processUploadStream(upload(), 'import-6');
    void processing.catch(() => undefined);

    await expect(processing).resolves.toMatchObject({ status: 'PROCESSING' });
    expect(progress.readableRows).toHaveLength(2);
    expect(progress.malformedRows).toHaveLength(1);
    expect(queue.batches).toEqual([{ importId: 'import-6', batchId: 'import-6:0', rows: [queuedRow(1), queuedRow(3)] }]);
    expect(lifecycle.failures).toHaveLength(0);
  });

  it('rejects unsafe binary Excel decimal values as malformed rows rather than rounding them', async () => {
    const { service, progress, lifecycle } = createService({
      headers: REQUIRED_IMPORT_HEADERS,
      rows: rows([row(1, 100.005)]),
    });

    await expect(service.processUploadStream(upload(), 'import-7')).resolves.toMatchObject({ status: 'PROCESSING' });
    expect(progress.malformedRows).toHaveLength(1);
    expect(lifecycle.failures).toHaveLength(0);
  });

  it('treats a missing required header as a file-level failure with no enqueue completion signal', async () => {
    const { service, lifecycle } = createService({
      headers: REQUIRED_IMPORT_HEADERS.filter((header) => header !== 'quantity'),
      rows: rows([row(1)]),
    });

    await expect(service.processUploadStream(upload(), 'import-8')).rejects.toBeInstanceOf(ImportWorkbookParseError);
    expect(lifecycle.completed).toHaveLength(0);
    expect(lifecycle.failures).toHaveLength(1);
  });

  it('treats a corrupt streaming workbook as a file-level failure instead of a malformed row', async () => {
    const corruptReader: Pick<InternalXlsxStreamingReader, 'open'> = {
      open(): Readable {
        return new Readable({
          objectMode: true,
          read() {
            this.destroy(new ImportWorkbookParseError('invalid workbook'));
          },
        });
      },
    };
    const queue = new RecordingBatchQueue();
    const progress = new RecordingProgress();
    const lifecycle = new RecordingLifecycle();
    const service = new ImportStreamingService({ workbookReader: corruptReader, batchQueue: queue, progress, lifecycle }, OPTIONS);

    await expect(service.processUploadStream(upload(), 'import-9')).rejects.toBeInstanceOf(ImportWorkbookParseError);
    expect(queue.batches).toHaveLength(0);
    expect(progress.malformedRows).toHaveLength(0);
    expect(lifecycle.completed).toHaveLength(0);
    expect(lifecycle.failures).toHaveLength(1);
  });

  it('marks enqueue completion only after producer success and leaves the import PROCESSING, never COMPLETED', async () => {
    const queue = new RecordingBatchQueue();
    queue.autoResolve = true;
    const { service, lifecycle } = createService(
      { headers: REQUIRED_IMPORT_HEADERS, rows: rows([row(1), row(2)]) },
      queue,
    );
    const processing = service.processUploadStream(upload(), 'import-10');
    void processing.catch(() => undefined);

    await expect(processing).resolves.toMatchObject({ status: 'PROCESSING' });
    expect(lifecycle.completed).toHaveLength(1);
  });
});
