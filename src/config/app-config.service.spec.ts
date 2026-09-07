import { ConfigService } from '@nestjs/config';

import { AppConfigService } from './app-config.service.js';
import { EnvironmentConfig, validateEnvironment } from './env.validation.js';

describe('AppConfigService', () => {
  it('exposes typed grouped configuration for future API and worker modules', () => {
    const environment = validateEnvironment({
      PORT: '3001',
      CHANGE_WORKER_CONCURRENCY: '12',
      OUTBOX_BATCH_SIZE: '25',
    });
    const service = new AppConfigService(new ConfigService<EnvironmentConfig, true>(environment));

    expect(service.api.port).toBe(3001);
    expect(service.worker.changeConcurrency).toBe(12);
    expect(service.outbox.batchSize).toBe(25);
    expect(service.imports.batchSize).toBe(500);
  });
});
