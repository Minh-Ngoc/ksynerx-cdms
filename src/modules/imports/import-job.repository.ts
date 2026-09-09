import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ImportStatus } from './entities/import-job.entity.js';
import { ImportIngestionLifecyclePort, ImportIngestionProgressPort } from './import-streaming.contract.js';

export interface PersistedImportJob {
  id: string;
  filename: string;
  status: ImportStatus;
  rowsRead: number;
  rowsProcessed: number;
  rowsSucceeded: number;
  rowsFailed: number;
  totalRows: number | null;
  enqueueCompletedAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
  error: string | null;
}

export interface ImportBatchTerminalAccountingInput {
  importId: string;
  batchId: string;
  succeeded: number;
  failed: number;
}

export interface ImportBatchTerminalAccountingResult {
  accounted: boolean;
  import: PersistedImportJob;
}

@Injectable()
export class ImportJobRepository implements ImportIngestionProgressPort, ImportIngestionLifecyclePort {
  constructor(private readonly dataSource: DataSource) {}

  async create(filename: string): Promise<PersistedImportJob> {
    return this.readOne(
      await this.dataSource.query(
        `
          INSERT INTO import_jobs (id, filename, status)
          VALUES ($1, $2, $3)
          RETURNING *
        `,
        [randomUUID(), filename, ImportStatus.Created],
      ),
    );
  }

  async markUploading(importId: string): Promise<void> {
    await this.dataSource.query(
      'UPDATE import_jobs SET status = $2, error = NULL WHERE id = $1',
      [importId, ImportStatus.Uploading],
    );
  }

  async setFilename(importId: string, filename: string): Promise<void> {
    await this.dataSource.query('UPDATE import_jobs SET filename = $2 WHERE id = $1', [importId, filename]);
  }

  async recordReadableRow(importId: string): Promise<void> {
    await this.dataSource.query('UPDATE import_jobs SET rows_read = rows_read + 1 WHERE id = $1', [importId]);
  }

  async recordMalformedRow(input: { importId: string; rowNumber: number; error: string }): Promise<void> {
    // These three counters change together because PostgreSQL validates the progress equations after
    // each statement. Splitting the update would temporarily violate rowsProcessed = success + fail.
    await this.dataSource.query(
      `
        UPDATE import_jobs
        SET
          rows_read = rows_read + 1,
          rows_processed = rows_processed + 1,
          rows_failed = rows_failed + 1
        WHERE id = $1
      `,
      [input.importId],
    );
  }

  async markEnqueueCompleted(importId: string, completedAt: Date): Promise<void> {
    // enqueue_completed_at records producer success only. Import batch workers still own the later
    // PROCESSING -> COMPLETED decision after every queued row reaches a terminal result.
    await this.dataSource.query(
      `
        UPDATE import_jobs
        SET
          status = $2,
          enqueue_completed_at = $3,
          total_rows = rows_read,
          error = NULL
        WHERE id = $1
      `,
      [importId, ImportStatus.Processing, completedAt],
    );
  }

  async markIngestionFailed(importId: string, error: string): Promise<void> {
    // Some batches can already be in BullMQ when a later stream failure occurs. There is no safe
    // distributed rollback, so FAILED means producer failure, not that no rows were ever queued.
    await this.dataSource.query(
      `
        UPDATE import_jobs
        SET status = $2, error = $3, enqueue_completed_at = NULL
        WHERE id = $1
      `,
      [importId, ImportStatus.Failed, error],
    );
  }

  async isBatchAccounted(importId: string, batchId: string): Promise<boolean> {
    const rows = await this.dataSource.query(
      'SELECT 1 FROM import_batch_accounting WHERE import_id = $1 AND batch_id = $2',
      [importId, batchId],
    );
    return rows.length > 0;
  }

  async accountTerminalBatch(input: ImportBatchTerminalAccountingInput): Promise<ImportBatchTerminalAccountingResult> {
    const processed = input.succeeded + input.failed;
    return this.dataSource.transaction(async (manager) => {
      // Aggregate counters cannot identify a replay after PostgreSQL commits but before BullMQ
      // acknowledges completion. This marker is not an Inbox: it holds no message or business
      // state, only the batch identity and terminal delta that make progress idempotent.
      const inserted = queryRows(await manager.query(
        `
          INSERT INTO import_batch_accounting (
            import_id, batch_id, rows_processed, rows_succeeded, rows_failed
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (import_id, batch_id) DO NOTHING
          RETURNING import_id
        `,
        [input.importId, input.batchId, processed, input.succeeded, input.failed],
      ));

      if (inserted.length === 0) {
        const [existing] = queryRows(await manager.query('SELECT * FROM import_jobs WHERE id = $1', [input.importId]));
        return { accounted: false, import: mapImportJob(existing as ImportJobRow) };
      }

      // A single statement preserves both CHECK invariants at every committed state. This must use
      // the transaction manager so the marker, counters, and completion decision roll back together.
      const [updated] = queryRows(await manager.query(
        `
          UPDATE import_jobs
          SET
            rows_processed = rows_processed + $2,
            rows_succeeded = rows_succeeded + $3,
            rows_failed = rows_failed + $4
          WHERE id = $1
          RETURNING *
        `,
        [input.importId, processed, input.succeeded, input.failed],
      ));

      // `rows_processed = rows_read` is only safe after Task 19 has durably ended production.
      // The status predicate prevents queued work from resurrecting a FAILED import, while this
      // conditional update ensures exactly one concurrent final worker sets completed_at.
      const [completed] = queryRows(await manager.query(
        `
          UPDATE import_jobs
          SET status = $2, completed_at = now()
          WHERE id = $1
            AND status = $3
            AND enqueue_completed_at IS NOT NULL
            AND rows_processed = rows_read
          RETURNING *
        `,
        [input.importId, ImportStatus.Completed, ImportStatus.Processing],
      ));

      return { accounted: true, import: mapImportJob((completed ?? updated) as ImportJobRow) };
    });
  }

  async findById(importId: string): Promise<PersistedImportJob | null> {
    const rows = await this.dataSource.query('SELECT * FROM import_jobs WHERE id = $1', [importId]);
    return rows.length === 0 ? null : mapImportJob(rows[0] as ImportJobRow);
  }

  private readOne(result: unknown): PersistedImportJob {
    const rows = queryRows(result);
    return mapImportJob((rows as ImportJobRow[])[0]!);
  }
}

interface ImportJobRow {
  id: string;
  filename: string;
  status: ImportStatus;
  rows_read: number;
  rows_processed: number;
  rows_succeeded: number;
  rows_failed: number;
  total_rows: number | null;
  enqueue_completed_at: Date | null;
  created_at: Date;
  completed_at: Date | null;
  error: string | null;
}

function mapImportJob(row: ImportJobRow): PersistedImportJob {
  return {
    id: row.id,
    filename: row.filename,
    status: row.status,
    rowsRead: Number(row.rows_read),
    rowsProcessed: Number(row.rows_processed),
    rowsSucceeded: Number(row.rows_succeeded),
    rowsFailed: Number(row.rows_failed),
    totalRows: row.total_rows === null ? null : Number(row.total_rows),
    enqueueCompletedAt: row.enqueue_completed_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

function queryRows(result: unknown): unknown[] {
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result as unknown[];
}
