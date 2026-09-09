import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';

import { AppConfigService } from '../../src/config/app-config.service.js';
import { createAppDataSourceFromEnvironment } from '../../src/database/data-source.js';
import { ChangeProcessor } from '../../src/modules/changes/change-processor.js';
import { ProductLockService } from '../../src/modules/changes/product-lock.service.js';
import { ChangeSource } from '../../src/modules/changes/product-change-contract.js';
import { ImportJobRepository } from '../../src/modules/imports/import-job.repository.js';
import { ImportProgressService } from '../../src/modules/imports/import-progress.service.js';
import { IMPORT_BATCH_JOB_NAME, QUEUE_NAMES } from '../../src/modules/queue/queue.constants.js';
import { ImportBatchQueueProcessor } from '../../src/modules/queue/processors/import-batch-queue.processor.js';
import { ImportBatchJobData } from '../../src/modules/queue/queue-wire-contracts.js';

describe('import batch worker transport', () => {
  const connection = {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
  };
  let dataSource: DataSource;
  let imports: ImportJobRepository;
  let progress: ImportProgressService;
  let queue: Queue<ImportBatchJobData>;
  let worker: Worker<ImportBatchJobData> | undefined;

  beforeAll(async () => {
    dataSource = createAppDataSourceFromEnvironment(process.env);
    await dataSource.initialize();
    imports = new ImportJobRepository(dataSource);
    progress = new ImportProgressService(imports, config() as AppConfigService);
    queue = new Queue(QUEUE_NAMES.importBatch, { connection });
  });

  beforeEach(async () => {
    await dataSource.dropDatabase();
    await dataSource.runMigrations();
    await queue.drain(true);
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  afterAll(async () => {
    progress.onModuleDestroy();
    await queue.close();
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('uses real BullMQ retry then accounts one terminal batch in PostgreSQL', async () => {
    const importId = await createProcessingImport(1);
    const changeProcessor = new ChangeProcessor(dataSource, new ProductLockService());
    let calls = 0;
    const processor = new ImportBatchQueueProcessor(
      {
        process: async (input) => {
          calls += 1;
          if (calls === 1) throw new Error('transient database failure');
          return changeProcessor.process(input);
        },
      },
      progress,
    );

    const completed = new Promise<void>((resolve, reject) => {
      worker = new Worker(QUEUE_NAMES.importBatch, async (job) => processor.process(job), { connection, concurrency: 1 });
      worker.on('completed', () => resolve());
      worker.on('failed', (job, error) => {
        if ((job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1)) reject(error);
      });
      worker.on('error', reject);
    });

    await queue.add(IMPORT_BATCH_JOB_NAME, batch(importId), { attempts: 2, backoff: { type: 'fixed', delay: 1 } });
    await completed;

    expect(calls).toBe(2);
    await expect(imports.findById(importId)).resolves.toMatchObject({
      rowsRead: 1,
      rowsProcessed: 1,
      rowsSucceeded: 1,
      rowsFailed: 0,
      status: 'COMPLETED',
    });
    const [{ count }] = await dataSource.query('SELECT count(*)::int AS count FROM import_batch_accounting');
    expect(Number(count)).toBe(1);

    const redis = new Redis(connection);
    try {
      await expect(redis.hgetall(`cdms:import-progress:${importId}`)).resolves.toMatchObject({
        rowsRead: '1',
        rowsProcessed: '1',
        rowsSucceeded: '1',
        rowsFailed: '0',
        status: 'COMPLETED',
      });
    } finally {
      await redis.quit();
    }
  });

  async function createProcessingImport(rowsRead: number): Promise<string> {
    const job = await imports.create('products.xlsx');
    await imports.markUploading(job.id);
    for (let index = 0; index < rowsRead; index += 1) await imports.recordReadableRow(job.id);
    await imports.markEnqueueCompleted(job.id, new Date('2026-01-02T03:04:05.000Z'));
    return job.id;
  }
});

function batch(importId: string): ImportBatchJobData {
  return {
    importId,
    batchId: `${importId}:0`,
    rows: [{
      rowNumber: 2,
      change: {
        productId: 'product-import-worker',
        version: 1,
        source: ChangeSource.Excel,
        payload: { sku: 'SKU-IMPORT-WORKER', name: 'Import Worker', price: '10.00', quantity: 1 },
        observedAt: '2026-01-02T03:04:05.000Z',
      },
    }],
  };
}

function config() {
  return {
    redis: {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
    },
  };
}
