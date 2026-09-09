# Exactly-Once Effect

This prototype provides exactly-once effect at the PostgreSQL/business level. It does not provide exactly-once message delivery. BullMQ retries and duplicate deliveries are expected inputs.

## Decision table

| Incoming input | Current state | Result | Database effect |
|---|---|---|---|
| lower version | newer version exists | `STALE` | no write |
| same version, same canonical fingerprint | same state | `DUPLICATE` | no write |
| same version, different fingerprint | same state | `VERSION_CONFLICT` | no overwrite |
| newer version or no current state | current absent/older | `ACCEPTED` | history, state, and outbox write |

The fingerprint uses the canonical payload only. Price is a normalized decimal string compatible with PostgreSQL `NUMERIC(18,2)`, and canonical JSON key order is explicit. Delivery metadata such as source and observed time does not create a false same-version conflict.

## Serialization and transaction

Each product is serialized with `pg_advisory_xact_lock` acquired through the transaction-bound TypeORM manager before reading `product_state`. The key is the first eight bytes of SHA-256 over the trimmed UTF-8 product ID, interpreted as a signed PostgreSQL `bigint`. This is deterministic across processes and restarts. A 64-bit collision can serialize unrelated products, but cannot corrupt data because the lock only adds ordering.

The lock covers missing-row and existing-row races. The unique `(product_id, version)` constraint remains a defensive database invariant. An accepted change inserts `product_changes`, upserts `product_state`, and inserts `outbox_events` in one PostgreSQL transaction.

## Progress is separate

Business idempotency is product/version/fingerprint based in `ChangeProcessor`. Import progress idempotency is `importId + batchId` based in `import_batch_accounting`. Aggregate counters alone cannot identify a worker replay after PostgreSQL commits but before BullMQ acknowledges the job. The accounting table stores only a terminal progress delta; it is not a PostgreSQL Inbox Pattern and does not store message payloads or business state.

The uploader owns `rowsRead`. Batch workers own terminal `rowsProcessed`, `rowsSucceeded`, and `rowsFailed`. PostgreSQL preserves `rowsProcessed = rowsSucceeded + rowsFailed` and `rowsProcessed <= rowsRead`. Completion requires both `enqueue_completed_at IS NOT NULL` and `rowsProcessed = rowsRead`.

## Evidence

Task 23 verified 100 concurrent identical first writes produce one accepted effect and 99 duplicate outcomes, including the missing-row race. Concurrent versions 5 and 6 leave final state at version 6. Same-version competing payloads produce `VERSION_CONFLICT` rather than last-writer-wins. A worker concurrency of 8 still produced one logical database effect in the integration proof. These tests demonstrate the invariants at tested concurrency; they do not certify infinite-scale correctness.
