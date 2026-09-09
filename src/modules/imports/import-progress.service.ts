import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import { AppConfigService } from '../../config/app-config.service.js';
import type { ImportBatchProgressPort } from '../queue/processors/import-batch-queue.processor.js';
import {
  ImportJobRepository,
} from './import-job.repository.js';
import type {
  ImportBatchTerminalAccountingInput,
  ImportBatchTerminalAccountingResult,
  PersistedImportJob,
} from './import-job.repository.js';
import { createImportProgressSnapshot, type ImportProgressSnapshot } from './dto/import-contracts.js';

export interface ImportProgressLivePort {
  subscribe(
    importId: string,
    listener: (snapshot: ImportProgressSnapshot) => void,
    onError: (error: Error) => void,
  ): Promise<() => Promise<void>>;
}

@Injectable()
export class ImportProgressService implements ImportBatchProgressPort, ImportProgressLivePort, OnModuleDestroy {
  private readonly logger = new Logger(ImportProgressService.name);
  private readonly redis: Redis;

  constructor(
    private readonly imports: ImportJobRepository,
    config: AppConfigService,
  ) {
    this.redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    // ioredis requires an error listener; the durable database state intentionally remains usable
    // when this best-effort live mirror cannot connect.
    this.redis.on('error', () => undefined);
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  async isBatchAccounted(importId: string, batchId: string): Promise<boolean> {
    return this.imports.isBatchAccounted(importId, batchId);
  }

  async accountTerminalBatch(input: ImportBatchTerminalAccountingInput): Promise<ImportBatchTerminalAccountingResult> {
    const result = await this.imports.accountTerminalBatch(input);
    if (result.accounted) await this.mirrorSnapshot(result.import);
    return result;
  }

  async subscribe(
    importId: string,
    listener: (snapshot: ImportProgressSnapshot) => void,
    onError: (error: Error) => void,
  ): Promise<() => Promise<void>> {
    const subscriber = this.redis.duplicate();
    const channel = progressChannel(importId);
    const handleMessage = (receivedChannel: string, message: string) => {
      if (receivedChannel !== channel) return;
      try {
        listener(JSON.parse(message) as ImportProgressSnapshot);
      } catch {
        onError(new Error('Received invalid import progress notification'));
      }
    };
    const handleError = (error: Error) => onError(error);
    subscriber.on('message', handleMessage);
    subscriber.on('error', handleError);

    try {
      if (subscriber.status === 'wait') await subscriber.connect();
      await subscriber.subscribe(channel);
    } catch (error) {
      subscriber.disconnect();
      throw error;
    }

    let unsubscribed = false;
    return async () => {
      if (unsubscribed) return;
      unsubscribed = true;
      subscriber.off('message', handleMessage);
      subscriber.off('error', handleError);
      try {
        await subscriber.unsubscribe(channel);
      } finally {
        subscriber.disconnect();
      }
    };
  }

  private async mirrorSnapshot(snapshot: PersistedImportJob): Promise<void> {
    try {
      // HSET writes the entire snapshot in one Redis command. It is a live acceleration for Task 21,
      // not a completion authority: a Redis outage must never roll back committed PostgreSQL counters.
      if (this.redis.status === 'wait') await this.redis.connect();
      await this.redis.hset(
        progressKey(snapshot.id),
        'rowsRead', String(snapshot.rowsRead),
        'rowsProcessed', String(snapshot.rowsProcessed),
        'rowsSucceeded', String(snapshot.rowsSucceeded),
        'rowsFailed', String(snapshot.rowsFailed),
        'totalRows', snapshot.totalRows === null ? '' : String(snapshot.totalRows),
        'status', snapshot.status,
        'enqueueCompletedAt', snapshot.enqueueCompletedAt?.toISOString() ?? '',
        'completedAt', snapshot.completedAt?.toISOString() ?? '',
      );
      await this.redis.publish(progressChannel(snapshot.id), JSON.stringify(toLiveSnapshot(snapshot)));
    } catch (error) {
      this.logger.warn({ importId: snapshot.id, message: 'Could not mirror import progress to Redis', error: error instanceof Error ? error.message : 'unknown' });
    }
  }
}

function toLiveSnapshot(snapshot: PersistedImportJob): ImportProgressSnapshot {
  return createImportProgressSnapshot({
    importId: snapshot.id,
    status: snapshot.status,
    rowsRead: snapshot.rowsRead,
    rowsProcessed: snapshot.rowsProcessed,
    rowsSucceeded: snapshot.rowsSucceeded,
    rowsFailed: snapshot.rowsFailed,
    totalRows: snapshot.totalRows,
  });
}

function progressKey(importId: string): string {
  return `cdms:import-progress:${importId}`;
}

function progressChannel(importId: string): string {
  return `cdms:import-progress-events:${importId}`;
}
