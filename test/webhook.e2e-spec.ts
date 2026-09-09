import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/http/api-error.js';
import { createAppDataSourceFromEnvironment } from '../src/database/data-source.js';
import { InventorySeedService } from '../src/modules/inventory/inventory-seed.service.js';
import { ChangeQueueProducer } from '../src/modules/queue/change-queue.producer.js';

describe('Inventory webhook ingestion (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let enqueued: unknown[];

  beforeEach(async () => {
    enqueued = [];
    dataSource = createAppDataSourceFromEnvironment(process.env);
    await dataSource.initialize();
    await dataSource.dropDatabase();
    await dataSource.runMigrations();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(InventorySeedService)
      .useValue({ onApplicationBootstrap: async () => undefined })
      .overrideProvider(ChangeQueueProducer)
      .useValue({
        enqueueChange: async (input: unknown) => {
          enqueued.push(input);
          return { id: 'job-webhook' };
        },
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
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('returns 202 after enqueue and does not write business tables directly', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/inventory')
      .send(validWebhook())
      .expect(202)
      .expect({ status: 'ACCEPTED' });

    expect(enqueued).toHaveLength(1);

    const [counts] = await dataSource.query(
      `
        SELECT
          (SELECT count(*)::int FROM product_state) AS product_state,
          (SELECT count(*)::int FROM product_changes) AS product_changes,
          (SELECT count(*)::int FROM outbox_events) AS outbox_events
      `,
    );

    expect(counts).toEqual({
      product_state: 0,
      product_changes: 0,
      outbox_events: 0,
    });
  });

  it.each([
    ['version <= 0', { version: 0 }],
    ['invalid decimal', { payload: { ...validWebhook().payload, price: '0.001' } }],
    ['malformed observedAt', { observedAt: 'not-a-date' }],
    ['unexpected source field', { source: 'WEBHOOK' }],
  ])('returns 400 VALIDATION_ERROR for %s', async (_caseName, override) => {
    await request(app.getHttpServer())
      .post('/webhooks/inventory')
      .send({ ...validWebhook(), ...override })
      .expect(400)
      .expect((response) => {
        expect(response.body.statusCode).toBe(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
      });

    expect(enqueued).toHaveLength(0);
  });

  it('returns 503 when enqueue fails and does not produce a false 202', async () => {
    await app.close();

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(InventorySeedService)
      .useValue({ onApplicationBootstrap: async () => undefined })
      .overrideProvider(ChangeQueueProducer)
      .useValue({
        enqueueChange: async () => {
          throw new Error('redis unavailable');
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.init();

    await request(app.getHttpServer())
      .post('/webhooks/inventory')
      .send(validWebhook())
      .expect(503)
      .expect({
        statusCode: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Inventory webhook could not be accepted for asynchronous processing',
      });
  });
});

function validWebhook() {
  return {
    productId: 'product-webhook',
    version: 1,
    payload: {
      sku: 'SKU-WEBHOOK',
      name: 'Webhook Product',
      price: '12.34',
      quantity: 5,
    },
    observedAt: '2026-01-02T03:04:05.678Z',
  };
}
