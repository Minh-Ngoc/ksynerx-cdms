export enum ImportJobStatus {
  Created = 'CREATED',
  Uploading = 'UPLOADING',
  Processing = 'PROCESSING',
  Completed = 'COMPLETED',
  Failed = 'FAILED',
}

export interface ImportCreateResponse {
  importId: string;
  status: ImportJobStatus.Processing;
}

export interface ImportStatusResponse {
  id: string;
  filename: string;
  status: ImportJobStatus;
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
  id: string;
  status: ImportJobStatus;
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
  return {
    ...input,
    percent:
      input.totalRows === null || input.totalRows === 0
        ? null
        : Math.min(100, Math.round((input.rowsProcessed / input.totalRows) * 100)),
  };
}
