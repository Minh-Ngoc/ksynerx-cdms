import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module.js';
import { InventorySeedService } from '../src/modules/inventory/inventory-seed.service.js';
import { RedisHealthProbe } from '../src/modules/health/redis-health.probe.js';

describe('dependency health endpoint (e2e)', () => {
  it('returns 200 only when both required dependencies are available', async () => {
    const app = await createApp();
    try {
      await request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect({ status: 'ok', dependencies: { postgres: 'up', redis: 'up' } });
    } finally {
      await app.close();
    }
  });

  it.each([
    ['PostgreSQL is unavailable', new Error('postgres password=secret'), undefined, { postgres: 'down', redis: 'up' }],
    ['Redis is unavailable', undefined, new Error('redis://token@host'), { postgres: 'up', redis: 'down' }],
    ['both dependencies are unavailable', new Error('postgres password=secret'), new Error('redis token=secret'), { postgres: 'down', redis: 'down' }],
  ])('returns 503 with a deterministic shape when %s', async (_name, postgresFailure, redisFailure, dependencies) => {
    const app = await createApp(postgresFailure, redisFailure);
    try {
      await request(app.getHttpServer())
        .get('/health')
        .expect(503)
        .expect({ status: 'error', dependencies });
    } finally {
      await app.close();
    }
  });
});

async function createApp(postgresFailure?: Error, redisFailure?: Error): Promise<INestApplication> {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DataSource)
    .useValue({
      query: async () => {
        if (postgresFailure) throw postgresFailure;
        return [{ '?column?': 1 }];
      },
      isInitialized: false,
      manager: {},
    })
    .overrideProvider(RedisHealthProbe)
    .useValue({
      ping: async () => {
        if (redisFailure) throw redisFailure;
      },
      onModuleDestroy: () => undefined,
    })
    .overrideProvider(InventorySeedService)
    .useValue({ onApplicationBootstrap: async () => undefined })
    .compile();

  const app = module.createNestApplication();
  await app.init();
  return app;
}
