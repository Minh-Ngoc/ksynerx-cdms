import { Inject, Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { AppConfigService } from '../../../config/app-config.service.js';
import { ChangeProcessor, ChangeProcessingResult } from '../../changes/change-processor.js';
import { QUEUE_NAMES } from '../queue.constants.js';
import { deserializeChangeJobData, ChangeJobData } from '../queue-wire-contracts.js';

@Injectable()
@Processor(QUEUE_NAMES.change)
export class ChangeQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(ChangeQueueProcessor.name);

  constructor(
    @Inject(ChangeProcessor)
    private readonly changeProcessor: Pick<ChangeProcessor, 'process'>,
    private readonly appConfig?: AppConfigService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    if (this.appConfig) {
      const { concurrency } = createWorkerRuntimeOptions(this.appConfig);
      this.worker.concurrency = concurrency;
    }
  }

  async process(job: Job<ChangeJobData>): Promise<ChangeProcessingResult> {
    const input = deserializeChangeJobData(job.data);

    // BullMQ is only buffering/retry/concurrency infrastructure. Semantic outcomes complete
    // successfully here; PostgreSQL advisory locks and constraints remain the correctness boundary.
    const result = await this.changeProcessor.process(input);
    this.logger.log({
      jobId: job.id,
      productId: result.productId,
      version: result.version,
      result: result.result,
    });

    return result;
  }
}

export function createWorkerRuntimeOptions(config: AppConfigService): { concurrency: number } {
  return {
    concurrency: config.worker.changeConcurrency,
  };
}
