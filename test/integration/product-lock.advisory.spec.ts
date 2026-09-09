import { DataSource, QueryRunner } from 'typeorm';

import { createAppDataSourceFromEnvironment } from '../../src/database/data-source.js';
import { ProductLockService } from '../../src/modules/changes/product-lock.service.js';

describe('ProductLockService transaction-scoped advisory lock integration', () => {
  let dataSource: DataSource;
  let productLock: ProductLockService;

  beforeAll(async () => {
    dataSource = createAppDataSourceFromEnvironment(process.env);
    await dataSource.initialize();
    productLock = new ProductLockService();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('blocks the same product across transactions until COMMIT releases the transaction-level lock', async () => {
    const first = await startRunner();
    const second = await startRunner();

    try {
      await productLock.acquire(first.manager, 'product-same');

      const secondAcquire = productLock.acquire(second.manager, 'product-same');

      await expect(settlesWithin(secondAcquire, 75)).resolves.toBe(false);
      await first.commitTransaction();

      await expect(secondAcquire).resolves.toBeUndefined();
    } finally {
      await cleanupRunner(first);
      await cleanupRunner(second);
    }
  });

  it('blocks the same product across transactions until ROLLBACK releases the transaction-level lock', async () => {
    const first = await startRunner();
    const second = await startRunner();

    try {
      await productLock.acquire(first.manager, 'product-rollback');

      const secondAcquire = productLock.acquire(second.manager, 'product-rollback');

      await expect(settlesWithin(secondAcquire, 75)).resolves.toBe(false);
      await first.rollbackTransaction();

      await expect(secondAcquire).resolves.toBeUndefined();
    } finally {
      await cleanupRunner(first);
      await cleanupRunner(second);
    }
  });

  it('does not block different products when advisory keys differ', async () => {
    const first = await startRunner();
    const second = await startRunner();

    try {
      await productLock.acquire(first.manager, 'product-a');
      await expect(productLock.acquire(second.manager, 'product-b')).resolves.toBeUndefined();
    } finally {
      await cleanupRunner(first);
      await cleanupRunner(second);
    }
  });

  it('uses the caller transaction connection so future state reads and writes share the lock boundary', async () => {
    const runner = await startRunner();

    try {
      await productLock.acquire(runner.manager, 'product-connection');

      const [{ txid_current: transactionIdFromSameManager }] = await runner.manager.query('SELECT txid_current()');
      const [{ txid_current: transactionIdFromRunner }] = await runner.query('SELECT txid_current()');

      expect(transactionIdFromSameManager).toBe(transactionIdFromRunner);
    } finally {
      await cleanupRunner(runner);
    }
  });

  async function startRunner(): Promise<QueryRunner> {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    return runner;
  }

  async function cleanupRunner(runner: QueryRunner): Promise<void> {
    if (runner.isTransactionActive) {
      await runner.rollbackTransaction();
    }

    if (!runner.isReleased) {
      await runner.release();
    }
  }

  async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
    // The test needs a bounded observation window, but correctness is decided by explicit
    // transaction commit/rollback below. This avoids relying on wall-clock duration alone.
    const marker = Symbol('pending');
    const result = await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<typeof marker>((resolve) => {
        setTimeout(() => resolve(marker), milliseconds);
      }),
    ]);

    return result !== marker;
  }
});
