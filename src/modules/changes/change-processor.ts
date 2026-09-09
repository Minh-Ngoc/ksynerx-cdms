import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { OutboxStatus } from '../outbox/entities/outbox-event.entity.js';
import { fingerprintCanonicalProductPayload } from './product-canonicalization.js';
import { ProductChangeInput } from './product-change-contract.js';
import { ProductLockService } from './product-lock.service.js';

export enum ChangeProcessingResultKind {
  Accepted = 'ACCEPTED',
  Duplicate = 'DUPLICATE',
  Stale = 'STALE',
  VersionConflict = 'VERSION_CONFLICT',
}

export interface CurrentProductStateForDecision {
  version: number;
  fingerprint: string;
}

export interface ChangeProcessingResult {
  result: ChangeProcessingResultKind;
  productId: string;
  version: number;
}

export const PRODUCT_CHANGE_ACCEPTED_EVENT_TYPE = 'PRODUCT_CHANGE_ACCEPTED';

export function decideChangeProcessingResult(
  input: ProductChangeInput,
  current: CurrentProductStateForDecision | null,
): ChangeProcessingResultKind {
  if (current === null) {
    return ChangeProcessingResultKind.Accepted;
  }

  if (input.version < current.version) {
    return ChangeProcessingResultKind.Stale;
  }

  if (input.version > current.version) {
    return ChangeProcessingResultKind.Accepted;
  }

  const incomingFingerprint = fingerprintCanonicalProductPayload(input.payload);

  return incomingFingerprint === current.fingerprint
    ? ChangeProcessingResultKind.Duplicate
    : ChangeProcessingResultKind.VersionConflict;
}

@Injectable()
export class ChangeProcessor {
  constructor(
    private readonly dataSource: DataSource,
    private readonly productLock: ProductLockService,
  ) {}

  async process(input: ProductChangeInput): Promise<ChangeProcessingResult> {
    return this.dataSource.transaction(async (manager) => {
      // The advisory lock must happen before reading product_state. A first write has no row
      // for SELECT ... FOR UPDATE to protect, so this per-product lock is the serialization
      // point for both missing-row and existing-row races.
      await this.productLock.acquire(manager, input.productId);

      const fingerprint = fingerprintCanonicalProductPayload(input.payload);
      const current = await this.readCurrentState(manager, input.productId);
      const result = decideChangeProcessingResult(input, current);

      // Duplicate, stale, and same-version conflict are normal business outcomes. Returning
      // before writes keeps those outcomes side-effect free; unique(product_id, version)
      // remains a defensive invariant rather than the normal duplicate-detection path.
      if (result !== ChangeProcessingResultKind.Accepted) {
        return this.toResult(input, result);
      }

      // History, latest state, and outbox are committed as one unit. If the outbox insert or
      // any earlier write fails, PostgreSQL rolls the whole transaction back without manual
      // compensation, preserving the DB/business exactly-once effect.
      await manager.query(
        `
          INSERT INTO product_changes (id, product_id, version, fingerprint, source, payload)
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [randomUUID(), input.productId, input.version, fingerprint, input.source, input.payload],
      );

      await this.writeLatestState(manager, input, fingerprint);
      await this.insertOutboxEvent(manager, input, fingerprint);

      return this.toResult(input, ChangeProcessingResultKind.Accepted);
    });
  }

  private async readCurrentState(
    manager: EntityManager,
    productId: string,
  ): Promise<CurrentProductStateForDecision | null> {
    const [current] = await manager.query(
      'SELECT version, fingerprint FROM product_state WHERE product_id = $1',
      [productId],
    );

    return current === undefined
      ? null
      : {
          version: current.version,
          fingerprint: current.fingerprint,
        };
  }

  private async writeLatestState(
    manager: EntityManager,
    input: ProductChangeInput,
    fingerprint: string,
  ): Promise<void> {
    await manager.query(
      `
        INSERT INTO product_state (product_id, version, fingerprint, payload, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (product_id) DO UPDATE
        SET version = EXCLUDED.version,
            fingerprint = EXCLUDED.fingerprint,
            payload = EXCLUDED.payload,
            updated_at = EXCLUDED.updated_at
      `,
      [input.productId, input.version, fingerprint, input.payload, input.observedAt],
    );
  }

  private async insertOutboxEvent(
    manager: EntityManager,
    input: ProductChangeInput,
    fingerprint: string,
  ): Promise<void> {
    await manager.query(
      `
        INSERT INTO outbox_events (id, aggregate_id, event_type, payload, status, attempts)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        randomUUID(),
        input.productId,
        PRODUCT_CHANGE_ACCEPTED_EVENT_TYPE,
        {
          productId: input.productId,
          version: input.version,
          fingerprint,
          source: input.source,
          payload: input.payload,
          observedAt: input.observedAt.toISOString(),
        },
        OutboxStatus.Pending,
        0,
      ],
    );
  }

  private toResult(input: ProductChangeInput, result: ChangeProcessingResultKind): ChangeProcessingResult {
    return {
      result,
      productId: input.productId,
      version: input.version,
    };
  }
}
