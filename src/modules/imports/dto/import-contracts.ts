export { ImportStatus as ImportJobStatus } from '../entities/import-job.entity.js';
import { ImportStatus } from '../entities/import-job.entity.js';

export interface ImportCreateResponse {
  importId: string;
  status: ImportStatus.Processing;
}

export interface ImportStatusResponse {
  id: string;
  filename: string;
  status: ImportStatus;
  rowsRead: number;
  rowsProcessed: number;
  rowsSucceeded: number;
  rowsFailed: number;
  totalRows: number | null;
  enqueueCompletedAt: string | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface ImportProgressSnapshot {
  importId: string;
  status: ImportStatus;
  rowsRead: number;
  rowsProcessed: number;
  rowsSucceeded: number;
  rowsFailed: number;
  totalRows: number | null;
  percent: number | null;
}

export type ImportProgressEventName = 'progress' | 'completed' | 'failed';

export interface ImportProgressEvent {
  event: ImportProgressEventName;
  data: ImportProgressSnapshot;
}

type ProgressInput = Omit<ImportProgressSnapshot, 'percent'>;

export function createImportProgressSnapshot(input: ProgressInput): ImportProgressSnapshot {
  const percent = input.totalRows === null
    ? null
    : input.totalRows === 0
      ? input.status === ImportStatus.Completed ? 100 : null
      : Math.min(100, Math.round((input.rowsProcessed / input.totalRows) * 100));

  return {
    ...input,
    percent,
  };
}
