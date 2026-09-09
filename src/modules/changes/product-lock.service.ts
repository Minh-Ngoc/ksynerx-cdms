import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

export interface AdvisoryLockKey {
  readonly value: bigint;
  readonly parameter: string;
}

export class ProductLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductLockError';
  }
}

export const PRODUCT_LOCK_KEY_DERIVATION_CONTRACT = {
  algorithm: 'sha256(productId UTF-8) first 8 bytes interpreted as signed 64-bit big-endian',
  collisionBehavior:
    'A 64-bit hash collision serializes unrelated products but does not corrupt data because advisory locks only add ordering.',
} as const;

@Injectable()
export class ProductLockService {
  deriveAdvisoryKey(productId: string): AdvisoryLockKey {
    const normalizedProductId = this.normalizeProductId(productId);
    const digest = createHash('sha256').update(normalizedProductId, 'utf8').digest();

    // A SHA-256 prefix gives a deterministic process-independent key for any UTF-8 productId.
    // PostgreSQL's one-key advisory API is signed int64, so the bytes are interpreted as
    // signed big-endian and kept as BigInt/string instead of unsafe JavaScript Number.
    const value = digest.readBigInt64BE(0);

    return {
      value,
      parameter: value.toString(),
    };
  }

  async acquire(manager: EntityManager, productId: string): Promise<void> {
    const key = this.deriveAdvisoryKey(productId);

    if (manager.queryRunner === undefined) {
      throw new ProductLockError('Product advisory lock must be acquired through a transaction-bound manager');
    }

    // The advisory lock is meaningful only on the same transaction connection that will later
    // read/write product_state. pg_advisory_xact_lock is transaction-scoped, so PostgreSQL
    // releases it on COMMIT/ROLLBACK and no explicit unlock should be issued.
    await manager.query('SELECT pg_advisory_xact_lock($1::bigint)', [key.parameter]);
  }

  private normalizeProductId(productId: string): string {
    if (typeof productId !== 'string') {
      throw new ProductLockError('productId must be a string');
    }

    const normalizedProductId = productId.trim();
    if (normalizedProductId.length === 0) {
      throw new ProductLockError('productId must not be empty');
    }

    return normalizedProductId;
  }
}
