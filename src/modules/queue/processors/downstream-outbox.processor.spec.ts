import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { DownstreamOutboxProcessor } from './downstream-outbox.processor.js';

describe('DownstreamOutboxProcessor', () => {
  const jobData = {
    outboxEventId: '11111111-1111-4111-8111-111111111111',
    aggregateId: 'product-1',
    eventType: 'PRODUCT_CHANGE_ACCEPTED',
    payload: { productId: 'product-1', version: 3 },
    createdAt: '2026-01-02T03:04:05.678Z',
  };

  let originalLog: typeof Logger.prototype.log;

  beforeEach(() => {
    originalLog = Logger.prototype.log;
  });

  afterEach(() => {
    Logger.prototype.log = originalLog;
  });

  it('logs duplicate downstream deliveries without mutating business state', async () => {
    const logs: unknown[] = [];
    Logger.prototype.log = function log(message: unknown) {
      logs.push(message);
    };
    const processor = new DownstreamOutboxProcessor();

    await expect(processor.process({ id: 'job-1', data: jobData } as Job)).resolves.toEqual({
      outboxEventId: jobData.outboxEventId,
    });
    await expect(processor.process({ id: 'job-2', data: jobData } as Job)).resolves.toEqual({
      outboxEventId: jobData.outboxEventId,
    });

    expect(logs).toHaveLength(2);
    expect(logs).toEqual([
      expect.objectContaining({ outboxEventId: jobData.outboxEventId, jobId: 'job-1' }),
      expect.objectContaining({ outboxEventId: jobData.outboxEventId, jobId: 'job-2' }),
    ]);
  });
});
