import { Readable } from 'node:stream';

import busboy from 'busboy';
import { BadRequestException, Injectable, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { Request } from 'express';

import { ErrorCode } from '../../common/http/api-error.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { ImportCreateResponse, ImportJobStatus } from './dto/import-contracts.js';
import { InternalXlsxStreamingReader } from './internal-xlsx-streaming-reader.js';
import { ImportJobRepository } from './import-job.repository.js';
import {
  ImportEnqueueRetryTimeoutError,
  ImportUploadTooLargeError,
  ImportWorkbookParseError,
} from './import-streaming.contract.js';
import { ImportStreamingService } from './import-streaming.service.js';
import { ImportBatchQueueProducer } from '../queue/import-batch-queue.producer.js';

const IMPORT_FILE_FIELD = 'file';

@Injectable()
export class ImportUploadService {
  constructor(
    private readonly config: AppConfigService,
    private readonly imports: ImportJobRepository,
    private readonly workbookReader: InternalXlsxStreamingReader,
    private readonly batchQueue: ImportBatchQueueProducer,
  ) {}

  async accept(request: Request): Promise<ImportCreateResponse> {
    const job = await this.imports.create('upload.xlsx');
    await this.imports.markUploading(job.id);

    try {
      await consumeSingleMultipartFile(request, async (file, filename) => {
        await this.imports.setFilename(job.id, safeFilename(filename));
        await this.createStreamingProducer().processUploadStream(file, job.id);
      });
    } catch (error) {
      // Multipart failures occur before the streaming producer exists, so the HTTP ingress owns
      // their durable FAILED transition. Producer failures already made the same transition safely.
      await this.imports.markIngestionFailed(job.id, sanitizeImportFailure(error));
      throw mapImportHttpError(error);
    }

    return { importId: job.id, status: ImportJobStatus.Processing };
  }

  private createStreamingProducer(): ImportStreamingService {
    const imports = this.config.imports;
    return new ImportStreamingService(
      {
        workbookReader: this.workbookReader,
        batchQueue: this.batchQueue,
        progress: this.imports,
        lifecycle: this.imports,
      },
      {
        batchSize: imports.batchSize,
        maxPendingBatches: imports.maxPendingBatches,
        maxFileSizeBytes: imports.maxFileSizeMb * 1024 * 1024,
        redisRetryTimeoutMs: imports.redisRetryTimeoutMs,
      },
    );
  }
}

async function consumeSingleMultipartFile(
  request: Request,
  consume: (file: Readable, filename: string) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let consumedFile: Promise<void> | undefined;
    let failed = false;
    const fail = (error: Error) => {
      if (!failed) {
        failed = true;
        reject(error);
      }
    };

    let parser;
    try {
      parser = busboy({
        headers: request.headers,
        limits: { files: 2, fields: 10, parts: 12 },
      });
    } catch {
      fail(new ImportWorkbookParseError('Request must be multipart/form-data'));
      return;
    }

    // Busboy's file Readable is staged through a byte-limited write pipeline before ZIP parsing.
    // A Multer memory object would retain the entire untrusted upload and defeat Phase A limits.
    parser.on('file', (fieldName, file, info) => {
      if (fieldName !== IMPORT_FILE_FIELD || consumedFile !== undefined) {
        file.resume();
        fail(new ImportWorkbookParseError('Exactly one product workbook file is required'));
        return;
      }

      consumedFile = consume(file, info.filename);
      void consumedFile.catch((error: unknown) => fail(asImportError(error)));
    });
    parser.on('filesLimit', () => fail(new ImportWorkbookParseError('Exactly one product workbook file is required')));
    parser.on('partsLimit', () => fail(new ImportWorkbookParseError('Multipart request is too complex')));
    parser.on('error', () => fail(new ImportWorkbookParseError('Multipart upload could not be read')));
    request.on('error', () => fail(new ImportWorkbookParseError('Multipart upload could not be read')));
    parser.on('close', async () => {
      if (failed) {
        return;
      }
      if (consumedFile === undefined) {
        fail(new ImportWorkbookParseError('Product workbook file is required'));
        return;
      }

      try {
        await consumedFile;
        resolve();
      } catch (error) {
        fail(asImportError(error));
      }
    });

    request.pipe(parser);
  });
}

function safeFilename(filename: string): string {
  // eslint-disable-next-line no-control-regex -- Multipart filenames can contain ASCII controls.
  return filename.replace(/[\\/\u0000-\u001F]/g, '_').slice(0, 255) || 'upload.xlsx';
}

function asImportError(error: unknown): Error {
  return error instanceof Error ? error : new ImportWorkbookParseError('Import ingestion could not complete');
}

function mapImportHttpError(error: unknown): Error {
  if (error instanceof ImportUploadTooLargeError) {
    return new PayloadTooLargeException({
      statusCode: 413,
      code: ErrorCode.ValidationError,
      message: 'Upload exceeds the configured size limit',
    });
  }
  if (error instanceof ImportEnqueueRetryTimeoutError) {
    return new ServiceUnavailableException({
      statusCode: 503,
      code: ErrorCode.DependencyUnavailable,
      message: 'Import queue is unavailable',
    });
  }
  if (error instanceof ImportWorkbookParseError) {
    return new BadRequestException({
      statusCode: 400,
      code: ErrorCode.ValidationError,
      message: error.message,
    });
  }

  return new BadRequestException({
    statusCode: 400,
    code: ErrorCode.ValidationError,
    message: 'Import upload could not be accepted',
  });
}

function sanitizeImportFailure(error: unknown): string {
  if (error instanceof ImportUploadTooLargeError) {
    return 'Upload exceeds the configured size limit';
  }
  if (error instanceof ImportEnqueueRetryTimeoutError) {
    return 'Import queue did not recover before the retry timeout';
  }
  if (error instanceof ImportWorkbookParseError) {
    return error.message;
  }
  return 'Import ingestion could not complete';
}
