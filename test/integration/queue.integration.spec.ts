import { Queue, Worker } from 'bullmq';

import { ChangeSource, ProductChangeInput } from '../../src/modules/changes/product-change-contract.js';
import {
  CHANGE_QUEUE_JOB_NAME,
  QUEUE_JOB_OPTIONS,
  QUEUE_NAMES,
} from '../../src/modules/queue/queue.constants.js';
import {
  deserializeChangeJobData,
  serializeChangeJobData,
} from '../../src/modules/queue/queue-wire-contracts.js';

describe('BullMQ queue transport', () => {
  const connection = {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
  };

  let queue: Queue;
  let worker: Worker | undefined;

  beforeEach(async () => {
    queue = new Queue(QUEUE_NAMES.change, { connection });
    await queue.drain(true);
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await queue.close();
  });

  it('round-trips a normalized change job through real Redis without losing observedAt', async () => {
    const input: ProductChangeInput = {
      productId: 'product-redis',
      version: 2,
      source: ChangeSource.Excel,
      payload: {
        sku: 'SKU-REDIS',
        name: 'Redis Product',
        price: '42.42',
        quantity: 10,
      },
      observedAt: new Date('2026-01-02T03:04:05.678Z'),
    };

    const consumed = new Promise<ProductChangeInput>((resolve, reject) => {
      worker = new Worker(
        QUEUE_NAMES.change,
        async (job) => {
          resolve(deserializeChangeJobData(job.data));
        },
        { connection, concurrency: 2 },
      );
      worker.on('failed', (_job, error) => reject(error));
      worker.on('error', reject);
    });

    await queue.add(CHANGE_QUEUE_JOB_NAME, serializeChangeJobData(input), QUEUE_JOB_OPTIONS);

    await expect(consumed).resolves.toEqual(input);
  });
});
