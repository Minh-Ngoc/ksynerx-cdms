import { validateEnvironment } from './env.validation.js';

describe('validateEnvironment', () => {
  it('uses safe local prototype defaults when values are missing', () => {
    expect(validateEnvironment({})).toEqual({
      PORT: 3000,
      DATABASE_HOST: 'localhost',
      DATABASE_PORT: 5432,
      DATABASE_NAME: 'cdms',
      DATABASE_USER: 'cdms',
      DATABASE_PASSWORD: 'cdms_demo_password',
      REDIS_HOST: 'localhost',
      REDIS_PORT: 6379,
      POLL_INTERVAL_MS: 5000,
      INVENTORY_SEED_COUNT: 1000,
      IMPORT_BATCH_SIZE: 500,
      IMPORT_MAX_PENDING_BATCHES: 100,
      IMPORT_MAX_FILE_SIZE_MB: 100,
      IMPORT_REDIS_RETRY_TIMEOUT_MS: 30000,
      CHANGE_WORKER_CONCURRENCY: 10,
      OUTBOX_BATCH_SIZE: 100,
      OUTBOX_POLL_INTERVAL_MS: 1000,
    });
  });

  it.each([
    ['PORT', '0'],
    ['PORT', '65536'],
    ['DATABASE_PORT', '0'],
    ['REDIS_PORT', '70000'],
    ['POLL_INTERVAL_MS', '0'],
    ['INVENTORY_SEED_COUNT', '-1'],
    ['IMPORT_BATCH_SIZE', '0'],
    ['IMPORT_MAX_PENDING_BATCHES', '0'],
    ['IMPORT_MAX_FILE_SIZE_MB', '0'],
    ['IMPORT_REDIS_RETRY_TIMEOUT_MS', '-1'],
    ['CHANGE_WORKER_CONCURRENCY', '0'],
    ['OUTBOX_BATCH_SIZE', '0'],
    ['OUTBOX_POLL_INTERVAL_MS', '0'],
  ])('rejects invalid numeric value %s=%s', (key, value) => {
    expect(() => validateEnvironment({ [key]: value })).toThrow(key);
  });

  it.each([
    ['DATABASE_HOST'],
    ['DATABASE_NAME'],
    ['DATABASE_USER'],
    ['DATABASE_PASSWORD'],
    ['REDIS_HOST'],
  ])('rejects blank connection field %s', (key) => {
    expect(() => validateEnvironment({ [key]: '   ' })).toThrow(key);
  });
});
