import { DataSourceOptions } from 'typeorm';

import { EnvironmentConfig } from '../config/env.validation.js';
import { InitialCdmsSchema1760000000000 } from './migrations/1760000000000-InitialCdmsSchema.js';
import { ImportBatchAccounting1760000000001 } from './migrations/1760000000001-ImportBatchAccounting.js';
import { DATABASE_ENTITIES } from './entities.js';

export interface AppDatabaseConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
}

export function createDatabaseConfig(environment: EnvironmentConfig): AppDatabaseConfig {
  return {
    host: environment.DATABASE_HOST,
    port: environment.DATABASE_PORT,
    name: environment.DATABASE_NAME,
    user: environment.DATABASE_USER,
    password: environment.DATABASE_PASSWORD,
  };
}

export function createAppDataSourceOptions(database: AppDatabaseConfig): DataSourceOptions {
  return {
    type: 'postgres',
    host: database.host,
    port: database.port,
    username: database.user,
    password: database.password,
    database: database.name,
    entities: DATABASE_ENTITIES,
    migrations: [InitialCdmsSchema1760000000000, ImportBatchAccounting1760000000001],
    migrationsTableName: 'typeorm_migrations',
    synchronize: false,
  };
}
