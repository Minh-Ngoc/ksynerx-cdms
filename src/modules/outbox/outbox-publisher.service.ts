import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AppConfigService } from '../../config/app-config.service.js';
import { OutboxDownstreamQueueProducer } from '../queue/outbox-downstream-queue.producer.js';
import { OutboxPublisherRepository } from './outbox-publisher.repository.js';
import {
  type OutboxDownstreamJobData,
  type OutboxEventForPublication,
  serializeOutboxDownstreamJob,
} from './outbox-wire-contracts.js';

export interface OutboxPublishBatchResult {
  published: number;
  failed: number;
}

export interface OutboxDownstreamPublisher {
  enqueueOutboxEvent(data: OutboxDownstreamJobData): Promise<unknown>;
}

@Injectable()
export class OutboxPublisherService {
  constructor(
    private readonly config: AppConfigService,
    private readonly repository: OutboxPublisherRepository,
    @Inject(OutboxDownstreamQueueProducer)
    private readonly downstreamPublisher: OutboxDownstreamPublisher,
  ) {}

  async publishBatch(): Promise<OutboxPublishBatchResult> {
    let shouldThrowPublicationFailure = false;
    const result = await this.repository.withClaimedBatch(this.config.outbox.batchSize, async (events, manager) => {
      let published = 0;
      let failed = 0;

      for (const event of events) {
        const publishResult = await this.publishOne(event, manager);
        published += publishResult.published;
        failed += publishResult.failed;
        shouldThrowPublicationFailure ||= publishResult.failed > 0;
      }

      return { published, failed };
    });

    if (shouldThrowPublicationFailure) {
      throw new Error('outbox publication failed');
    }

    return result;
  }

  private async publishOne(
    event: OutboxEventForPublication,
    manager: EntityManager,
  ): Promise<OutboxPublishBatchResult> {
    try {
      // Marking after queue.add is the transactional-outbox trade-off: committed DB events are not
      // lost across the DB->queue boundary, but a crash before this mark leaves a retryable row that
      // can publish again. Downstream handling must therefore tolerate duplicates.
      await this.downstreamPublisher.enqueueOutboxEvent(serializeOutboxDownstreamJob(event));
    } catch (error) {
      await this.repository.recordPublicationFailure(manager, event.id, sanitizeOutboxError(error));
      return { published: 0, failed: 1 };
    }

    await this.repository.markPublished(manager, event.id);
    return { published: 1, failed: 0 };
  }
}

export function sanitizeOutboxError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replaceAll(/(password|token|secret)=\S+/gi, '$1=[redacted]')
    .slice(0, 1000);
}
