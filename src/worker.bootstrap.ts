import { INestApplicationContext, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { AppConfigService } from './config/app-config.service.js';

interface WorkerApplicationContextFactory {
  createApplicationContext(module: unknown): Promise<INestApplicationContext>;
  create?: unknown;
}

export function createWorkerApplicationContext(
  nestFactory: WorkerApplicationContextFactory = NestFactory,
): Promise<INestApplicationContext> {
  // The worker role uses Nest's standalone application context so it shares DI/config with the API
  // process without opening an HTTP listener or introducing a second source application.
  return nestFactory.createApplicationContext(AppModule);
}

export async function bootstrapWorker(): Promise<void> {
  const app = await createWorkerApplicationContext();
  const logger = new Logger('Worker');
  const appConfig = app.get(AppConfigService);

  logger.log(`CDMS worker role started with change concurrency ${appConfig.worker.changeConcurrency}`);

  await waitForShutdown(app, logger);
}

function waitForShutdown(app: INestApplicationContext, logger: Logger): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = async (signal: NodeJS.Signals) => {
      logger.log(`Worker received ${signal}; closing Nest application context`);
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      await app.close();
      resolve();
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
