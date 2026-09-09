import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import { AppConfigService } from '../../config/app-config.service.js';

@Injectable()
export class RedisHealthProbe implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(config: AppConfigService) {
    this.redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
      retryStrategy: () => null,
    });
    this.redis.on('error', () => undefined);
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  async ping(): Promise<void> {
    if (this.redis.status === 'wait') await this.redis.connect();
    const reply = await this.redis.ping();
    if (reply !== 'PONG') throw new Error('Redis health probe received an unexpected reply');
  }
}
