import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from './../src/app.module.js';
import { InventorySeedService } from '../src/modules/inventory/inventory-seed.service.js';

describe('AppModule (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const dataSource = {
      isInitialized: false,
      manager: {},
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DataSource)
      .useValue(dataSource)
      .overrideProvider(InventorySeedService)
      .useValue({ onApplicationBootstrap: async () => undefined })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('starts the HTTP application', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(404);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });
});
