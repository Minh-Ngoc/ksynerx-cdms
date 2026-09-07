import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppConfigService } from '../config/app-config.service.js';
import { AppConfigModule } from '../config/config.module.js';
import { createAppDataSourceOptions } from './data-source.options.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => createAppDataSourceOptions(config.database),
    }),
  ],
})
export class DatabaseModule {}
