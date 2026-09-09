import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { OutboxStatus } from './entities/outbox-event.entity.js';
import type { OutboxEventForPublication } from './outbox-wire-contracts.js';

interface OutboxEventRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

@Injectable()
export class OutboxPublisherRepository {
  constructor(private readonly dataSource: DataSource) {}

  async withClaimedBatch<T>(
    batchSize: number,
    publish: (events: OutboxEventForPublication[], manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      const events = await this.claimPending(manager, batchSize);
      return publish(events, manager);
    });
  }

  async claimPending(manager: EntityManager, batchSize: number): Promise<OutboxEventForPublication[]> {
    // SKIP LOCKED lets multiple worker processes scan the same pending set without double-claiming
    // rows. The bounded transaction intentionally holds row locks through queue publication so only
    // one publisher owns each claimed event; the accepted trade-off is a short DB transaction over a
    // small OUTBOX_BATCH_SIZE rather than adding Redis locks or another persistence pattern.
    const rows = (await manager.query(
      `
        SELECT id, aggregate_id, event_type, payload, created_at
        FROM outbox_events
        WHERE status = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      `,
      [OutboxStatus.Pending, batchSize],
    )) as OutboxEventRow[];

    return rows.map((row) => ({
      id: row.id,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload,
      createdAt: row.created_at,
    }));
  }

  async markPublished(manager: EntityManager, id: string): Promise<void> {
    await manager.query(
      `
        UPDATE outbox_events
        SET status = $2,
            published_at = $3,
            last_error = NULL
        WHERE id = $1
      `,
      [id, OutboxStatus.Published, new Date()],
    );
  }

  async recordPublicationFailure(manager: EntityManager, id: string, lastError: string): Promise<void> {
    await manager.query(
      `
        UPDATE outbox_events
        SET attempts = attempts + 1,
            last_error = $2,
            status = $3
        WHERE id = $1
      `,
      [id, lastError, OutboxStatus.Pending],
    );
  }
}
