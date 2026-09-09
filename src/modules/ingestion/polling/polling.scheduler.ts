import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import { AppConfigService } from '../../../config/app-config.service.js';
import { PollingService } from './polling.service.js';

export const INVENTORY_POLLING_INTERVAL_NAME = 'inventory-products-polling';

export interface ScheduledPollResult {
  skipped: boolean;
}

export interface PollingIntervalRegistry {
  addInterval(name: string, interval: NodeJS.Timeout): void;
  deleteInterval(name: string): void;
}

@Injectable()
export class PollingScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PollingScheduler.name);
  private running = false;

  constructor(
    private readonly config: AppConfigService,
    @Inject(PollingService)
    private readonly pollingService: Pick<PollingService, 'pollOnce'>,
    @Inject(SchedulerRegistry)
    private readonly schedulerRegistry: PollingIntervalRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const interval = setInterval(() => {
      void this.runScheduledPoll();
    }, this.config.polling.intervalMs);

    this.schedulerRegistry.addInterval(INVENTORY_POLLING_INTERVAL_NAME, interval);
  }

  onApplicationShutdown(): void {
    try {
      this.schedulerRegistry.deleteInterval(INVENTORY_POLLING_INTERVAL_NAME);
    } catch {
      return;
    }
  }

  async runScheduledPoll(): Promise<ScheduledPollResult> {
    if (this.running) {
      // This guard prevents overlapping ticks in the single API process prototype. It is deliberately
      // not a distributed scheduler lock, so scaling API schedulers would require a separate decision.
      this.logger.warn({ message: 'Skipping inventory poll because the previous iteration is still running' });
      return { skipped: true };
    }

    this.running = true;
    try {
      await this.pollingService.pollOnce();
    } catch (error) {
      // pollOnce propagates failures for tests and callers; the scheduler catches them so one failed
      // dependency read/enqueue/checkpoint write does not terminate future scheduled retries.
      this.logger.error({ message: 'Inventory polling iteration failed', error });
    } finally {
      this.running = false;
    }

    return { skipped: false };
  }
}
