import { Module } from '@nestjs/common';

import { AppConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { OutboxModule } from './modules/outbox/outbox.module.js';
import { QueueWorkerModule } from './modules/queue/queue-worker.module.js';

@Module({
  imports: [AppConfigModule, DatabaseModule, QueueWorkerModule, OutboxModule],
})
export class WorkerModule {}
