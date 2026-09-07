import { DataSource } from 'typeorm';

import { validateEnvironment } from '../config/env.validation.js';
import { createAppDataSourceOptions, createDatabaseConfig } from './data-source.options.js';

export function createAppDataSourceFromEnvironment(environment: Record<string, unknown> = process.env): DataSource {
  const config = validateEnvironment(environment);
  return new DataSource(createAppDataSourceOptions(createDatabaseConfig(config)));
}

export const AppDataSource = createAppDataSourceFromEnvironment();
