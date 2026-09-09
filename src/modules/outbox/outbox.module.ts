import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/config.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { OutboxPublisherRepository } from './outbox-publisher.repository.js';
import { OutboxPublisherScheduler } from './outbox-publisher.scheduler.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';

@Module({
  imports: [AppConfigModule, QueueModule],
  providers: [OutboxPublisherRepository, OutboxPublisherScheduler, OutboxPublisherService],
})
export class OutboxModule {}
