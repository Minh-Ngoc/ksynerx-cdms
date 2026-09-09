import type { AddressInfo } from 'node:net';

import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue } from 'bullmq';
import ExcelJS from 'exceljs';
import { DataSource } from 'typeorm';

import { createValidationPipe } from '../common/http/api-error.js';
import { AppConfigService } from '../config/app-config.service.js';
import { validateEnvironment } from '../config/env.validation.js';
import { createAppDataSourceFromEnvironment } from '../database/data-source.js';
import { AppModule } from '../app.module.js';
import { WorkerModule } from '../worker.module.js';
import type { CanonicalProductPayload } from '../modules/changes/product-change-contract.js';
import type { ImportStatusResponse } from '../modules/imports/dto/import-contracts.js';
import { OutboxPublisherService } from '../modules/outbox/outbox-publisher.service.js';
import { QUEUE_NAMES } from '../modules/queue/queue.constants.js';
import { createDemoScenario, DemoExcelRow, DemoSourceProduct } from './demo-data.js';

const DEMO_QUEUE_JOB_STATUSES = ['waiting', 'delayed', 'failed', 'completed', 'prioritized'] as const;
const DRAIN_TIMEOUT_MS = 60_000;
const DRAIN_POLL_MS = 100;

export interface DemoRuntime {
  api: INestApplication;
  worker: INestApplicationContext;
  dataSource: DataSource;
  baseUrl: string;
  queues: Array<Queue>;
}

export interface DemoCounts {
  inventory: number;
  states: number;
  changes: number;
  outbox: number;
  imports: number;
}

export async function createDemoRuntime(): Promise<DemoRuntime> {
  process.env.INVENTORY_SEED_COUNT = '0';
  process.env.POLL_INTERVAL_MS = String(2_147_483_647);

  const api = await NestFactory.create(AppModule, { logger: false });
  api.useGlobalPipes(createValidationPipe());
  await api.listen(0, '127.0.0.1');

  const address = api.getHttpServer().address() as AddressInfo | null;
  if (address === null || typeof address === 'string') throw new Error('Demo API did not expose a TCP address');

  const dataSource = api.get(DataSource);
  const worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  const appConfig = api.get(AppConfigService);
  const queues = createDemoQueues(appConfig.redis.host, appConfig.redis.port);

  return { api, worker, dataSource, baseUrl: `http://127.0.0.1:${address.port}`, queues };
}

export async function closeDemoRuntime(runtime: DemoRuntime): Promise<void> {
  await Promise.all(runtime.queues.map((queue) => queue.close()));
  await runtime.worker.close();
  await runtime.api.close();
}

export async function openStandaloneDataSource(): Promise<DataSource> {
  const dataSource = createAppDataSourceFromEnvironment();
  await dataSource.initialize();
  return dataSource;
}

export function createStandaloneDemoQueues(): Array<Queue> {
  const environment = validateEnvironment(process.env);
  return createDemoQueues(environment.REDIS_HOST, environment.REDIS_PORT);
}

/**
 * Deletes only demo rows and demo-named import jobs. This is intentionally SQL cleanup rather than
 * a global truncate so a demo run cannot erase a user's unrelated prototype data.
 */
export async function cleanDemoData(dataSource: DataSource): Promise<DemoCounts> {
  await dataSource.transaction(async (manager) => {
    await manager.query(
      `DELETE FROM import_batch_accounting WHERE import_id IN (SELECT id FROM import_jobs WHERE filename LIKE 'demo-%')`,
    );
    await manager.query(`DELETE FROM import_jobs WHERE filename LIKE 'demo-%'`);
    await manager.query(`DELETE FROM outbox_events WHERE aggregate_id LIKE 'demo-%'`);
    await manager.query(`DELETE FROM product_changes WHERE product_id LIKE 'demo-%'`);
    await manager.query(`DELETE FROM product_state WHERE product_id LIKE 'demo-%'`);
    await manager.query(`DELETE FROM inventory_products WHERE id LIKE 'demo-%' OR sku LIKE 'DEMO-%'`);
  });

  return getDemoCounts(dataSource);
}

export async function removePendingDemoJobs(queues: readonly Queue[]): Promise<void> {
  for (const queue of queues) {
    const jobs = await queue.getJobs([...DEMO_QUEUE_JOB_STATUSES], 0, -1, true);
    for (const job of jobs) {
      if (JSON.stringify(job.data).includes('demo-')) await job.remove();
    }
  }
}

/**
 * Drains all three queues while explicitly asking the real outbox publisher to publish pending
 * rows. The bounded polling observes durable queue state; it is not a correctness sleep.
 */
export async function waitForRuntimeDrain(runtime: DemoRuntime): Promise<void> {
  const publisher = runtime.worker.get(OutboxPublisherService);
  const startedAt = Date.now();

  while (Date.now() - startedAt < DRAIN_TIMEOUT_MS) {
    await publisher.publishBatch();
    const counts = await Promise.all(runtime.queues.map((queue) => queue.getJobCounts(...DEMO_QUEUE_JOB_STATUSES)));
    const pendingOutbox = await countPendingOutbox(runtime.dataSource);
    const queueWork = counts.some((count) =>
      ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'].some((key) => Number(count[key] ?? 0) > 0),
    );

    if (!queueWork && pendingOutbox === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
  }

  throw new Error(`Demo queues did not drain within ${DRAIN_TIMEOUT_MS}ms`);
}

export async function insertDemoSourceProducts(
  dataSource: DataSource,
  products: readonly DemoSourceProduct[],
  updatedAt: Date,
): Promise<void> {
  // This writes only the emulator's source inventory table, matching InventoryService.seedIfNeeded's
  // source-row shape. All CDMS business tables are populated later through polling, webhook, or import queues.
  await dataSource.transaction(async (manager) => {
    for (const [index, product] of products.entries()) {
      const timestamp = new Date(updatedAt.getTime() + index);
      await manager.query(
        `
          INSERT INTO inventory_products (id, sku, name, price, quantity, version, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
        `,
        [product.id, product.sku, product.name, product.price, product.quantity, product.version, timestamp],
      );
    }
  });
}

export async function uploadWorkbook(baseUrl: string, filename: string, rows: readonly DemoExcelRow[], malformed = false): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products');
  sheet.addRow(['productId', 'version', 'sku', 'name', 'price', 'quantity', 'observedAt']);
  for (const row of rows) sheet.addRow([row.productId, row.version, row.sku, row.name, row.price, row.quantity, row.observedAt]);
  if (malformed) {
    const first = rows[0];
    if (first === undefined) throw new Error('Malformed workbook requires at least one valid row');
    sheet.addRow([first.productId, first.version, first.sku, first.name, 'not-a-price', first.quantity, first.observedAt]);
    sheet.addRow([first.productId, first.version, first.sku, first.name, first.price, 'not-an-integer', first.observedAt]);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
  const response = await fetch(`${baseUrl}/imports/products`, { method: 'POST', body: form });
  const body = await readResponseBody(response);
  if (!response.ok) throw new Error(`Workbook upload failed (${response.status}): ${JSON.stringify(body)}`);
  return String((body as { importId: string }).importId);
}

export async function waitForImport(baseUrl: string, importId: string): Promise<ImportStatusResponse> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DRAIN_TIMEOUT_MS) {
    const response = await fetch(`${baseUrl}/imports/${importId}`);
    const body = (await readResponseBody(response)) as ImportStatusResponse;
    if (!response.ok) throw new Error(`Import status failed (${response.status}): ${JSON.stringify(body)}`);
    if (body.status === 'COMPLETED' || body.status === 'FAILED') return body;
    await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
  }
  throw new Error(`Import ${importId} did not reach a terminal state within ${DRAIN_TIMEOUT_MS}ms`);
}

export async function requestJson<T>(baseUrl: string, path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  });
  const body = await readResponseBody(response);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(body)}`);
  return body as T;
}

export function evolvePayload(payload: CanonicalProductPayload, version: number): CanonicalProductPayload {
  const cents = Math.round(Number(payload.price) * 100) + version * 37;
  return {
    sku: payload.sku,
    name: `${payload.name} v${version}`,
    price: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`,
    quantity: payload.quantity + version * 11,
  };
}

export async function getDemoCounts(dataSource: DataSource): Promise<DemoCounts> {
  const [inventory, states, changes, outbox, imports] = await Promise.all([
    count(dataSource, `SELECT count(*)::int AS count FROM inventory_products WHERE id LIKE 'demo-%'`),
    count(dataSource, `SELECT count(*)::int AS count FROM product_state WHERE product_id LIKE 'demo-%'`),
    count(dataSource, `SELECT count(*)::int AS count FROM product_changes WHERE product_id LIKE 'demo-%'`),
    count(dataSource, `SELECT count(*)::int AS count FROM outbox_events WHERE aggregate_id LIKE 'demo-%'`),
    count(dataSource, `SELECT count(*)::int AS count FROM import_jobs WHERE filename LIKE 'demo-%'`),
  ]);
  return { inventory, states, changes, outbox, imports };
}

export function scenarioFromEnvironment() {
  const raw = process.env.DEMO_SEED;
  const seed = raw === undefined ? undefined : Number(raw);
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0)) throw new Error('DEMO_SEED must be a non-negative integer');
  return createDemoScenario(seed);
}

async function count(dataSource: DataSource, sql: string): Promise<number> {
  const [row] = (await dataSource.query(sql)) as Array<{ count: number }>;
  return Number(row?.count ?? 0);
}

async function countPendingOutbox(dataSource: DataSource): Promise<number> {
  return count(dataSource, `SELECT count(*)::int AS count FROM outbox_events WHERE status = 'PENDING'`);
}

function createDemoQueues(host: string, port: number): Array<Queue> {
  return Object.values(QUEUE_NAMES).map(
    (name) =>
      new Queue(name, {
        connection: {
          host,
          port,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectTimeout: 500,
          retryStrategy: () => null,
        },
      }),
  );
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
