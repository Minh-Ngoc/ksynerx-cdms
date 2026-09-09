import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { ImportBatch, ImportBatchQueue } from '../imports/import-streaming.contract.js';
import { IMPORT_BATCH_JOB_NAME, QUEUE_JOB_OPTIONS, QUEUE_NAMES } from './queue.constants.js';
import { ImportBatchJobData, serializeImportBatchJobData } from './queue-wire-contracts.js';

export interface ImportBatchQueuePort {
  add(
    name: string,
    data: ImportBatchJobData,
    options: typeof QUEUE_JOB_OPTIONS,
  ): Promise<Job<ImportBatchJobData>>;
}

@Injectable()
export class ImportBatchQueueProducer implements ImportBatchQueue {
  constructor(@InjectQueue(QUEUE_NAMES.importBatch) private readonly queue: ImportBatchQueuePort) {}

  async enqueueImportBatch(batch: ImportBatch): Promise<void> {
    await this.queue.add(IMPORT_BATCH_JOB_NAME, serializeImportBatchJobData(batch), QUEUE_JOB_OPTIONS);
  }
}
