import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/config.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { InternalXlsxStreamingReader } from './internal-xlsx-streaming-reader.js';
import { ImportsController } from './imports.controller.js';
import { ImportJobRepository } from './import-job.repository.js';
import { ImportProgressService } from './import-progress.service.js';
import { ImportProgressReadService } from './import-progress-read.service.js';
import { ImportUploadService } from './import-upload.service.js';

@Module({
  imports: [AppConfigModule, DatabaseModule, QueueModule],
  controllers: [ImportsController],
  providers: [
    { provide: InternalXlsxStreamingReader, useFactory: () => new InternalXlsxStreamingReader() },
    ImportJobRepository,
    ImportProgressService,
    ImportProgressReadService,
    { provide: 'IMPORT_BATCH_PROGRESS_PORT', useExisting: ImportProgressService },
    ImportUploadService,
  ],
  exports: [ImportJobRepository, ImportProgressService, 'IMPORT_BATCH_PROGRESS_PORT'],
})
export class ImportsModule {}
