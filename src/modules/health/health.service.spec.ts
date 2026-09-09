import { HealthService } from './health.service.js';

describe('HealthService', () => {
  it('reports ok only when PostgreSQL and Redis are both reachable', async () => {
    const postgres = new RecordingPostgres();
    const redis = new RecordingRedis();
    const service = new HealthService(postgres, redis);

    await expect(service.check()).resolves.toEqual({
      status: 'ok',
      dependencies: { postgres: 'up', redis: 'up' },
    });
    expect(postgres.queries).toEqual(['SELECT 1']);
    expect(redis.calls).toBe(1);
  });

  it('reports PostgreSQL down while still checking Redis', async () => {
    const postgres = new RecordingPostgres(new Error('database password=secret'));
    const redis = new RecordingRedis();
    const service = new HealthService(postgres, redis);

    await expect(service.check()).resolves.toEqual({
      status: 'error',
      dependencies: { postgres: 'down', redis: 'up' },
    });
    expect(redis.calls).toBe(1);
  });

  it('reports Redis down while PostgreSQL remains up', async () => {
    const postgres = new RecordingPostgres();
    const redis = new RecordingRedis(new Error('redis://secret@example.test:6379'));
    const service = new HealthService(postgres, redis);

    await expect(service.check()).resolves.toEqual({
      status: 'error',
      dependencies: { postgres: 'up', redis: 'down' },
    });
    expect(postgres.queries).toEqual(['SELECT 1']);
  });

  it('reports both required dependencies down without leaking either failure', async () => {
    const service = new HealthService(
      new RecordingPostgres(new Error('postgres failure password=secret')),
      new RecordingRedis(new Error('redis failure token=secret')),
    );

    await expect(service.check()).resolves.toEqual({
      status: 'error',
      dependencies: { postgres: 'down', redis: 'down' },
    });
  });

  it('starts the Redis probe even while PostgreSQL is still pending', async () => {
    let rejectPostgres!: (error: Error) => void;
    const postgres = {
      query: () => new Promise<unknown>((_resolve, reject) => { rejectPostgres = reject; }),
    };
    const redis = new RecordingRedis();
    const service = new HealthService(postgres, redis);
    const result = service.check();

    await Promise.resolve();
    expect(redis.calls).toBe(1);
    rejectPostgres(new Error('database unavailable'));

    await expect(result).resolves.toEqual({
      status: 'error',
      dependencies: { postgres: 'down', redis: 'up' },
    });
  });
});

class RecordingPostgres {
  queries: string[] = [];

  constructor(private readonly failure?: Error) {}

  async query(sql: string): Promise<unknown[]> {
    this.queries.push(sql);
    if (this.failure) throw this.failure;
    return [{ '?column?': 1 }];
  }
}

class RecordingRedis {
  calls = 0;

  constructor(private readonly failure?: Error) {}

  async ping(): Promise<void> {
    this.calls += 1;
    if (this.failure) throw this.failure;
  }
}
