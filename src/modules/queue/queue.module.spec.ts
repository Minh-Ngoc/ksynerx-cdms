import { AppModule } from '../../app.module.js';
import { WorkerModule } from '../../worker.module.js';
import { QueueWorkerModule } from './queue-worker.module.js';
import { createWorkerRuntimeOptions } from './processors/change-queue.processor.js';
import { ImportBatchQueueProcessor } from './processors/import-batch-queue.processor.js';
import { QueueModule } from './queue.module.js';
import type { AppConfigService } from '../../config/app-config.service.js';

describe('queue module role boundaries', () => {
  it('uses configured bounded concurrency for the change worker', () => {
    expect(createWorkerRuntimeOptions({ worker: { changeConcurrency: 7 } } as AppConfigService)).toEqual({ concurrency: 7 });
  });

  it('does not instantiate BullMQ processors in the API app module', async () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];

    expect(imports).toContain(QueueModule);
    expect(imports).not.toContain(QueueWorkerModule);
  });

  it('registers BullMQ processors in the standalone worker module', async () => {
    const imports = Reflect.getMetadata('imports', WorkerModule) as unknown[];

    expect(imports).toContain(QueueWorkerModule);
  });

  it('provides the import-batch processor only in the worker module', () => {
    const apiProviders = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? [];
    const workerProviders = Reflect.getMetadata('providers', QueueWorkerModule) as unknown[];

    expect(apiProviders).not.toContain(ImportBatchQueueProcessor);
    expect(workerProviders).toContain(ImportBatchQueueProcessor);
  });
});
