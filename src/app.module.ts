import { Module } from '@nestjs/common';

import { AppConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';

@Module({
  imports: [AppConfigModule, DatabaseModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
