import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/config.module.js';
import { ChangesModule } from '../changes/changes.module.js';
import { ImportsModule } from '../imports/imports.module.js';
import { ChangeQueueProcessor } from './processors/change-queue.processor.js';
import { DownstreamOutboxProcessor } from './processors/downstream-outbox.processor.js';
import { ImportBatchQueueProcessor } from './processors/import-batch-queue.processor.js';
import { QueueModule } from './queue.module.js';

@Module({
  imports: [AppConfigModule, QueueModule, ChangesModule, ImportsModule],
  providers: [ChangeQueueProcessor, ImportBatchQueueProcessor, DownstreamOutboxProcessor],
})
export class QueueWorkerModule {}
