import { ChangeSource, ProductChangeInput } from '../changes/product-change-contract.js';
import { ChangeQueuePort, ChangeQueueProducer } from './change-queue.producer.js';
import {
  CHANGE_QUEUE_JOB_NAME,
  QUEUE_JOB_OPTIONS,
  QUEUE_NAMES,
} from './queue.constants.js';
import {
  deserializeChangeJobData,
  serializeChangeJobData,
} from './queue-wire-contracts.js';

describe('change queue wire contract', () => {
  const input: ProductChangeInput = {
    productId: 'product-queue',
    version: 3,
    source: ChangeSource.Webhook,
    payload: {
      sku: 'SKU-QUEUE',
      name: 'Queue Product',
      price: '100.10',
      quantity: 8,
    },
    observedAt: new Date('2026-01-02T03:04:05.678Z'),
  };

  it('uses stable explicit queue names', () => {
    expect(QUEUE_NAMES).toEqual({
      change: 'cdms-change',
      importBatch: 'cdms-import-batch',
      downstream: 'cdms-downstream',
    });
  });

  it('serializes Date values to an explicit ISO wire format and reconstructs the same instant', () => {
    const serialized = serializeChangeJobData(input);
    expect(serialized.observedAt).toBe('2026-01-02T03:04:05.678Z');

    const roundTripped = deserializeChangeJobData(serialized);
    expect(roundTripped).toEqual(input);
    expect(roundTripped.observedAt).toBeInstanceOf(Date);
  });

  it('awaits queue.add with bounded retry and retained failure evidence options', async () => {
    const addedJob = { id: 'job-1' };
    const calls: unknown[][] = [];
    const queue: ChangeQueuePort = {
      add: async (...args) => {
        calls.push(args);
        return addedJob as never;
      },
    };
    const producer = new ChangeQueueProducer(queue);

    await expect(producer.enqueueChange(input)).resolves.toBe(addedJob);

    expect(calls).toEqual([[
      CHANGE_QUEUE_JOB_NAME,
      serializeChangeJobData(input),
      QUEUE_JOB_OPTIONS,
    ]]);
  });

  it('propagates queue.add rejection instead of claiming enqueue success', async () => {
    const redisError = new Error('redis unavailable');
    const queue: ChangeQueuePort = {
      add: async () => {
        throw redisError;
      },
    };
    const producer = new ChangeQueueProducer(queue);

    await expect(producer.enqueueChange(input)).rejects.toThrow(redisError);
  });
});
