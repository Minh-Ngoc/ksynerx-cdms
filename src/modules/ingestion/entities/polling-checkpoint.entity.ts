import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'polling_checkpoints' })
export class PollingCheckpointEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'product_id', type: 'varchar', length: 128 })
  productId!: string;
}
