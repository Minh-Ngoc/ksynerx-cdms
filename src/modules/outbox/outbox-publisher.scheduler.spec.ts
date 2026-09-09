import { Logger } from '@nestjs/common';

import { AppModule } from '../../app.module.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { WorkerModule } from '../../worker.module.js';
import { OutboxModule } from './outbox.module.js';
import { OutboxPublisherScheduler } from './outbox-publisher.scheduler.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';

describe('OutboxPublisherScheduler', () => {
  let originalSetInterval: typeof globalThis.setInterval;
  let originalClearInterval: typeof globalThis.clearInterval;
  let originalError: typeof Logger.prototype.error;
  let originalWarn: typeof Logger.prototype.warn;

  beforeEach(() => {
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;
    originalError = Logger.prototype.error;
    originalWarn = Logger.prototype.warn;
  });

  afterEach(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    Logger.prototype.error = originalError;
    Logger.prototype.warn = originalWarn;
  });

  it('registers a worker-owned interval using typed outbox config', () => {
    const intervalCalls: number[] = [];
    const fakeInterval = { unref: () => undefined } as unknown as NodeJS.Timeout;
    globalThis.setInterval = ((_handler: Parameters<typeof globalThis.setInterval>[0], timeout?: number) => {
      intervalCalls.push(Number(timeout));
      return fakeInterval;
    }) as unknown as typeof globalThis.setInterval;
    globalThis.clearInterval = ((_interval: NodeJS.Timeout) => undefined) as typeof globalThis.clearInterval;
    const scheduler = new OutboxPublisherScheduler(fakeConfig(2500), fakePublisher());

    scheduler.onApplicationBootstrap();

    expect(intervalCalls).toEqual([2500]);

    scheduler.onApplicationShutdown();
  });

  it('keeps outbox publishing in the worker module and out of the API module', () => {
    const apiImports = Reflect.getMetadata('imports', AppModule) as unknown[];
    const workerImports = Reflect.getMetadata('imports', WorkerModule) as unknown[];
    const outboxProviders = Reflect.getMetadata('providers', OutboxModule) as unknown[];

    expect(apiImports).not.toContain(OutboxModule);
    expect(workerImports).toContain(OutboxModule);
    expect(outboxProviders).toEqual(expect.arrayContaining([OutboxPublisherService, OutboxPublisherScheduler]));
  });

  it('runs one publish batch from the scheduler wrapper', async () => {
    const publisher = fakePublisher();
    const scheduler = new OutboxPublisherScheduler(fakeConfig(2500), publisher);

    await expect(scheduler.runScheduledPublish()).resolves.toEqual({ skipped: false });

    expect(publisher.calls).toBe(1);
  });

  it('catches publish failures so the next scheduled iteration can retry', async () => {
    const loggedErrors: unknown[] = [];
    Logger.prototype.error = function error(message: unknown) {
      loggedErrors.push(message);
    };
    const scheduler = new OutboxPublisherScheduler(
      fakeConfig(2500),
      fakePublisher({ rejectWith: new Error('outbox publication failed') }),
    );

    await expect(scheduler.runScheduledPublish()).resolves.toEqual({ skipped: false });

    expect(loggedErrors).toEqual([
      {
        message: 'Outbox publish iteration failed',
        error: expect.any(Error),
      },
    ]);
  });

  it('prevents overlapping publish iterations in a single worker process', async () => {
    const loggedWarnings: unknown[] = [];
    Logger.prototype.warn = function warn(message: unknown) {
      loggedWarnings.push(message);
    };
    const publisher = fakePublisher({ defer: true });
    const scheduler = new OutboxPublisherScheduler(fakeConfig(2500), publisher);

    const firstRun = scheduler.runScheduledPublish();
    await Promise.resolve();
    const overlappingRun = await scheduler.runScheduledPublish();

    expect(overlappingRun).toEqual({ skipped: true });
    expect(publisher.calls).toBe(1);
    expect(loggedWarnings).toEqual([
      {
        message: 'Skipping outbox publish because the previous iteration is still running',
      },
    ]);

    publisher.resolve();
    await expect(firstRun).resolves.toEqual({ skipped: false });
  });
});

function fakeConfig(pollIntervalMs: number): AppConfigService {
  return {
    outbox: { batchSize: 10, pollIntervalMs },
  } as AppConfigService;
}

function fakePublisher(options: { rejectWith?: Error; defer?: boolean } = {}) {
  let resolveDeferred: (() => void) | undefined;

  return {
    calls: 0,
    async publishBatch() {
      this.calls += 1;
      if (options.rejectWith !== undefined) {
        throw options.rejectWith;
      }

      if (options.defer === true) {
        await new Promise<void>((resolve) => {
          resolveDeferred = resolve;
        });
      }

      return { published: 0, failed: 0 };
    },
    resolve() {
      resolveDeferred?.();
    },
  } satisfies Pick<OutboxPublisherService, 'publishBatch'> & { calls: number; resolve(): void };
}
