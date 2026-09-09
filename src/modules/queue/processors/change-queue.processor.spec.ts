import { Job } from 'bullmq';

import { ChangeProcessingResultKind } from '../../changes/change-processor.js';
import { ChangeSource } from '../../changes/product-change-contract.js';
import { ChangeQueueProcessor } from './change-queue.processor.js';

describe('ChangeQueueProcessor', () => {
  const jobData = {
    productId: 'product-worker',
    version: 5,
    source: ChangeSource.Polling,
    payload: {
      sku: 'SKU-WORKER',
      name: 'Worker Product',
      price: '0.10',
      quantity: 4,
    },
    observedAt: '2026-01-02T03:04:05.678Z',
  };

  it.each([
    ChangeProcessingResultKind.Accepted,
    ChangeProcessingResultKind.Duplicate,
    ChangeProcessingResultKind.Stale,
    ChangeProcessingResultKind.VersionConflict,
  ])('completes successfully for business result %s', async (result) => {
    const calls: unknown[] = [];
    const changeProcessor = {
      process: async (input: unknown) => {
        calls.push(input);
        return { result, productId: jobData.productId, version: jobData.version };
      },
    };
    const processor = new ChangeQueueProcessor(changeProcessor);

    await expect(processor.process({ data: jobData } as Job)).resolves.toEqual({
      result,
      productId: jobData.productId,
      version: jobData.version,
    });

    expect(calls).toEqual([{
      ...jobData,
      observedAt: new Date(jobData.observedAt),
    }]);
  });

  it('rethrows infrastructure failures so BullMQ can retry the job', async () => {
    const databaseError = new Error('database unavailable');
    const changeProcessor = {
      process: async () => {
        throw databaseError;
      },
    };
    const processor = new ChangeQueueProcessor(changeProcessor);

    await expect(processor.process({ data: jobData } as Job)).rejects.toThrow(databaseError);
  });
});
