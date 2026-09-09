import { DataSource } from 'typeorm';

import { createAppDataSourceFromEnvironment } from '../../src/database/data-source.js';
import { ImportStatus } from '../../src/modules/imports/entities/import-job.entity.js';
import { ImportJobRepository } from '../../src/modules/imports/import-job.repository.js';

describe('durable import batch progress accounting', () => {
  let dataSource: DataSource;
  let imports: ImportJobRepository;

  beforeAll(async () => {
    dataSource = createAppDataSourceFromEnvironment(process.env);
    await dataSource.initialize();
    imports = new ImportJobRepository(dataSource);
  });

  beforeEach(async () => {
    await dataSource.dropDatabase();
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('accounts a terminal batch once and treats a replay as a no-op', async () => {
    const job = await createProcessingImport(2);
    await expect(imports.accountTerminalBatch({ importId: job.id, batchId: `${job.id}:0`, succeeded: 2, failed: 0 })).resolves.toMatchObject({ accounted: true });
    await expect(imports.accountTerminalBatch({ importId: job.id, batchId: `${job.id}:0`, succeeded: 2, failed: 0 })).resolves.toMatchObject({ accounted: false });

    await expect(imports.findById(job.id)).resolves.toMatchObject({
      status: ImportStatus.Completed,
      rowsRead: 2,
      rowsProcessed: 2,
      rowsSucceeded: 2,
      rowsFailed: 0,
    });
    await expect(accountingCount()).resolves.toBe(1);
  });

  it('does not complete merely because current durable counters are caught up before enqueue completion', async () => {
    const job = await imports.create('products.xlsx');
    await imports.markUploading(job.id);
    await imports.recordReadableRow(job.id);

    await imports.accountTerminalBatch({ importId: job.id, batchId: `${job.id}:0`, succeeded: 1, failed: 0 });

    await expect(imports.findById(job.id)).resolves.toMatchObject({
      status: ImportStatus.Uploading,
      rowsProcessed: 1,
      enqueueCompletedAt: null,
      completedAt: null,
    });
  });

  it('remains PROCESSING while some readable rows have no terminal outcome', async () => {
    const job = await createProcessingImport(2);

    await imports.accountTerminalBatch({ importId: job.id, batchId: `${job.id}:0`, succeeded: 1, failed: 0 });

    await expect(imports.findById(job.id)).resolves.toMatchObject({
      status: ImportStatus.Processing,
      rowsRead: 2,
      rowsProcessed: 1,
      completedAt: null,
    });
  });

  it('allows terminal failed rows and Task 19 malformed rows to complete an import', async () => {
    const job = await imports.create('products.xlsx');
    await imports.markUploading(job.id);
    await imports.recordReadableRow(job.id);
    await imports.recordMalformedRow({ importId: job.id, rowNumber: 3, error: 'bad price' });
    await imports.markEnqueueCompleted(job.id, new Date('2026-01-02T03:04:05.000Z'));

    await imports.accountTerminalBatch({ importId: job.id, batchId: `${job.id}:0`, succeeded: 0, failed: 1 });

    await expect(imports.findById(job.id)).resolves.toMatchObject({
      status: ImportStatus.Completed,
      rowsRead: 2,
      rowsProcessed: 2,
      rowsSucceeded: 0,
      rowsFailed: 2,
    });
  });

  it('accounts concurrent duplicate deliveries once and performs one logical terminal transition', async () => {
    const job = await createProcessingImport(2);
    const batch = { importId: job.id, batchId: `${job.id}:0`, succeeded: 2, failed: 0 };

    const results = await Promise.all([
      imports.accountTerminalBatch(batch),
      imports.accountTerminalBatch(batch),
    ]);

    expect(results.filter((result) => result.accounted)).toHaveLength(1);
    await expect(imports.findById(job.id)).resolves.toMatchObject({
      status: ImportStatus.Completed,
      rowsProcessed: 2,
      rowsSucceeded: 2,
      rowsFailed: 0,
    });
    await expect(accountingCount()).resolves.toBe(1);
  });

  it('allows concurrent final distinct batches to reach one valid completed state', async () => {
    const job = await createProcessingImport(2);

    await Promise.all([
      imports.accountTerminalBatch({ importId: job.id, batchId: `${job.id}:0`, succeeded: 1, failed: 0 }),
      imports.accountTerminalBatch({ importId: job.id, batchId: `${job.id}:1`, succeeded: 1, failed: 0 }),
    ]);

    await expect(imports.findById(job.id)).resolves.toMatchObject({
      status: ImportStatus.Completed,
      rowsRead: 2,
      rowsProcessed: 2,
      rowsSucceeded: 2,
      rowsFailed: 0,
      completedAt: expect.any(Date),
    });
    await expect(accountingCount()).resolves.toBe(2);
  });

  it('never resurrects a FAILED import even when accepted queued batches finish', async () => {
    const job = await imports.create('products.xlsx');
    await imports.markUploading(job.id);
    await imports.recordReadableRow(job.id);
    await imports.markIngestionFailed(job.id, 'parser failed after enqueue');

    await imports.accountTerminalBatch({ importId: job.id, batchId: `${job.id}:0`, succeeded: 1, failed: 0 });

    await expect(imports.findById(job.id)).resolves.toMatchObject({
      status: ImportStatus.Failed,
      rowsProcessed: 1,
      rowsSucceeded: 1,
      completedAt: null,
    });
  });

  it('reverts and reapplies the additive batch-accounting migration on PostgreSQL', async () => {
    await dataSource.undoLastMigration();
    await expect(dataSource.query("SELECT to_regclass('public.import_batch_accounting') AS relation")).resolves.toEqual([{ relation: null }]);

    await dataSource.runMigrations();
    await expect(dataSource.query("SELECT to_regclass('public.import_batch_accounting') AS relation")).resolves.toEqual([{ relation: 'import_batch_accounting' }]);
  });

  async function createProcessingImport(rowsRead: number) {
    const job = await imports.create('products.xlsx');
    await imports.markUploading(job.id);
    for (let index = 0; index < rowsRead; index += 1) await imports.recordReadableRow(job.id);
    await imports.markEnqueueCompleted(job.id, new Date('2026-01-02T03:04:05.000Z'));
    return job;
  }

  async function accountingCount(): Promise<number> {
    const [{ count }] = await dataSource.query('SELECT count(*)::int AS count FROM import_batch_accounting');
    return Number(count);
  }
});
