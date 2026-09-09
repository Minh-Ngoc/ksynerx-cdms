import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module.js';
import { ChangeProcessor } from './change-processor.js';
import { ProductLockService } from './product-lock.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [ChangeProcessor, ProductLockService],
  exports: [ChangeProcessor, ProductLockService],
})
export class ChangesModule {}
