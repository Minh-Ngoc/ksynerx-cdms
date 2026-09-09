import { ChangeSource, ProductChangeInput } from '../../changes/product-change-contract.js';
import { InventoryListQueryDto, InventoryProductResponse } from '../../inventory/dto/inventory-contracts.js';
import {
  INVENTORY_PRODUCTS_CHECKPOINT_NAME,
  InventoryPageReader,
  PollingCheckpointStore,
  PollingCursor,
  PollingService,
} from './polling.service.js';

describe('PollingService composite checkpoint contract', () => {
  it('starts from the beginning when no checkpoint exists and advances only after the first page is fully enqueued', async () => {
    const checkpointStore = fakeCheckpointStore(null);
    const inventory = fakeInventory([inventoryRow('product-a', '2026-09-07T00:00:00.001Z')]);
    const producer = fakeProducer();
    const service = new PollingService(inventory, checkpointStore, producer);

    await expect(service.pollOnce()).resolves.toEqual({ enqueued: 1, checkpointAdvanced: true });

    expect(inventory.queries).toEqual([{}]);
    expect(producer.inputs.map((input) => input.productId)).toEqual(['product-a']);
    expect(checkpointStore.writes).toEqual([
      {
        name: INVENTORY_PRODUCTS_CHECKPOINT_NAME,
        cursor: {
          updatedAt: new Date('2026-09-07T00:00:00.001Z'),
          productId: 'product-a',
        },
      },
    ]);
  });

  it('advances the checkpoint to the final row of a fully successful page', async () => {
    const previous = cursor('2026-09-07T00:00:00.000Z', 'product-0');
    const checkpointStore = fakeCheckpointStore(previous);
    const inventory = fakeInventory([
      inventoryRow('product-a', '2026-09-07T00:00:00.001Z'),
      inventoryRow('product-b', '2026-09-07T00:00:00.002Z'),
      inventoryRow('product-c', '2026-09-07T00:00:00.003Z'),
    ]);
    const producer = fakeProducer();
    const service = new PollingService(inventory, checkpointStore, producer);

    await expect(service.pollOnce()).resolves.toEqual({ enqueued: 3, checkpointAdvanced: true });

    expect(inventory.queries).toEqual([
      {
        updatedAfter: previous.updatedAt.toISOString(),
        afterProductId: previous.productId,
      },
    ]);
    expect(checkpointStore.current).toEqual(cursor('2026-09-07T00:00:00.003Z', 'product-c'));
  });

  it('keeps the old checkpoint when a later item in the fetched page fails to enqueue', async () => {
    const previous = cursor('2026-09-07T00:00:00.000Z', 'product-0');
    const checkpointStore = fakeCheckpointStore(previous);
    const inventory = fakeInventory([
      inventoryRow('product-1', '2026-09-07T00:00:00.001Z'),
      inventoryRow('product-2', '2026-09-07T00:00:00.002Z'),
      inventoryRow('product-3', '2026-09-07T00:00:00.003Z'),
    ]);
    const producer = fakeProducer({ failOnProductId: 'product-3' });
    const service = new PollingService(inventory, checkpointStore, producer);

    await expect(service.pollOnce()).rejects.toThrow('enqueue failed for product-3');

    // Whole-page checkpointing intentionally re-polls product-1/product-2 on retry; duplicates are
    // safer than moving the cursor past product-3 and permanently skipping an unaccepted change.
    expect(checkpointStore.current).toEqual(previous);
    expect(checkpointStore.writes).toEqual([]);
  });

  it('stops on first enqueue failure and leaves the checkpoint unchanged', async () => {
    const previous = cursor('2026-09-07T00:00:00.000Z', 'product-0');
    const checkpointStore = fakeCheckpointStore(previous);
    const inventory = fakeInventory([
      inventoryRow('product-1', '2026-09-07T00:00:00.001Z'),
      inventoryRow('product-2', '2026-09-07T00:00:00.002Z'),
    ]);
    const producer = fakeProducer({ failOnProductId: 'product-1' });
    const service = new PollingService(inventory, checkpointStore, producer);

    await expect(service.pollOnce()).rejects.toThrow('enqueue failed for product-1');

    expect(producer.inputs.map((input) => input.productId)).toEqual(['product-1']);
    expect(checkpointStore.current).toEqual(previous);
  });

  it('uses productId as the same-timestamp tie-breaker in the continuation cursor', async () => {
    const checkpointStore = fakeCheckpointStore(cursor('2026-09-07T00:00:00.123Z', 'product-b'));
    const inventory = fakeInventory([inventoryRow('product-c', '2026-09-07T00:00:00.123Z')]);
    const producer = fakeProducer();
    const service = new PollingService(inventory, checkpointStore, producer);

    await expect(service.pollOnce()).resolves.toEqual({ enqueued: 1, checkpointAdvanced: true });

    // The productId tie-breaker is what lets Task 16 fetch (T, product-c) without re-reading
    // (T, product-a) or (T, product-b), even when all three rows share the same timestamp.
    expect(inventory.queries).toEqual([
      {
        updatedAfter: '2026-09-07T00:00:00.123Z',
        afterProductId: 'product-b',
      },
    ]);
    expect(producer.inputs.map((input) => input.productId)).toEqual(['product-c']);
  });

  it('leaves the checkpoint unchanged when the fetched page is empty', async () => {
    const previous = cursor('2026-09-07T00:00:00.123Z', 'product-b');
    const checkpointStore = fakeCheckpointStore(previous);
    const inventory = fakeInventory([]);
    const producer = fakeProducer();
    const service = new PollingService(inventory, checkpointStore, producer);

    await expect(service.pollOnce()).resolves.toEqual({ enqueued: 0, checkpointAdvanced: false });

    expect(producer.inputs).toEqual([]);
    expect(checkpointStore.current).toEqual(previous);
    expect(checkpointStore.writes).toEqual([]);
  });

  it('propagates inventory read failure without advancing the checkpoint', async () => {
    const previous = cursor('2026-09-07T00:00:00.123Z', 'product-b');
    const checkpointStore = fakeCheckpointStore(previous);
    const inventory = fakeInventoryReadFailure(new Error('inventory unavailable'));
    const producer = fakeProducer();
    const service = new PollingService(inventory, checkpointStore, producer);

    await expect(service.pollOnce()).rejects.toThrow('inventory unavailable');

    expect(producer.inputs).toEqual([]);
    expect(checkpointStore.current).toEqual(previous);
  });

  it('does not compensate already enqueued jobs when checkpoint persistence fails', async () => {
    const previous = cursor('2026-09-07T00:00:00.000Z', 'product-0');
    const checkpointStore = fakeCheckpointStore(previous, { failWrite: true });
    const inventory = fakeInventory([
      inventoryRow('product-1', '2026-09-07T00:00:00.001Z'),
      inventoryRow('product-2', '2026-09-07T00:00:00.002Z'),
    ]);
    const producer = fakeProducer();
    const service = new PollingService(inventory, checkpointStore, producer);

    await expect(service.pollOnce()).rejects.toThrow('checkpoint write failed');

    // Deleting already-enqueued BullMQ jobs would require a distributed transaction with Redis.
    // Task 16 should instead allow duplicate re-poll and rely on ChangeProcessor DB idempotency.
    expect(producer.inputs.map((input) => input.productId)).toEqual(['product-1', 'product-2']);
    expect(checkpointStore.current).toEqual(previous);
  });

  it('progresses page by page and retains the last successful page cursor if a later page fails', async () => {
    const checkpointStore = fakeCheckpointStore(cursor('2026-09-07T00:00:00.000Z', 'product-0'));
    const inventory = fakePagedInventory([
      [inventoryRow('product-1', '2026-09-07T00:00:00.001Z')],
      [inventoryRow('product-2', '2026-09-07T00:00:00.002Z')],
    ]);
    const producer = fakeProducer({ failOnProductId: 'product-2' });
    const service = new PollingService(inventory, checkpointStore, producer);

    await expect(service.pollOnce()).resolves.toEqual({ enqueued: 1, checkpointAdvanced: true });
    await expect(service.pollOnce()).rejects.toThrow('enqueue failed for product-2');

    expect(checkpointStore.current).toEqual(cursor('2026-09-07T00:00:00.001Z', 'product-1'));
  });

  it('normalizes inventory rows into POLLING ProductChangeInput payloads before enqueueing', async () => {
    const checkpointStore = fakeCheckpointStore(null);
    const inventory = fakeInventory([inventoryRow('product-polling', '2026-09-07T00:00:00.001Z')]);
    const producer = fakeProducer();
    const service = new PollingService(inventory, checkpointStore, producer);

    await expect(service.pollOnce()).resolves.toEqual({ enqueued: 1, checkpointAdvanced: true });

    expect(producer.inputs).toEqual([
      {
        productId: 'product-polling',
        version: 7,
        source: ChangeSource.Polling,
        payload: {
          sku: 'SKU-product-polling',
          name: 'Product product-polling',
          price: '12.30',
          quantity: 9,
        },
        observedAt: new Date('2026-09-07T00:00:00.001Z'),
      },
    ]);
  });
});

function fakeCheckpointStore(initial: PollingCursor | null, options: { failWrite?: boolean } = {}) {
  return {
    current: initial,
    writes: [] as Array<{ name: string; cursor: PollingCursor }>,
    async read(_name: string) {
      return this.current;
    },
    async write(name: string, nextCursor: PollingCursor) {
      if (options.failWrite === true) {
        throw new Error('checkpoint write failed');
      }

      this.current = nextCursor;
      this.writes.push({ name, cursor: nextCursor });
    },
  } satisfies PollingCheckpointStore & {
    current: PollingCursor | null;
    writes: Array<{ name: string; cursor: PollingCursor }>;
  };
}

function fakeInventory(rows: InventoryProductResponse[]) {
  return fakePagedInventory([rows]);
}

function fakePagedInventory(pages: InventoryProductResponse[][]) {
  return {
    queries: [] as InventoryListQueryDto[],
    async list(query: InventoryListQueryDto) {
      this.queries.push(query);
      return pages.shift() ?? [];
    },
  } satisfies InventoryPageReader & { queries: InventoryListQueryDto[] };
}

function fakeInventoryReadFailure(error: Error) {
  return {
    async list(_query: InventoryListQueryDto): Promise<InventoryProductResponse[]> {
      throw error;
    },
  } satisfies InventoryPageReader;
}

function fakeProducer(options: { failOnProductId?: string } = {}) {
  return {
    inputs: [] as ProductChangeInput[],
    async enqueueChange(input: ProductChangeInput) {
      this.inputs.push(input);
      if (input.productId === options.failOnProductId) {
        throw new Error(`enqueue failed for ${input.productId}`);
      }

      return { id: `job-${input.productId}` };
    },
  };
}

function inventoryRow(id: string, updatedAt: string): InventoryProductResponse {
  return {
    id,
    sku: `SKU-${id}`,
    name: `Product ${id}`,
    price: '12.30',
    quantity: 9,
    version: 7,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt,
  };
}

function cursor(updatedAt: string, productId: string): PollingCursor {
  return { updatedAt: new Date(updatedAt), productId };
}
