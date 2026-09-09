import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';

@Injectable()
export class OutboxPublisherScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherScheduler.name);
  private interval: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly config: AppConfigService,
    @Inject(OutboxPublisherService)
    private readonly publisher: Pick<OutboxPublisherService, 'publishBatch'>,
  ) {}

  onApplicationBootstrap(): void {
    this.interval = setInterval(() => {
      void this.runScheduledPublish();
    }, this.config.outbox.pollIntervalMs);
    this.interval.unref();
  }

  onApplicationShutdown(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  async runScheduledPublish(): Promise<{ skipped: boolean }> {
    if (this.running) {
      // The worker has a local overlap guard even though PostgreSQL row locks protect correctness;
      // avoiding duplicate concurrent scans keeps the prototype's retry behavior easier to inspect.
      this.logger.warn({ message: 'Skipping outbox publish because the previous iteration is still running' });
      return { skipped: true };
    }

    this.running = true;
    try {
      await this.publisher.publishBatch();
    } catch (error) {
      this.logger.error({ message: 'Outbox publish iteration failed', error });
    } finally {
      this.running = false;
    }

    return { skipped: false };
  }
}
