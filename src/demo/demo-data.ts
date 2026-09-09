import { faker } from '@faker-js/faker';

import type { CanonicalProductPayload } from '../modules/changes/product-change-contract.js';
import { REQUIRED_IMPORT_HEADERS } from '../modules/imports/import-streaming.contract.js';

export const DEMO_NAMESPACE = 'demo-';
export const DEFAULT_DEMO_SEED = 20260910;
export const DEMO_SOURCE_PRODUCT_COUNT = 50;
export const DEMO_POLLING_PRODUCT_COUNT = 15;

export const DEMO_EXCEL_HEADERS = REQUIRED_IMPORT_HEADERS;

export interface DemoSourceProduct extends CanonicalProductPayload {
  id: string;
  version: 1;
}

export interface DemoExcelRow extends CanonicalProductPayload {
  productId: string;
  version: number;
  observedAt: string;
}

export interface DemoScenarioManifest {
  seed: number;
  sourceProducts: DemoSourceProduct[];
  pollingProductIds: string[];
  webhookProducts: Array<{ productId: string; payload: CanonicalProductPayload }>;
  validExcelRows: DemoExcelRow[];
  partialExcelRows: DemoExcelRow[];
  replayProductIds: string[];
  staleProductIds: string[];
  conflictProductIds: string[];
}

/**
 * Generates the complete demo contract from one seed. The ids are intentionally stable and
 * namespaced so cleanup and verification can never target unrelated product data.
 */
export function createDemoScenario(seed = DEFAULT_DEMO_SEED): DemoScenarioManifest {
  const sourceProducts = generateDemoSourceProducts(seed);
  const webhookProducts = Array.from({ length: 10 }, (_, index) => {
    const ordinal = index + 1;
    return {
      productId: `demo-webhook-${pad(ordinal, 3)}`,
      payload: generateDemoPayload(seed, 'WEBHOOK', ordinal),
    };
  });
  const replayProductIds = webhookProducts.slice(0, 5).map(({ productId }) => productId);
  const staleProductIds = webhookProducts.slice(0, 5).map(({ productId }) => productId);
  const conflictProductIds = webhookProducts.slice(0, 3).map(({ productId }) => productId);
  const crossSource = sourceProducts[DEMO_POLLING_PRODUCT_COUNT - 1];

  if (crossSource === undefined) {
    throw new Error('Demo scenario requires a cross-source polling product');
  }

  const validExcelRows: DemoExcelRow[] = [
    toExcelRow(crossSource.id, crossSource, '2026-09-10T01:00:00.000Z'),
    ...Array.from({ length: 5 }, (_, index) => {
      const ordinal = index + 1;
      return toExcelRow(
        `demo-excel-${pad(ordinal, 3)}`,
        { ...generateDemoPayload(seed, 'EXCEL', ordinal), version: 1 },
        '2026-09-10T01:00:00.000Z',
      );
    }),
    ...replayProductIds.map((productId) => {
      const webhook = webhookProducts.find((product) => product.productId === productId);
      if (webhook === undefined) throw new Error(`Missing webhook replay product ${productId}`);
      return toExcelRow(productId, { ...webhook.payload, version: 1 }, '2026-09-10T01:00:00.000Z');
    }),
  ];

  const partialExcelRows = Array.from({ length: 8 }, (_, index) => {
    const ordinal = index + 1;
    return toExcelRow(
      `demo-excel-partial-${pad(ordinal, 3)}`,
      { ...generateDemoPayload(seed, 'PARTIAL', ordinal), version: 1 },
      '2026-09-10T02:00:00.000Z',
    );
  });

  return {
    seed,
    sourceProducts,
    pollingProductIds: sourceProducts.slice(0, DEMO_POLLING_PRODUCT_COUNT).map(({ id }) => id),
    webhookProducts,
    validExcelRows,
    partialExcelRows,
    replayProductIds,
    staleProductIds,
    conflictProductIds,
  };
}

export function generateDemoSourceProducts(seed = DEFAULT_DEMO_SEED): DemoSourceProduct[] {
  faker.seed(seed);

  return Array.from({ length: DEMO_SOURCE_PRODUCT_COUNT }, (_, index) => {
    const ordinal = index + 1;
    const isPollingProduct = ordinal <= DEMO_POLLING_PRODUCT_COUNT;
    const family = isPollingProduct ? 'poll' : 'inventory';

    return {
      id: `demo-${family}-${pad(ordinal, 3)}`,
      sku: `DEMO-${family.toUpperCase()}-${pad(ordinal, 3)}`,
      name: `${faker.commerce.productName()} ${ordinal}`,
      price: formatDemoPrice(499 + ((ordinal * 137 + faker.number.int({ min: 0, max: 9000 })) % 250000)),
      quantity: demoQuantity(ordinal),
      version: 1,
    };
  });
}

export function generateDemoPayload(seed: number, family: string, ordinal: number): CanonicalProductPayload {
  const familySeed = [...family].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  faker.seed(seed + familySeed * 100 + ordinal);

  return {
    sku: `DEMO-${family}-${pad(ordinal, 3)}`,
    name: `${faker.commerce.productName()} ${family.toLowerCase()} ${ordinal}`,
    price: formatDemoPrice(999 + faker.number.int({ min: 0, max: 150000 })),
    quantity: demoQuantity(ordinal + familySeed),
  };
}

export function formatDemoPrice(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error('Demo price cents must be a non-negative integer');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function demoQuantity(ordinal: number): number {
  const position = Math.abs(ordinal) % 10;
  if (position === 0) return 0;
  if (position <= 2) return 1 + position * 5;
  if (position <= 7) return 40 + position * 17;
  return 250 + position * 23;
}

function toExcelRow(productId: string, product: CanonicalProductPayload & { version: number }, observedAt: string): DemoExcelRow {
  return { productId, ...product, observedAt };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}
