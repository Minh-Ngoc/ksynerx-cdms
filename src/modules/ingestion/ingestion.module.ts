import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/config.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { ChangeQueueProducer } from '../queue/change-queue.producer.js';
import { QueueModule } from '../queue/queue.module.js';
import { PollingCheckpointRepository } from './polling/polling-checkpoint.repository.js';
import { PollingScheduler } from './polling/polling.scheduler.js';
import { PollingService } from './polling/polling.service.js';
import { InventoryWebhookController } from './webhook.controller.js';
import { WebhookIngestionService } from './webhook-ingestion.service.js';

@Module({
  imports: [AppConfigModule, InventoryModule, QueueModule],
  controllers: [InventoryWebhookController],
  providers: [
    PollingCheckpointRepository,
    PollingScheduler,
    {
      provide: PollingService,
      inject: [InventoryService, PollingCheckpointRepository, ChangeQueueProducer],
      useFactory: (
        inventory: InventoryService,
        checkpoints: PollingCheckpointRepository,
        changeQueueProducer: ChangeQueueProducer,
      ) => PollingService.fromNestDependencies(inventory, checkpoints, changeQueueProducer),
    },
    WebhookIngestionService,
  ],
})
export class IngestionModule {}
