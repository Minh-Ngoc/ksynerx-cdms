import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { EMPTY, Observable } from 'rxjs';

import { ErrorCode } from '../../common/http/api-error.js';
import {
  createImportProgressSnapshot,
  ImportJobStatus,
  type ImportProgressSnapshot,
  type ImportStatusResponse,
} from './dto/import-contracts.js';
import type { PersistedImportJob } from './import-job.repository.js';
import { ImportJobRepository } from './import-job.repository.js';
import { ImportProgressService, type ImportProgressLivePort } from './import-progress.service.js';

@Injectable()
export class ImportProgressReadService {
  constructor(
    @Inject(ImportJobRepository) private readonly imports: ImportProgressReadPort,
    @Inject(ImportProgressService) private readonly liveProgress: ImportProgressLivePort,
  ) {}

  async getStatus(importId: string): Promise<ImportStatusResponse> {
    return toStatusResponse(await this.requireImport(importId));
  }

  async stream(importId: string, signal: AbortSignal): Promise<Observable<MessageEvent>> {
    // Verify existence before allocating a Redis client so an unknown ID returns the normal 404
    // response rather than opening an SSE stream that can only fail asynchronously.
    await this.requireImport(importId);

    let current: ImportProgressSnapshot | undefined;
    let observer: { next(event: MessageEvent): void; complete(): void } | undefined;
    let pending: ImportProgressSnapshot[] = [];
    let closed = false;
    let liveFailure: Error | undefined;

    const emit = (candidate: ImportProgressSnapshot): void => {
      if (closed || (current !== undefined && !isNonRegressing(candidate, current))) return;

      current = candidate;
      observer?.next({ type: 'progress', data: candidate });
      if (isTerminal(candidate.status)) {
        observer?.next({ type: candidate.status === ImportJobStatus.Completed ? 'completed' : 'failed', data: candidate });
        closed = true;
        observer?.complete();
      }
    };

    const unsubscribe = await this.liveProgress.subscribe(
      importId,
      (snapshot) => {
        if (observer === undefined) pending.push(snapshot);
        else emit(snapshot);
      },
      (error) => {
        // Redis Pub/Sub is deliberately best effort. A broken subscription closes this live view;
        // the next connection always loads PostgreSQL instead of inventing a replacement update.
        liveFailure = error;
        closed = true;
        observer?.complete();
      },
    );

    try {
      // Subscribe before reading PostgreSQL, then emit the durable state first. This closes the
      // read-then-subscribe race without adding durable event replay: a notification received
      // during setup is either reflected in this query or retained in `pending` below.
      const durable = toSnapshot(await this.requireImport(importId));
      if (signal.aborted || liveFailure !== undefined) {
        await unsubscribe();
        if (liveFailure !== undefined) throw liveFailure;
        return EMPTY;
      }

      return new Observable<MessageEvent>((subscriber) => {
        observer = subscriber;
        emit(durable);
        for (const snapshot of pending) emit(snapshot);
        pending = [];

        return () => {
          closed = true;
          observer = undefined;
          void unsubscribe();
        };
      });
    } catch (error) {
      await unsubscribe();
      throw error;
    }
  }

  private async requireImport(importId: string): Promise<PersistedImportJob> {
    const job = await this.imports.findById(importId);
    if (job !== null) return job;

    throw new NotFoundException({
      statusCode: 404,
      code: ErrorCode.NotFound,
      message: 'Import not found',
    });
  }
}

export interface ImportProgressReadPort {
  findById(importId: string): Promise<PersistedImportJob | null>;
}

function toStatusResponse(job: PersistedImportJob): ImportStatusResponse {
  return {
    id: job.id,
    filename: job.filename,
    status: job.status,
    rowsRead: job.rowsRead,
    rowsProcessed: job.rowsProcessed,
    rowsSucceeded: job.rowsSucceeded,
    rowsFailed: job.rowsFailed,
    totalRows: job.totalRows,
    enqueueCompletedAt: job.enqueueCompletedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    error: job.error,
  };
}

export function toSnapshot(job: PersistedImportJob): ImportProgressSnapshot {
  return createImportProgressSnapshot({
    importId: job.id,
    status: job.status,
    rowsRead: job.rowsRead,
    rowsProcessed: job.rowsProcessed,
    rowsSucceeded: job.rowsSucceeded,
    rowsFailed: job.rowsFailed,
    totalRows: job.totalRows,
  });
}

function isTerminal(status: ImportJobStatus): boolean {
  return status === ImportJobStatus.Completed || status === ImportJobStatus.Failed;
}

function isNonRegressing(candidate: ImportProgressSnapshot, previous: ImportProgressSnapshot): boolean {
  if (candidate.importId !== previous.importId || isTerminal(previous.status)) return false;
  if (candidate.rowsRead < previous.rowsRead || candidate.rowsProcessed < previous.rowsProcessed) return false;
  if (candidate.rowsSucceeded < previous.rowsSucceeded || candidate.rowsFailed < previous.rowsFailed) return false;

  const statusOrder = {
    [ImportJobStatus.Created]: 0,
    [ImportJobStatus.Uploading]: 1,
    [ImportJobStatus.Processing]: 2,
    [ImportJobStatus.Completed]: 3,
    [ImportJobStatus.Failed]: 3,
  } as const;
  return statusOrder[candidate.status] >= statusOrder[previous.status];
}
