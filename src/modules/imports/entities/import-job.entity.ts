import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export enum ImportStatus {
  Created = 'CREATED',
  Uploading = 'UPLOADING',
  Processing = 'PROCESSING',
  Completed = 'COMPLETED',
  Failed = 'FAILED',
}

@Entity({ name: 'import_jobs' })
export class ImportJobEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  filename!: string;

  @Column({ type: 'varchar', length: 32 })
  status!: ImportStatus;

  @Column({ name: 'rows_read', type: 'integer', default: 0 })
  rowsRead!: number;

  @Column({ name: 'rows_processed', type: 'integer', default: 0 })
  rowsProcessed!: number;

  @Column({ name: 'rows_succeeded', type: 'integer', default: 0 })
  rowsSucceeded!: number;

  @Column({ name: 'rows_failed', type: 'integer', default: 0 })
  rowsFailed!: number;

  @Column({ name: 'total_rows', type: 'integer', nullable: true })
  totalRows!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ name: 'enqueue_completed_at', type: 'timestamptz', nullable: true })
  enqueueCompletedAt!: Date | null;
}
