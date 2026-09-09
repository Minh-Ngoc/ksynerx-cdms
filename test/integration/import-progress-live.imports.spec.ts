import { DataSource } from 'typeorm';

import { createAppDataSourceFromEnvironment } from '../../src/database/data-source.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { ImportJobRepository } from '../../src/modules/imports/import-job.repository.js';
import { ImportProgressReadService } from '../../src/modules/imports/import-progress-read.service.js';
import { ImportProgressService } from '../../src/modules/imports/import-progress.service.js';
import { ImportStatus } from '../../src/modules/imports/entities/import-job.entity.js';

describe('import progress Redis live notifications', () => {
  let dataSource: DataSource;
  let imports: ImportJobRepository;
  let progress: ImportProgressService;

  beforeAll(async () => {
    dataSource = createAppDataSourceFromEnvironment(process.env);
    await dataSource.initialize();
    imports = new ImportJobRepository(dataSource);
    progress = new ImportProgressService(imports, config() as AppConfigService);
  });

  beforeEach(async () => {
    await dataSource.dropDatabase();
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    progress.onModuleDestroy();
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('delivers a committed Task 20 update through Redis after the PostgreSQL snapshot', async () => {
    const job = await imports.create('products.xlsx');
    await imports.markUploading(job.id);
    await imports.recordReadableRow(job.id);
    await imports.markEnqueueCompleted(job.id, new Date('2026-01-01T00:00:00.000Z'));

    const reader = new ImportProgressReadService(imports, progress);
    const stream = await reader.stream(job.id, new AbortController().signal);
    const events: Array<{ type?: string; data?: unknown }> = [];
    const completed = new Promise<void>((resolve, reject) => {
      stream.subscribe({
        next: (event) => {
          events.push(event);
          if (event.type === 'completed') resolve();
        },
        error: reject,
      });
    });

    await progress.accountTerminalBatch({ importId: job.id, batchId: `${job.id}:0`, succeeded: 1, failed: 0 });
    await Promise.race([completed, timeout(1000)]);

    expect(events).toEqual([
      expect.objectContaining({ type: 'progress', data: expect.objectContaining({ rowsProcessed: 0 }) }),
      expect.objectContaining({ type: 'progress', data: expect.objectContaining({ rowsProcessed: 1 }) }),
      expect.objectContaining({ type: 'completed', data: expect.objectContaining({ rowsProcessed: 1 }) }),
    ]);
  });

  it('reads durable PROCESSING and FAILED states from PostgreSQL without replacing counters from Redis', async () => {
    const job = await imports.create('products.xlsx');
    await imports.markUploading(job.id);
    await imports.recordReadableRow(job.id);
    await imports.markIngestionFailed(job.id, 'parser failed after one queued row');

    const reader = new ImportProgressReadService(imports, progress);
    await expect(reader.getStatus(job.id)).resolves.toMatchObject({
      id: job.id,
      status: ImportStatus.Failed,
      rowsRead: 1,
      rowsProcessed: 0,
      rowsFailed: 0,
      error: 'parser failed after one queued row',
    });
  });
});

function config() {
  return {
    redis: {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
    },
  };
}

function timeout(milliseconds: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for Redis progress notification')), milliseconds));
}
