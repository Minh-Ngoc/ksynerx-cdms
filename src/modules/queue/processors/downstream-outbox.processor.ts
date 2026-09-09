import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import type { OutboxDownstreamJobData } from '../../outbox/outbox-wire-contracts.js';
import { QUEUE_NAMES } from '../queue.constants.js';

@Injectable()
@Processor(QUEUE_NAMES.downstream)
export class DownstreamOutboxProcessor extends WorkerHost {
  private readonly logger = new Logger(DownstreamOutboxProcessor.name);

  async process(job: Job<OutboxDownstreamJobData>): Promise<{ outboxEventId: string }> {
    const data = job.data;

    // This consumer is duplicate-tolerant rather than strictly idempotent: duplicate log lines are
    // acceptable, but the processor must not mutate business tables or add an Inbox just to dedupe logs.
    this.logger.log({
      jobId: job.id,
      outboxEventId: data.outboxEventId,
      aggregateId: data.aggregateId,
      eventType: data.eventType,
      createdAt: data.createdAt,
    });

    return { outboxEventId: data.outboxEventId };
  }
}
