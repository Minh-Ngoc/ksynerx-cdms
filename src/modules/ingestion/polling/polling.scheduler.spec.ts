import { Logger } from '@nestjs/common';

import { AppModule } from '../../../app.module.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { WorkerModule } from '../../../worker.module.js';
import { IngestionModule } from '../ingestion.module.js';
import {
  INVENTORY_POLLING_INTERVAL_NAME,
  PollingIntervalRegistry,
  PollingScheduler,
} from './polling.scheduler.js';
import { PollingService } from './polling.service.js';

interface FakeSchedulerRegistry extends PollingIntervalRegistry {
  intervals: Map<string, NodeJS.Timeout>;
  deleted: string[];
  addInterval(name: string, interval: NodeJS.Timeout): void;
  deleteInterval(name: string): void;
}

describe('PollingScheduler', () => {
  let registry: FakeSchedulerRegistry;
  let originalSetInterval: typeof globalThis.setInterval;
  let originalClearInterval: typeof globalThis.clearInterval;

  beforeEach(() => {
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;
    registry = {
      intervals: new Map(),
      deleted: [],
      addInterval(name, interval) {
        this.intervals.set(name, interval);
      },
      deleteInterval(name) {
        this.deleted.push(name);
        const interval = this.intervals.get(name);
        if (interval !== undefined) {
          clearInterval(interval);
        }
      },
    };
  });

  afterEach(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    Logger.prototype.error = originalLoggerError;
  });

  it('registers an API-owned polling interval using typed config', () => {
    const intervalCalls: number[] = [];
    const fakeInterval = Symbol('interval') as unknown as NodeJS.Timeout;
    globalThis.setInterval = ((_handler: Parameters<typeof globalThis.setInterval>[0], timeout?: number) => {
      intervalCalls.push(Number(timeout));
      return fakeInterval;
    }) as unknown as typeof globalThis.setInterval;
    globalThis.clearInterval = ((_interval: NodeJS.Timeout) => undefined) as typeof globalThis.clearInterval;
    const scheduler = new PollingScheduler(fakeConfig(1234), fakePollingService(), registry);

    scheduler.onApplicationBootstrap();

    expect(registry.intervals.has(INVENTORY_POLLING_INTERVAL_NAME)).toBe(true);
    expect(intervalCalls).toEqual([1234]);

    scheduler.onApplicationShutdown();
    expect(registry.deleted).toEqual([INVENTORY_POLLING_INTERVAL_NAME]);
  });

  it('keeps polling scheduler ownership in the API module and out of the worker module', () => {
    const apiImports = Reflect.getMetadata('imports', AppModule) as unknown[];
    const workerImports = Reflect.getMetadata('imports', WorkerModule) as unknown[];
    const ingestionProviders = Reflect.getMetadata('providers', IngestionModule) as unknown[];

    expect(apiImports).toContain(IngestionModule);
    expect(workerImports).not.toContain(IngestionModule);
    expect(ingestionProviders).toContain(PollingScheduler);
  });

  it('invokes pollOnce from the scheduler wrapper', async () => {
    const pollingService = fakePollingService();
    const scheduler = new PollingScheduler(fakeConfig(5000), pollingService, registry);

    await expect(scheduler.runScheduledPoll()).resolves.toEqual({ skipped: false });

    expect(pollingService.calls).toBe(1);
  });

  it('catches pollOnce failures so later scheduled retries can run', async () => {
    const loggedErrors: unknown[] = [];
    Logger.prototype.error = function error(message: unknown) {
      loggedErrors.push(message);
    };
    const pollingService = fakePollingService({ rejectWith: new Error('inventory unavailable') });
    const scheduler = new PollingScheduler(fakeConfig(5000), pollingService, registry);

    await expect(scheduler.runScheduledPoll()).resolves.toEqual({ skipped: false });

    expect(pollingService.calls).toBe(1);
    expect(loggedErrors).toEqual([
      {
      message: 'Inventory polling iteration failed',
      error: expect.any(Error),
      },
    ]);
  });

  it('prevents overlapping poll iterations in the single API process', async () => {
    const pollingService = fakePollingService({ defer: true });
    const scheduler = new PollingScheduler(fakeConfig(5000), pollingService, registry);

    const firstRun = scheduler.runScheduledPoll();
    await Promise.resolve();
    const overlappingRun = await scheduler.runScheduledPoll();

    expect(overlappingRun).toEqual({ skipped: true });
    expect(pollingService.calls).toBe(1);

    pollingService.resolve();
    await expect(firstRun).resolves.toEqual({ skipped: false });
  });
});

function fakeConfig(intervalMs: number): AppConfigService {
  return {
    polling: { intervalMs },
  } as AppConfigService;
}

const originalLoggerError = Logger.prototype.error;

function fakePollingService(options: { rejectWith?: Error; defer?: boolean } = {}) {
  let resolveDeferred: (() => void) | undefined;

  return {
    calls: 0,
    async pollOnce() {
      this.calls += 1;
      if (options.rejectWith !== undefined) {
        throw options.rejectWith;
      }

      if (options.defer === true) {
        await new Promise<void>((resolve) => {
          resolveDeferred = resolve;
        });
      }

      return { enqueued: 0, checkpointAdvanced: false };
    },
    resolve() {
      resolveDeferred?.();
    },
  } satisfies Pick<PollingService, 'pollOnce'> & { calls: number; resolve(): void };
}
