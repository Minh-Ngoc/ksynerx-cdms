export interface EnvironmentConfig {
  PORT: number;
  DATABASE_HOST: string;
  DATABASE_PORT: number;
  DATABASE_NAME: string;
  DATABASE_USER: string;
  DATABASE_PASSWORD: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  POLL_INTERVAL_MS: number;
  INVENTORY_SEED_COUNT: number;
  IMPORT_BATCH_SIZE: number;
  IMPORT_MAX_PENDING_BATCHES: number;
  IMPORT_MAX_FILE_SIZE_MB: number;
  IMPORT_REDIS_RETRY_TIMEOUT_MS: number;
  CHANGE_WORKER_CONCURRENCY: number;
  OUTBOX_BATCH_SIZE: number;
  OUTBOX_POLL_INTERVAL_MS: number;
}

const DEFAULT_ENVIRONMENT: EnvironmentConfig = {
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
};

export function validateEnvironment(rawEnvironment: Record<string, unknown>): EnvironmentConfig {
  return {
    PORT: readPort(rawEnvironment, 'PORT', DEFAULT_ENVIRONMENT.PORT),
    DATABASE_HOST: readText(rawEnvironment, 'DATABASE_HOST', DEFAULT_ENVIRONMENT.DATABASE_HOST),
    DATABASE_PORT: readPort(rawEnvironment, 'DATABASE_PORT', DEFAULT_ENVIRONMENT.DATABASE_PORT),
    DATABASE_NAME: readText(rawEnvironment, 'DATABASE_NAME', DEFAULT_ENVIRONMENT.DATABASE_NAME),
    DATABASE_USER: readText(rawEnvironment, 'DATABASE_USER', DEFAULT_ENVIRONMENT.DATABASE_USER),
    DATABASE_PASSWORD: readText(rawEnvironment, 'DATABASE_PASSWORD', DEFAULT_ENVIRONMENT.DATABASE_PASSWORD),
    REDIS_HOST: readText(rawEnvironment, 'REDIS_HOST', DEFAULT_ENVIRONMENT.REDIS_HOST),
    REDIS_PORT: readPort(rawEnvironment, 'REDIS_PORT', DEFAULT_ENVIRONMENT.REDIS_PORT),
    POLL_INTERVAL_MS: readIntegerAtLeast(rawEnvironment, 'POLL_INTERVAL_MS', 1, DEFAULT_ENVIRONMENT.POLL_INTERVAL_MS),
    INVENTORY_SEED_COUNT: readIntegerAtLeast(
      rawEnvironment,
      'INVENTORY_SEED_COUNT',
      0,
      DEFAULT_ENVIRONMENT.INVENTORY_SEED_COUNT,
    ),
    IMPORT_BATCH_SIZE: readIntegerAtLeast(rawEnvironment, 'IMPORT_BATCH_SIZE', 1, DEFAULT_ENVIRONMENT.IMPORT_BATCH_SIZE),
    IMPORT_MAX_PENDING_BATCHES: readIntegerAtLeast(
      rawEnvironment,
      'IMPORT_MAX_PENDING_BATCHES',
      1,
      DEFAULT_ENVIRONMENT.IMPORT_MAX_PENDING_BATCHES,
    ),
    IMPORT_MAX_FILE_SIZE_MB: readIntegerAtLeast(
      rawEnvironment,
      'IMPORT_MAX_FILE_SIZE_MB',
      1,
      DEFAULT_ENVIRONMENT.IMPORT_MAX_FILE_SIZE_MB,
    ),
    IMPORT_REDIS_RETRY_TIMEOUT_MS: readIntegerAtLeast(
      rawEnvironment,
      'IMPORT_REDIS_RETRY_TIMEOUT_MS',
      0,
      DEFAULT_ENVIRONMENT.IMPORT_REDIS_RETRY_TIMEOUT_MS,
    ),
    CHANGE_WORKER_CONCURRENCY: readIntegerAtLeast(
      rawEnvironment,
      'CHANGE_WORKER_CONCURRENCY',
      1,
      DEFAULT_ENVIRONMENT.CHANGE_WORKER_CONCURRENCY,
    ),
    OUTBOX_BATCH_SIZE: readIntegerAtLeast(rawEnvironment, 'OUTBOX_BATCH_SIZE', 1, DEFAULT_ENVIRONMENT.OUTBOX_BATCH_SIZE),
    OUTBOX_POLL_INTERVAL_MS: readIntegerAtLeast(
      rawEnvironment,
      'OUTBOX_POLL_INTERVAL_MS',
      1,
      DEFAULT_ENVIRONMENT.OUTBOX_POLL_INTERVAL_MS,
    ),
  };
}

function readText(environment: Record<string, unknown>, key: keyof EnvironmentConfig, defaultValue: string): string {
  const value = environment[key];

  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }

  return value;
}

function readPort(environment: Record<string, unknown>, key: keyof EnvironmentConfig, defaultValue: number): number {
  // TCP ports are globally bounded to 1..65535; accepting wider values would fail later in less obvious places.
  return readIntegerInRange(environment, key, 1, 65535, defaultValue);
}

function readIntegerAtLeast(
  environment: Record<string, unknown>,
  key: keyof EnvironmentConfig,
  minimum: number,
  defaultValue: number,
): number {
  const value = readInteger(environment, key, defaultValue);

  if (value < minimum) {
    throw new Error(`${key} must be greater than or equal to ${minimum}`);
  }

  return value;
}

function readIntegerInRange(
  environment: Record<string, unknown>,
  key: keyof EnvironmentConfig,
  minimum: number,
  maximum: number,
  defaultValue: number,
): number {
  const value = readInteger(environment, key, defaultValue);

  if (value < minimum || value > maximum) {
    throw new Error(`${key} must be between ${minimum} and ${maximum}`);
  }

  return value;
}

function readInteger(environment: Record<string, unknown>, key: keyof EnvironmentConfig, defaultValue: number): number {
  const value = environment[key];

  if (value === undefined) {
    return defaultValue;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(parsed)) {
    throw new Error(`${key} must be an integer`);
  }

  return parsed;
}
