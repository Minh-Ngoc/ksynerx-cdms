import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { HealthDependencyStatus, HealthResponse } from './dto/health-contracts.js';
import { RedisHealthProbe } from './redis-health.probe.js';

const HEALTH_CHECK_TIMEOUT_MS = 1_000;

export interface PostgresHealthProbe {
  query(sql: string): Promise<unknown>;
}

export interface RedisHealthProbePort {
  ping(): Promise<void>;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(DataSource) private readonly postgres: PostgresHealthProbe,
    @Inject(RedisHealthProbe) private readonly redis: RedisHealthProbePort,
  ) {}

  async check(): Promise<HealthResponse> {
    // Required dependencies are probed independently so a database outage does not hide Redis
    // status (or the reverse). Neither failure changes business state; this route is readiness,
    // not a liveness-only process check.
    const [postgres, redis] = await Promise.allSettled([
      withinHealthTimeout(this.postgres.query('SELECT 1'), 'PostgreSQL'),
      withinHealthTimeout(this.redis.ping(), 'Redis'),
    ]);
    const dependencies = {
      postgres: this.statusFor('postgres', postgres),
      redis: this.statusFor('redis', redis),
    };

    return {
      status: dependencies.postgres === 'up' && dependencies.redis === 'up' ? 'ok' : 'error',
      dependencies,
    };
  }

  private statusFor(dependency: 'postgres' | 'redis', result: PromiseSettledResult<unknown>): HealthDependencyStatus {
    if (result.status === 'fulfilled') return 'up';

    // Do not log raw driver errors: connection strings and query details can carry credentials.
    // The response remains intentionally small while the dependency name still supports operators.
    this.logger.warn({ message: 'Required health dependency is unavailable', dependency });
    return 'down';
  }
}

function withinHealthTimeout<T>(operation: Promise<T>, dependency: string): Promise<T> {
  // TypeORM's shared DataSource does not define a query timeout in this prototype. Bounding only
  // readiness probes prevents a broken socket from holding an HTTP response forever without
  // changing normal persistence behavior or introducing a cross-application timeout framework.
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${dependency} health check timed out`)), HEALTH_CHECK_TIMEOUT_MS);
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
