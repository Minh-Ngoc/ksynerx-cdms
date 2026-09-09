import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'import_batch_accounting' })
export class ImportBatchAccountingEntity {
  @PrimaryColumn({ name: 'import_id', type: 'uuid' })
  importId!: string;

  @PrimaryColumn({ name: 'batch_id', type: 'varchar', length: 255 })
  batchId!: string;

  @Column({ name: 'rows_processed', type: 'integer' })
  rowsProcessed!: number;

  @Column({ name: 'rows_succeeded', type: 'integer' })
  rowsSucceeded!: number;

  @Column({ name: 'rows_failed', type: 'integer' })
  rowsFailed!: number;

  @CreateDateColumn({ name: 'accounted_at', type: 'timestamptz' })
  accountedAt!: Date;
}
