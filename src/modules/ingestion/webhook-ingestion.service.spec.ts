import { BadRequestException } from '@nestjs/common';

import { ErrorCode } from '../../common/http/api-error.js';
import { ChangeSource, ProductChangeInput } from '../changes/product-change-contract.js';
import { ChangeQueueProducer } from '../queue/change-queue.producer.js';
import { WebhookIngestionService } from './webhook-ingestion.service.js';

describe('WebhookIngestionService', () => {
  const dto = {
    productId: ' product-webhook ',
    version: 2,
    payload: {
      sku: ' SKU-WEBHOOK ',
      name: 'Webhook Product',
      price: '10',
      quantity: 4,
    },
    observedAt: '2026-01-02T03:04:05.678Z',
  };

  it('normalizes a valid webhook and calls enqueue exactly once with internally assigned source', async () => {
    const enqueued: ProductChangeInput[] = [];
    const service = new WebhookIngestionService({
      enqueueChange: async (input) => {
        enqueued.push(input);
        return { id: 'job-1' } as never;
      },
    } as Pick<ChangeQueueProducer, 'enqueueChange'>);

    await expect(service.accept(dto)).resolves.toEqual({ status: 'ACCEPTED' });

    expect(enqueued).toEqual([
      {
        productId: 'product-webhook',
        version: 2,
        source: ChangeSource.Webhook,
        payload: {
          sku: 'SKU-WEBHOOK',
          name: 'Webhook Product',
          price: '10.00',
          quantity: 4,
        },
        observedAt: new Date('2026-01-02T03:04:05.678Z'),
      },
    ]);
  });

  it('does not resolve acceptance before enqueue resolves', async () => {
    let resolveEnqueue: (() => void) | undefined;
    let completed = false;
    const service = new WebhookIngestionService({
      enqueueChange: async () =>
        new Promise((resolve) => {
          resolveEnqueue = () => resolve({ id: 'job-deferred' } as never);
        }),
    } as Pick<ChangeQueueProducer, 'enqueueChange'>);

    const result = service.accept(dto).then((value) => {
      completed = true;
      return value;
    });

    await Promise.resolve();
    expect(completed).toBe(false);

    resolveEnqueue?.();
    await expect(result).resolves.toEqual({ status: 'ACCEPTED' });
    expect(completed).toBe(true);
  });

  it('maps enqueue failure to stable 503 dependency failure without raw Redis details', async () => {
    const service = new WebhookIngestionService({
      enqueueChange: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      },
    } as Pick<ChangeQueueProducer, 'enqueueChange'>);

    await expect(service.accept(dto)).rejects.toMatchObject({
      response: {
        statusCode: 503,
        code: ErrorCode.DependencyUnavailable,
        message: 'Inventory webhook could not be accepted for asynchronous processing',
      },
    });
  });

  it('does not enqueue when defensive normalization rejects caller input', async () => {
    const enqueued: ProductChangeInput[] = [];
    const service = new WebhookIngestionService({
      enqueueChange: async (input) => {
        enqueued.push(input);
        return { id: 'job-should-not-exist' } as never;
      },
    } as Pick<ChangeQueueProducer, 'enqueueChange'>);

    await expect(service.accept({ ...dto, productId: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    expect(enqueued).toEqual([]);
  });

  it('accepts repeated identical deliveries when enqueue succeeds', async () => {
    let enqueueCount = 0;
    const service = new WebhookIngestionService({
      enqueueChange: async () => {
        enqueueCount += 1;
        return { id: `job-${enqueueCount}` } as never;
      },
    } as Pick<ChangeQueueProducer, 'enqueueChange'>);

    await expect(service.accept(dto)).resolves.toEqual({ status: 'ACCEPTED' });
    await expect(service.accept(dto)).resolves.toEqual({ status: 'ACCEPTED' });

    expect(enqueueCount).toBe(2);
  });
});
