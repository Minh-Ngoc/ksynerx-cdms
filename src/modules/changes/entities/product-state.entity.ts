import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'product_state' })
export class ProductStateEntity {
  @PrimaryColumn({ name: 'product_id', type: 'varchar', length: 128 })
  productId!: string;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'varchar', length: 128 })
  fingerprint!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
