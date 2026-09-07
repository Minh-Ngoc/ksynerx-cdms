import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export enum OutboxStatus {
  Pending = 'PENDING',
  Publishing = 'PUBLISHING',
  Published = 'PUBLISHED',
  Failed = 'FAILED',
}

@Entity({ name: 'outbox_events' })
export class OutboxEventEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'aggregate_id', type: 'varchar', length: 128 })
  aggregateId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 128 })
  eventType!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 32 })
  status!: OutboxStatus;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;
}
