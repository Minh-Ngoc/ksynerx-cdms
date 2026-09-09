import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/config.module.js';
import { InventoryController } from './inventory.controller.js';
import { InventorySeedService } from './inventory-seed.service.js';
import { InventoryService } from './inventory.service.js';

@Module({
  imports: [AppConfigModule],
  controllers: [InventoryController],
  providers: [InventoryService, InventorySeedService],
  exports: [InventoryService],
})
export class InventoryModule {}
