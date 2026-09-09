import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { AppConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { IngestionModule } from './modules/ingestion/ingestion.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { ImportsModule } from './modules/imports/imports.module.js';
import { QueueModule } from './modules/queue/queue.module.js';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AppConfigModule,
    DatabaseModule,
    InventoryModule,
    QueueModule,
    IngestionModule,
    ImportsModule,
    HealthModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
