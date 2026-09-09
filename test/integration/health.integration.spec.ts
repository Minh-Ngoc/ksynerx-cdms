import { DataSource } from 'typeorm';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppConfigService } from '../../src/config/app-config.service.js';
import { createAppDataSourceFromEnvironment } from '../../src/database/data-source.js';
import { AppModule } from '../../src/app.module.js';
import { HealthService } from '../../src/modules/health/health.service.js';
import { RedisHealthProbe } from '../../src/modules/health/redis-health.probe.js';
import { InventorySeedService } from '../../src/modules/inventory/inventory-seed.service.js';

describe('health dependency probes (integration)', () => {
  let dataSource: DataSource;
  let redis: RedisHealthProbe;

  beforeAll(async () => {
    dataSource = createAppDataSourceFromEnvironment(process.env);
    await dataSource.initialize();
    redis = new RedisHealthProbe({
      redis: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    } as AppConfigService);
  });

  afterAll(async () => {
    redis.onModuleDestroy();
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('reports up only after real PostgreSQL SELECT 1 and Redis PING probes succeed', async () => {
    await expect(new HealthService(dataSource, redis).check()).resolves.toEqual({
      status: 'ok',
      dependencies: { postgres: 'up', redis: 'up' },
    });
  });

  it('returns the real required-dependency state through GET /health', async () => {
    await dataSource.dropDatabase();
    await dataSource.runMigrations();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(InventorySeedService)
      .useValue({ onApplicationBootstrap: async () => undefined })
      .compile();
    const app: INestApplication = module.createNestApplication();
    await app.init();

    try {
      await request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect({ status: 'ok', dependencies: { postgres: 'up', redis: 'up' } });
    } finally {
      await app.close();
    }
  });
});
