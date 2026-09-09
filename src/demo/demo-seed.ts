import { cleanDemoData, closeDemoRuntime, createDemoRuntime, evolvePayload, getDemoCounts, insertDemoSourceProducts, removePendingDemoJobs, requestJson, scenarioFromEnvironment, uploadWorkbook, waitForImport, waitForRuntimeDrain } from './demo-runtime.js';
import type { InventoryProductResponse } from '../modules/inventory/dto/inventory-contracts.js';
import type { CanonicalProductPayload } from '../modules/changes/product-change-contract.js';
import { PollingService } from '../modules/ingestion/polling/polling.service.js';

const scenario = scenarioFromEnvironment();
const runtime = await createDemoRuntime();

try {
  await cleanDemoData(runtime.dataSource);
  await removePendingDemoJobs(runtime.queues);

  const pollingProducts = scenario.sourceProducts.slice(0, 15);
  const passiveProducts = scenario.sourceProducts.slice(15);
  await insertDemoSourceProducts(runtime.dataSource, pollingProducts, new Date());

  const pollingService = runtime.api.get(PollingService);
  await pollingService.pollOnce();
  await waitForRuntimeDrain(runtime);

  for (const [index, product] of pollingProducts.slice(0, 5).entries()) {
    await requestJson<InventoryProductResponse>(runtime.baseUrl, `/inventory/products/${product.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...evolvePayload(product, 2), quantity: product.quantity + (index + 1) * 13 }),
    });
  }
  await pollingService.pollOnce();
  await waitForRuntimeDrain(runtime);

  for (const [index, product] of pollingProducts.slice(0, 3).entries()) {
    await requestJson<InventoryProductResponse>(runtime.baseUrl, `/inventory/products/${product.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...evolvePayload(product, 3), quantity: product.quantity + (index + 1) * 17 }),
    });
  }
  await pollingService.pollOnce();
  await waitForRuntimeDrain(runtime);

  await insertDemoSourceProducts(runtime.dataSource, passiveProducts, new Date('2025-01-01T00:00:00.000Z'));

  const crossSourceProduct = pollingProducts[14];
  if (crossSourceProduct === undefined) throw new Error('Missing cross-source polling product');
  await sendWebhook(runtime.baseUrl, crossSourceProduct.id, 1, crossSourceProduct);
  let webhookAttempts = 1;
  await waitForRuntimeDrain(runtime);

  for (const product of scenario.webhookProducts) {
    await sendWebhook(runtime.baseUrl, product.productId, 1, product.payload);
    webhookAttempts += 1;
  }
  await waitForRuntimeDrain(runtime);

  for (const product of scenario.webhookProducts.slice(0, 5)) {
    await sendWebhook(runtime.baseUrl, product.productId, 2, evolvePayload(product.payload, 2));
    webhookAttempts += 1;
  }
  await waitForRuntimeDrain(runtime);

  for (const product of scenario.webhookProducts.slice(0, 3)) {
    await sendWebhook(runtime.baseUrl, product.productId, 3, evolvePayload(product.payload, 3));
    webhookAttempts += 1;
  }
  await waitForRuntimeDrain(runtime);

  for (const productId of scenario.replayProductIds) {
    const product = scenario.webhookProducts.find((candidate) => candidate.productId === productId);
    if (product === undefined) throw new Error(`Missing replay product ${productId}`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sendWebhook(runtime.baseUrl, product.productId, 1, product.payload);
      webhookAttempts += 1;
    }
  }
  await waitForRuntimeDrain(runtime);

  for (const productId of scenario.staleProductIds) {
    const product = scenario.webhookProducts.find((candidate) => candidate.productId === productId);
    if (product === undefined) throw new Error(`Missing stale product ${productId}`);
    await sendWebhook(runtime.baseUrl, product.productId, 1, product.payload);
    webhookAttempts += 1;
  }
  await waitForRuntimeDrain(runtime);

  for (const productId of scenario.conflictProductIds) {
    const product = scenario.webhookProducts.find((candidate) => candidate.productId === productId);
    if (product === undefined) throw new Error(`Missing conflict product ${productId}`);
    await sendWebhook(runtime.baseUrl, product.productId, 3, { ...evolvePayload(product.payload, 3), sku: `${product.payload.sku}-CONFLICT` });
    webhookAttempts += 1;
  }
  await waitForRuntimeDrain(runtime);

  const validImportId = await uploadWorkbook(runtime.baseUrl, 'demo-products-valid.xlsx', scenario.validExcelRows);
  const validImport = await waitForImport(runtime.baseUrl, validImportId);
  const partialImportId = await uploadWorkbook(runtime.baseUrl, 'demo-products-partial.xlsx', scenario.partialExcelRows, true);
  const partialImport = await waitForImport(runtime.baseUrl, partialImportId);
  await waitForRuntimeDrain(runtime);

  const counts = await getDemoCounts(runtime.dataSource);
  console.log(JSON.stringify({
    seed: scenario.seed,
    sourceInventory: counts.inventory,
    polling: { products: 15, versions: '15 x v1, 5 x v2, 3 x v3' },
    webhook: { products: 10, attempts: webhookAttempts },
    crossSource: { productId: crossSourceProduct.id, sources: ['POLLING', 'WEBHOOK', 'EXCEL'], persistedHistoryRows: 1 },
    excel: {
      valid: { importId: validImportId, rowsRead: validImport.rowsRead, rowsSucceeded: validImport.rowsSucceeded, rowsFailed: validImport.rowsFailed },
      partial: { importId: partialImportId, rowsRead: partialImport.rowsRead, rowsSucceeded: partialImport.rowsSucceeded, rowsFailed: partialImport.rowsFailed },
    },
    cdms: counts,
  }, null, 2));
} finally {
  await closeDemoRuntime(runtime);
}

async function sendWebhook(baseUrl: string, productId: string, version: number, payload: CanonicalProductPayload): Promise<void> {
  const canonicalPayload = { sku: payload.sku, name: payload.name, price: payload.price, quantity: payload.quantity };
  await requestJson(baseUrl, '/webhooks/inventory', {
    method: 'POST',
    body: JSON.stringify({ productId, version, payload: canonicalPayload, observedAt: '2026-09-10T03:00:00.000Z' }),
  });
}
