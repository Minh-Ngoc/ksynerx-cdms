import { EntityManager } from 'typeorm';

import { AppConfigService } from '../../config/app-config.service.js';
import { OutboxPublisherRepository } from './outbox-publisher.repository.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';
import type { OutboxEventForPublication } from './outbox-wire-contracts.js';

describe('OutboxPublisherService', () => {
  it('publishes a bounded batch and marks events published only after downstream enqueue succeeds', async () => {
    const event = outboxEvent('event-1');
    const repository = fakeRepository([event]);
    const downstream = fakeDownstreamProducer();
    const publisher = new OutboxPublisherService(fakeConfig(1), repository as unknown as OutboxPublisherRepository, downstream);

    await expect(publisher.publishBatch()).resolves.toEqual({ published: 1, failed: 0 });

    expect(downstream.added.map((job) => job.outboxEventId)).toEqual(['event-1']);
    expect(repository.markedPublished).toEqual(['event-1']);
    expect(repository.recordedFailures).toEqual([]);
  });

  it('records failed queue publication attempts without marking the event published', async () => {
    const repository = fakeRepository([outboxEvent('event-1')]);
    const downstream = fakeDownstreamProducer({ rejectWith: new Error('redis password=secret unavailable') });
    const publisher = new OutboxPublisherService(fakeConfig(1), repository as unknown as OutboxPublisherRepository, downstream);

    await expect(publisher.publishBatch()).rejects.toThrow('outbox publication failed');

    expect(repository.markedPublished).toEqual([]);
    expect(repository.recordedFailures).toEqual([
      {
        id: 'event-1',
        error: 'redis password=[redacted] unavailable',
      },
    ]);
  });

  it('allows retry success after an earlier publication failure', async () => {
    const event = outboxEvent('event-1');
    const repository = fakeRepository([event]);
    const downstream = fakeDownstreamProducer({ rejectOnce: true });
    const publisher = new OutboxPublisherService(fakeConfig(1), repository as unknown as OutboxPublisherRepository, downstream);

    await expect(publisher.publishBatch()).rejects.toThrow('outbox publication failed');
    await expect(publisher.publishBatch()).resolves.toEqual({ published: 1, failed: 0 });

    expect(downstream.added.map((job) => job.outboxEventId)).toEqual(['event-1', 'event-1']);
    expect(repository.markedPublished).toEqual(['event-1']);
  });

  it('does not compensate the downstream job when mark-published fails after enqueue', async () => {
    const repository = fakeRepository([outboxEvent('event-1')], { failMarkPublished: true });
    const downstream = fakeDownstreamProducer();
    const publisher = new OutboxPublisherService(fakeConfig(1), repository as unknown as OutboxPublisherRepository, downstream);

    await expect(publisher.publishBatch()).rejects.toThrow('mark published failed');

    // A successful queue.add followed by a DB mark failure is the duplicate-publication window.
    // The publisher must not delete the already accepted downstream job or add an Inbox table.
    expect(downstream.added.map((job) => job.outboxEventId)).toEqual(['event-1']);
    expect(repository.markedPublished).toEqual([]);
  });
});

function fakeConfig(batchSize: number): AppConfigService {
  return {
    outbox: { batchSize, pollIntervalMs: 1000 },
  } as AppConfigService;
}

function fakeRepository(events: OutboxEventForPublication[], options: { failMarkPublished?: boolean } = {}) {
  const pending = [...events];

  return {
    markedPublished: [] as string[],
    recordedFailures: [] as Array<{ id: string; error: string }>,
    async withClaimedBatch<T>(
      batchSize: number,
      publish: (events: OutboxEventForPublication[], manager: EntityManager) => Promise<T>,
    ): Promise<T> {
      const claimed = pending.slice(0, batchSize);
      return publish(claimed, {} as EntityManager);
    },
    async markPublished(_manager: EntityManager, id: string): Promise<void> {
      if (options.failMarkPublished === true) {
        throw new Error('mark published failed');
      }

      this.markedPublished.push(id);
      const pendingIndex = pending.findIndex((event) => event.id === id);
      if (pendingIndex >= 0) {
        pending.splice(pendingIndex, 1);
      }
    },
    async recordPublicationFailure(_manager: EntityManager, id: string, error: string): Promise<void> {
      this.recordedFailures.push({ id, error });
    },
  };
}

function fakeDownstreamProducer(options: { rejectWith?: Error; rejectOnce?: boolean } = {}) {
  return {
    added: [] as Array<{ outboxEventId: string }>,
    rejected: false,
    async enqueueOutboxEvent(job: { outboxEventId: string }) {
      this.added.push(job);
      if (options.rejectWith !== undefined) {
        throw options.rejectWith;
      }

      if (options.rejectOnce === true && !this.rejected) {
        this.rejected = true;
        throw new Error('redis unavailable');
      }
    },
  };
}

function outboxEvent(id: string): OutboxEventForPublication {
  return {
    id,
    aggregateId: 'product-1',
    eventType: 'PRODUCT_CHANGE_ACCEPTED',
    payload: { productId: 'product-1', version: 3 },
    createdAt: new Date('2026-01-02T03:04:05.678Z'),
  };
}
