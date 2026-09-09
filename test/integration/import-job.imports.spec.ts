import { DataSource } from 'typeorm';

import { createAppDataSourceFromEnvironment } from '../../src/database/data-source.js';
import { ImportStatus } from '../../src/modules/imports/entities/import-job.entity.js';
import { ImportJobRepository } from '../../src/modules/imports/import-job.repository.js';

describe('Import job producer lifecycle', () => {
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
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('persists CREATED -> UPLOADING -> PROCESSING and records producer completion without COMPLETED', async () => {
    const job = await imports.create('products.xlsx');
    await imports.markUploading(job.id);
    await imports.recordReadableRow(job.id);
    await imports.recordMalformedRow({ importId: job.id, rowNumber: 3, error: 'invalid price' });
    const enqueueCompletedAt = new Date('2026-01-02T03:04:05.000Z');
    await imports.markEnqueueCompleted(job.id, enqueueCompletedAt);

    await expect(imports.findById(job.id)).resolves.toMatchObject({
      id: job.id,
      status: ImportStatus.Processing,
      rowsRead: 2,
      rowsProcessed: 1,
      rowsSucceeded: 0,
      rowsFailed: 1,
      totalRows: 2,
      enqueueCompletedAt,
      completedAt: null,
      error: null,
    });
  });

  it('marks a producer failure without setting enqueue completion', async () => {
    const job = await imports.create('broken.xlsx');
    await imports.markUploading(job.id);
    await imports.markIngestionFailed(job.id, 'Workbook could not be read');

    await expect(imports.findById(job.id)).resolves.toMatchObject({
      status: ImportStatus.Failed,
      enqueueCompletedAt: null,
      completedAt: null,
      error: 'Workbook could not be read',
    });
  });
});
