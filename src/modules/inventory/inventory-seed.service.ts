import { Injectable, OnApplicationBootstrap } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service.js';
import { InventoryService } from './inventory.service.js';

@Injectable()
export class InventorySeedService implements OnApplicationBootstrap {
  constructor(
    private readonly appConfig: AppConfigService,
    private readonly inventoryService: InventoryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.inventoryService.seedIfNeeded(this.appConfig.inventory.seedCount);
  }
}
