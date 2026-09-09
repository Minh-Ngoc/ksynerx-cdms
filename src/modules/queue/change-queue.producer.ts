import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { ProductChangeInput } from '../changes/product-change-contract.js';
import { CHANGE_QUEUE_JOB_NAME, QUEUE_JOB_OPTIONS, QUEUE_NAMES } from './queue.constants.js';
import { ChangeJobData, serializeChangeJobData } from './queue-wire-contracts.js';

export interface ChangeQueuePort {
  add(
    name: string,
    data: ChangeJobData,
    options: typeof QUEUE_JOB_OPTIONS,
  ): Promise<Job<ChangeJobData>>;
}

@Injectable()
export class ChangeQueueProducer {
  constructor(@InjectQueue(QUEUE_NAMES.change) private readonly queue: ChangeQueuePort) {}

  async enqueueChange(input: ProductChangeInput): Promise<Job<ChangeJobData>> {
    // Awaiting queue.add is the durable-acceptance boundary for future ingress code: until Redis
    // accepts the job, callers must treat the change as not accepted and retry at the edge.
    return this.queue.add(CHANGE_QUEUE_JOB_NAME, serializeChangeJobData(input), QUEUE_JOB_OPTIONS);
  }
}
