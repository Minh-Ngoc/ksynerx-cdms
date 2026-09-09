import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { Queue } from 'bullmq';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/http/api-error.js';
import { AppConfigService } from '../src/config/app-config.service.js';
import { createAppDataSourceFromEnvironment } from '../src/database/data-source.js';
import { ImportStatus } from '../src/modules/imports/entities/import-job.entity.js';
import { ImportJobRepository } from '../src/modules/imports/import-job.repository.js';
import { QUEUE_NAMES } from '../src/modules/queue/queue.constants.js';

describe('Product Excel imports (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let importQueue: Queue;

  beforeEach(async () => {
    dataSource = createAppDataSourceFromEnvironment(process.env);
    await dataSource.initialize();
    await dataSource.dropDatabase();
    await dataSource.runMigrations();
    importQueue = new Queue(QUEUE_NAMES.importBatch, {
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    });
    await importQueue.drain(true);

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppConfigService)
      .useValue({
        api: { port: 3000 },
        database: {
          host: process.env.DATABASE_HOST ?? 'localhost',
          port: Number(process.env.DATABASE_PORT ?? 5432),
          name: process.env.DATABASE_NAME ?? 'cdms',
          user: process.env.DATABASE_USER ?? 'cdms',
          password: process.env.DATABASE_PASSWORD ?? 'cdms_demo_password',
        },
        redis: { host: process.env.REDIS_HOST ?? 'localhost', port: Number(process.env.REDIS_PORT ?? 6379) },
        polling: { intervalMs: 5000 },
        inventory: { seedCount: 0 },
        imports: { batchSize: 2, maxPendingBatches: 2, maxFileSizeMb: 100, redisRetryTimeoutMs: 30 },
        worker: { changeConcurrency: 10 },
        outbox: { batchSize: 100, pollIntervalMs: 1000 },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    await importQueue?.close();
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('streams a multipart XLSX into Redis batches and ends producer lifecycle at PROCESSING', async () => {
    const response = await request(app.getHttpServer())
      .post('/imports/products')
      .attach('file', await workbookBuffer(), { filename: 'products.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    if (response.status !== 202) {
      // eslint-disable-next-line no-console
      console.error(response.status, response.body);
    }
    expect(response.status).toBe(202);

    expect(response.body).toMatchObject({ status: 'PROCESSING' });
    const [job] = await dataSource.query('SELECT * FROM import_jobs WHERE id = $1', [response.body.importId]);
    expect(job).toMatchObject({
      status: ImportStatus.Processing,
      rows_read: 3,
      rows_processed: 1,
      rows_succeeded: 0,
      rows_failed: 1,
      total_rows: 3,
      completed_at: null,
    });
    expect(job.enqueue_completed_at).not.toBeNull();

    const queued = await importQueue.getWaiting();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.data).toMatchObject({ importId: response.body.importId, rows: [{ rowNumber: 2 }, { rowNumber: 4 }] });
  });

  it('returns durable import state and a stable 404 for an unknown import', async () => {
    const imports = app.get(ImportJobRepository);
    const job = await imports.create('products.xlsx');
    await imports.markUploading(job.id);
    await imports.recordReadableRow(job.id);
    await imports.markEnqueueCompleted(job.id, new Date('2026-01-01T00:00:00.000Z'));

    const status = await request(app.getHttpServer()).get(`/imports/${job.id}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      id: job.id,
      filename: 'products.xlsx',
      status: ImportStatus.Processing,
      rowsRead: 1,
      rowsProcessed: 0,
      totalRows: 1,
      enqueueCompletedAt: '2026-01-01T00:00:00.000Z',
    });

    const missing = await request(app.getHttpServer()).get('/imports/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND', message: 'Import not found' });
  });

  it('sends a terminal snapshot after the initial SSE progress snapshot and closes', async () => {
    const imports = app.get(ImportJobRepository);
    const job = await imports.create('products.xlsx');
    await imports.markUploading(job.id);
    await imports.recordReadableRow(job.id);
    await imports.markEnqueueCompleted(job.id, new Date('2026-01-01T00:00:00.000Z'));
    await imports.accountTerminalBatch({ importId: job.id, batchId: `${job.id}:0`, succeeded: 0, failed: 1 });

    const response = await request(app.getHttpServer()).get(`/imports/${job.id}/progress`).timeout({ response: 1000, deadline: 2000 });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('event: progress');
    expect(response.text).toContain('event: completed');
    expect(response.text).toContain('"rowsFailed":1');
  });
});

async function workbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products');
  sheet.addRow(['productId', 'version', 'sku', 'name', 'price', 'quantity', 'observedAt']);
  sheet.addRow(['product-1', 1, 'SKU-1', 'Product 1', '10.00', 1, new Date('2026-01-01T00:00:00.000Z')]);
  sheet.addRow(['product-2', 0, 'SKU-2', 'Bad Product', '20.00', 2, new Date('2026-01-01T00:00:00.000Z')]);
  sheet.addRow(['product-3', 1, 'SKU-3', 'Product 3', '30.00', 3, new Date('2026-01-01T00:00:00.000Z')]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
