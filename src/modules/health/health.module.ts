import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/config.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { RedisHealthProbe } from './redis-health.probe.js';

@Module({
  imports: [AppConfigModule, DatabaseModule],
  controllers: [HealthController],
  providers: [HealthService, RedisHealthProbe],
})
export class HealthModule {}
