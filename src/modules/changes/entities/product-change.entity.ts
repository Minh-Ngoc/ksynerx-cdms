import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

export enum ChangeSource {
  Polling = 'POLLING',
  Webhook = 'WEBHOOK',
  Excel = 'EXCEL',
}

@Entity({ name: 'product_changes' })
@Index('uq_product_changes_product_id_version', ['productId', 'version'], { unique: true })
export class ProductChangeEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'product_id', type: 'varchar', length: 128 })
  productId!: string;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'varchar', length: 128 })
  fingerprint!: string;

  @Column({ type: 'varchar', length: 32 })
  source!: ChangeSource;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
