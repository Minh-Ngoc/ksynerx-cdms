import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { OutboxDownstreamJobData } from '../outbox/outbox-wire-contracts.js';
import { OUTBOX_DOWNSTREAM_JOB_NAME, QUEUE_JOB_OPTIONS, QUEUE_NAMES } from './queue.constants.js';

export interface OutboxDownstreamQueuePort {
  add(
    name: string,
    data: OutboxDownstreamJobData,
    options: typeof QUEUE_JOB_OPTIONS,
  ): Promise<Job<OutboxDownstreamJobData>>;
}

@Injectable()
export class OutboxDownstreamQueueProducer {
  constructor(@InjectQueue(QUEUE_NAMES.downstream) private readonly queue: OutboxDownstreamQueuePort) {}

  async enqueueOutboxEvent(data: OutboxDownstreamJobData): Promise<Job<OutboxDownstreamJobData>> {
    // The job id is intentionally not derived from outboxEventId. BullMQ deduplication/retention
    // must not become the correctness mechanism because duplicate publication is an approved outcome.
    return this.queue.add(OUTBOX_DOWNSTREAM_JOB_NAME, data, QUEUE_JOB_OPTIONS);
  }
}
