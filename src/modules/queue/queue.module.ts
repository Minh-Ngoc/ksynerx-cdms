import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { AppConfigService } from '../../config/app-config.service.js';
import { AppConfigModule } from '../../config/config.module.js';
import { ChangeQueueProducer } from './change-queue.producer.js';
import { ImportBatchQueueProducer } from './import-batch-queue.producer.js';
import { OutboxDownstreamQueueProducer } from './outbox-downstream-queue.producer.js';
import { QUEUE_NAMES } from './queue.constants.js';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        connection: {
          host: config.redis.host,
          port: config.redis.port,
          // Ingress must fail instead of buffering locally when Redis is down; otherwise HTTP
          // could hang or appear accepted before BullMQ durably owns the job.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectTimeout: 500,
          retryStrategy: () => null,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.change },
      { name: QUEUE_NAMES.importBatch },
      { name: QUEUE_NAMES.downstream },
    ),
  ],
  providers: [ChangeQueueProducer, ImportBatchQueueProducer, OutboxDownstreamQueueProducer],
  exports: [BullModule, ChangeQueueProducer, ImportBatchQueueProducer, OutboxDownstreamQueueProducer],
})
export class QueueModule {}
