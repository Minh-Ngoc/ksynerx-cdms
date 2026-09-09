import { Job } from 'bullmq';

import { ChangeProcessingResultKind } from '../../changes/change-processor.js';
import { ChangeSource } from '../../changes/product-change-contract.js';
import { ImportBatchQueueProcessor } from './import-batch-queue.processor.js';

const jobData = {
  importId: '11111111-1111-4111-8111-111111111111',
  batchId: '11111111-1111-4111-8111-111111111111:0',
  rows: [
    {
      rowNumber: 2,
      change: {
        productId: 'product-1',
        version: 1,
        source: ChangeSource.Excel,
        payload: { sku: 'SKU-1', name: 'Product 1', price: '10.00', quantity: 1 },
        observedAt: '2026-01-02T03:04:05.000Z',
      },
    },
    {
      rowNumber: 3,
      change: {
        productId: 'product-2',
        version: 1,
        source: ChangeSource.Excel,
        payload: { sku: 'SKU-2', name: 'Product 2', price: '20.00', quantity: 2 },
        observedAt: '2026-01-02T03:04:05.000Z',
      },
    },
  ],
};

describe('ImportBatchQueueProcessor', () => {
  it.each([
    ChangeProcessingResultKind.Accepted,
    ChangeProcessingResultKind.Duplicate,
    ChangeProcessingResultKind.Stale,
    ChangeProcessingResultKind.VersionConflict,
  ])('accounts terminal semantic outcome %s as a succeeded row', async (result) => {
    const calls: unknown[] = [];
    const progress = new RecordingProgress();
    const processor = new ImportBatchQueueProcessor(
      { process: async (input) => { calls.push(input); return { result, productId: input.productId, version: input.version }; } },
      progress,
    );

    await expect(processor.process(job({ attemptsMade: 0, attempts: 2 }))).resolves.toMatchObject({ accounted: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ observedAt: new Date(jobData.rows[0].change.observedAt) });
    expect(progress.accounted).toEqual([{ importId: jobData.importId, batchId: jobData.batchId, succeeded: 2, failed: 0 }]);
  });

  it('throws on a non-final unexpected failure without accounting partial batch progress', async () => {
    const progress = new RecordingProgress();
    const processor = new ImportBatchQueueProcessor(
      { process: async (input) => {
        if (input.productId === 'product-2') throw new Error('database unavailable');
        return { result: ChangeProcessingResultKind.Accepted, productId: input.productId, version: input.version };
      } },
      progress,
    );

    await expect(processor.process(job({ attemptsMade: 0, attempts: 2 }))).rejects.toThrow('database unavailable');
    expect(progress.accounted).toEqual([]);
  });

  it('accounts final-attempt unexpected failures once and continues remaining rows', async () => {
    const progress = new RecordingProgress();
    const processor = new ImportBatchQueueProcessor(
      { process: async (input) => {
        if (input.productId === 'product-1') throw new Error('database unavailable');
        return { result: ChangeProcessingResultKind.Accepted, productId: input.productId, version: input.version };
      } },
      progress,
    );

    await expect(processor.process(job({ attemptsMade: 1, attempts: 2 }))).resolves.toMatchObject({ accounted: true });
    expect(progress.accounted).toEqual([{ importId: jobData.importId, batchId: jobData.batchId, succeeded: 1, failed: 1 }]);
  });

  it('skips a replay already protected by the durable accounting marker', async () => {
    const progress = new RecordingProgress();
    progress.alreadyAccounted = true;
    const processor = new ImportBatchQueueProcessor(
      { process: async () => { throw new Error('must not process replay'); } },
      progress,
    );

    await expect(processor.process(job({ attemptsMade: 0, attempts: 2 }))).resolves.toMatchObject({ accounted: false });
    expect(progress.accounted).toEqual([]);
  });
});

class RecordingProgress {
  alreadyAccounted = false;
  readonly accounted: Array<{ importId: string; batchId: string; succeeded: number; failed: number }> = [];

  async isBatchAccounted(): Promise<boolean> {
    return this.alreadyAccounted;
  }

  async accountTerminalBatch(input: { importId: string; batchId: string; succeeded: number; failed: number }): Promise<{ accounted: boolean }> {
    this.accounted.push(input);
    return { accounted: true };
  }
}

function job(options: { attemptsMade: number; attempts: number }): Job<typeof jobData> {
  return { id: 'job-1', data: jobData, attemptsMade: options.attemptsMade, opts: { attempts: options.attempts } } as Job<typeof jobData>;
}
