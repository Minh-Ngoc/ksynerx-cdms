import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EnvironmentConfig } from './env.validation.js';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService<EnvironmentConfig, true>) {}

  get api() {
    return {
      port: this.configService.get('PORT', { infer: true }),
    };
  }

  get database() {
    return {
      host: this.configService.get('DATABASE_HOST', { infer: true }),
      port: this.configService.get('DATABASE_PORT', { infer: true }),
      name: this.configService.get('DATABASE_NAME', { infer: true }),
      user: this.configService.get('DATABASE_USER', { infer: true }),
      password: this.configService.get('DATABASE_PASSWORD', { infer: true }),
    };
  }

  get redis() {
    return {
      host: this.configService.get('REDIS_HOST', { infer: true }),
      port: this.configService.get('REDIS_PORT', { infer: true }),
    };
  }

  get polling() {
    return {
      intervalMs: this.configService.get('POLL_INTERVAL_MS', { infer: true }),
    };
  }

  get inventory() {
    return {
      seedCount: this.configService.get('INVENTORY_SEED_COUNT', { infer: true }),
    };
  }

  get imports() {
    return {
      batchSize: this.configService.get('IMPORT_BATCH_SIZE', { infer: true }),
      maxPendingBatches: this.configService.get('IMPORT_MAX_PENDING_BATCHES', { infer: true }),
      maxFileSizeMb: this.configService.get('IMPORT_MAX_FILE_SIZE_MB', { infer: true }),
      redisRetryTimeoutMs: this.configService.get('IMPORT_REDIS_RETRY_TIMEOUT_MS', { infer: true }),
    };
  }

  get worker() {
    return {
      changeConcurrency: this.configService.get('CHANGE_WORKER_CONCURRENCY', { infer: true }),
    };
  }

  get outbox() {
    return {
      batchSize: this.configService.get('OUTBOX_BATCH_SIZE', { infer: true }),
      pollIntervalMs: this.configService.get('OUTBOX_POLL_INTERVAL_MS', { infer: true }),
    };
  }
}
