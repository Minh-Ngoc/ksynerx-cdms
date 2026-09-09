import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { PollingCheckpointStore, PollingCursor } from './polling.service.js';

interface PollingCheckpointRow {
  updated_at: Date;
  product_id: string;
}

@Injectable()
export class PollingCheckpointRepository implements PollingCheckpointStore {
  constructor(private readonly dataSource: DataSource) {}

  async read(name: string): Promise<PollingCursor | null> {
    const [row] = (await this.dataSource.query(
      `
        SELECT updated_at, product_id
        FROM polling_checkpoints
        WHERE name = $1
      `,
      [name],
    )) as PollingCheckpointRow[];

    if (!row) {
      return null;
    }

    return { updatedAt: row.updated_at, productId: row.product_id };
  }

  async write(name: string, cursor: PollingCursor): Promise<void> {
    // The single stream checkpoint is created on first successful poll and atomically replaced later;
    // no product version, job id, or fingerprint belongs in this cursor state.
    await this.dataSource.query(
      `
        INSERT INTO polling_checkpoints (name, updated_at, product_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (name)
        DO UPDATE SET updated_at = EXCLUDED.updated_at, product_id = EXCLUDED.product_id
      `,
      [name, cursor.updatedAt, cursor.productId],
    );
  }
}
