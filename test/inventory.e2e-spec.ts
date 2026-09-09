import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/http/api-error.js';
import { AppConfigService } from '../src/config/app-config.service.js';
import { createAppDataSourceFromEnvironment } from '../src/database/data-source.js';

describe('Inventory emulator (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = createAppDataSourceFromEnvironment(process.env);
    await dataSource.initialize();
    await dataSource.dropDatabase();
    await dataSource.runMigrations();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AppConfigService)
      .useValue({
        api: { port: 3000 },
        database: {
          host: process.env.DATABASE_HOST ?? 'localhost',
          port: Number(process.env.DATABASE_PORT ?? 5432),
          name: process.env.DATABASE_NAME ?? 'cdms',
          user: process.env.DATABASE_USER ?? 'cdms',
          password: process.env.DATABASE_PASSWORD ?? 'cdms_demo_password',
        },
        redis: { host: 'localhost', port: 6379 },
        polling: { intervalMs: 5000 },
        inventory: {
          seedCount: 0,
        },
        imports: { batchSize: 500, maxPendingBatches: 100, maxFileSizeMb: 100, redisRetryTimeoutMs: 30000 },
        worker: { changeConcurrency: 10 },
        outbox: { batchSize: 100, pollIntervalMs: 1000 },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('creates, reads, updates, and lists products through the public contract', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/inventory/products')
      .send({ sku: 'SKU-E2E', name: 'E2E Product', price: '100.00', quantity: 3 })
      .expect(201);

    expect(createResponse.body).toMatchObject({
      sku: 'SKU-E2E',
      name: 'E2E Product',
      price: '100.00',
      quantity: 3,
      version: 1,
    });

    const productId = createResponse.body.id as string;

    await request(app.getHttpServer()).get(`/inventory/products/${productId}`).expect(200).expect(createResponse.body);

    const patchResponse = await request(app.getHttpServer())
      .patch(`/inventory/products/${productId}`)
      .send({ price: '100.10' })
      .expect(200);

    expect(patchResponse.body).toMatchObject({
      id: productId,
      sku: 'SKU-E2E',
      price: '100.10',
      version: 2,
    });

    const listResponse = await request(app.getHttpServer()).get('/inventory/products').expect(200);
    expect(listResponse.body).toHaveLength(1);
    expect(listResponse.body[0]).toMatchObject({ id: productId, version: 2 });
  });

  it('returns stable boundary errors for validation, missing products, and duplicate SKUs', async () => {
    await request(app.getHttpServer()).patch('/inventory/products/missing').send({}).expect(400);

    await request(app.getHttpServer()).get('/inventory/products/missing').expect(404).expect({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Inventory product not found',
    });

    await request(app.getHttpServer())
      .post('/inventory/products')
      .send({ sku: 'SKU-DUP-E2E', name: 'First', price: '1.00', quantity: 1 })
      .expect(201);

    await request(app.getHttpServer())
      .post('/inventory/products')
      .send({ sku: 'SKU-DUP-E2E', name: 'Second', price: '2.00', quantity: 2 })
      .expect(409)
      .expect({
        statusCode: 409,
        code: 'CONFLICT',
        message: 'Inventory product SKU already exists',
      });
  });
});
