import { Inject, Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { ChangeProcessor } from '../../changes/change-processor.js';
import { QUEUE_NAMES } from '../queue.constants.js';
import { deserializeChangeJobData, ImportBatchJobData } from '../queue-wire-contracts.js';

export interface ImportBatchProgressPort {
  isBatchAccounted(importId: string, batchId: string): Promise<boolean>;
  accountTerminalBatch(input: {
    importId: string;
    batchId: string;
    succeeded: number;
    failed: number;
  }): Promise<{ accounted: boolean }>;
}

export interface ImportBatchProcessingResult {
  accounted: boolean;
  succeeded: number;
  failed: number;
}

@Injectable()
@Processor(QUEUE_NAMES.importBatch)
export class ImportBatchQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(ImportBatchQueueProcessor.name);

  constructor(
    @Inject(ChangeProcessor)
    private readonly changeProcessor: Pick<ChangeProcessor, 'process'>,
    @Inject('IMPORT_BATCH_PROGRESS_PORT')
    private readonly progress: ImportBatchProgressPort,
  ) {
    super();
  }

  async process(job: Job<ImportBatchJobData>): Promise<ImportBatchProcessingResult> {
    const { importId, batchId, rows } = job.data;
    if (await this.progress.isBatchAccounted(importId, batchId)) {
      return { accounted: false, succeeded: 0, failed: 0 };
    }

    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    let succeeded = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        await this.changeProcessor.process(deserializeChangeJobData(row.change));
        succeeded += 1;
      } catch (error) {
        if (!finalAttempt) {
          // A replay will rerun business processing safely, but progress must not advance until a
          // whole batch has a terminal outcome. Counting here would double-count on BullMQ retry.
          throw error;
        }
        failed += 1;
        this.logger.warn({
          importId,
          jobId: job.id,
          batchId,
          rowNumber: row.rowNumber,
          message: 'Import row reached terminal worker failure on the final BullMQ attempt',
        });
      }
    }

    const accounted = await this.progress.accountTerminalBatch({ importId, batchId, succeeded, failed });
    this.logger.log({ importId, jobId: job.id, batchId, processed: succeeded + failed, succeeded, failed, accounted: accounted.accounted });
    return { accounted: accounted.accounted, succeeded, failed };
  }
}
