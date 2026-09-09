# Spec: Change Data Management Service Prototype

## 1. Objective

Build a prototype Change Data Management Service (CDMS) for product and inventory changes. The system receives changes from scheduled polling, webhook callbacks, and streamed Excel uploads, normalizes them into one internal contract, buffers processing through BullMQ, and persists only valid new logical changes in PostgreSQL.

Success means the prototype demonstrates duplicate handling, stale update prevention, concurrent processing correctness, failure handling, asynchronous buffering, streaming Excel ingestion, real progress streaming, clear documentation, and one-machine containerized operation.

## 2. Scope

In scope:

- Product/inventory data only.
- Inventory emulator inside the same NestJS project.
- CDMS ingestion through polling, webhook, and Excel upload.
- Common normalized change processing.
- TypeORM entities and migrations for product state, product changes, outbox events, import jobs, and inventory emulator products.
- Redis/BullMQ queues and bounded workers.
- Transactional outbox.
- Import progress via SSE.
- Unit, integration, concurrency, e2e, and k6 spike tests.
- Bilingual documentation in English and Vietnamese.

## 3. Non-Goals

- No production-grade distributed architecture.
- No monorepo.
- No microservices source split.
- No Kafka, Temporal, Airflow, Kubernetes, RabbitMQ, NATS, or event sourcing.
- No PostgreSQL Inbox Pattern unless explicitly approved.
- No authentication or authorization unless added by a later approved spec.
- No full inventory domain beyond product and inventory fields needed for the assignment.

## 4. Functional Requirements

- Inventory emulator exposes product list, product detail, product create, and product update endpoints.
- Product mutations increment `version` monotonically.
- Inventory emulator seed volume defaults to `INVENTORY_SEED_COUNT=1000` and is configurable.
- Webhook endpoint accepts inventory changes only after validation and successful enqueue.
- Polling reads changes incrementally and advances its checkpoint only after enqueue succeeds.
- Excel import endpoint streams multipart upload through a streaming parser, validates rows, normalizes rows, and enqueues bounded batches.
- Import jobs are persisted and report durable status.
- SSE endpoint streams latest import progress snapshots and completion/failure events.
- Workers process normalized changes through one shared change processor.
- Duplicate logical changes do not create extra `product_changes` rows.
- Stale versions never regress `product_state`.
- Same product/version with different fingerprint is reported as `VERSION_CONFLICT`.
- Accepted changes insert history, update latest state, and insert an outbox event atomically.
- Outbox publisher publishes pending committed events with retry and duplicate-publication tolerance.
- Outbox downstream publication uses a dedicated BullMQ queue with a minimal duplicate-tolerant downstream consumer that may perform structured logging only.

## 5. Non-Functional Requirements

- Use strict TypeScript and NestJS dependency injection.
- Use TypeORM migrations, not `synchronize: true`.
- Keep worker concurrency configurable and bounded.
- Avoid unbounded Redis growth during Excel uploads.
- Do not keep whole Excel files or all rows in memory.
- Use structured logs with contextual fields.
- Avoid logging raw large payloads or full Excel contents.
- Document every persistence, concurrency, and durability limitation.

## 6. Architecture

All ingestion paths normalize into the same contract:

```text
Polling -----\
Webhook ------> Normalize -> BullMQ -> bounded worker -> ChangeProcessor -> PostgreSQL transaction
Excel stream -/
```

BullMQ absorbs spikes, buffers work, provides retry, and limits processing concurrency. PostgreSQL enforces correctness with transactions, constraints, locks, and idempotent writes.

The outbox path starts only after business processing succeeds:

```text
DB transaction -> product_changes + product_state + outbox_events -> commit -> Outbox Publisher -> BullMQ/downstream
```

## 7. NestJS Module Boundaries

Planned module boundaries:

- `config`: validated environment configuration.
- `database`: TypeORM setup, data source, migrations.
- `inventory`: emulator endpoints and product persistence.
- `changes`: normalized contract, fingerprinting, and transactional change processing.
- `queue`: BullMQ queue producers and workers.
- `ingestion`: webhook and polling normalization.
- `imports`: streaming Excel upload, import jobs, progress, SSE.
- `outbox`: outbox entity, claiming, publishing, and retry state.
- `health`: service health endpoint.
- `common`: shared enums, types, filters, utilities, and logging helpers only when shared use is real.

Do not create empty modules or speculative abstractions just to match a target tree.

## 8. Runtime Topology

The source remains one NestJS project. Docker Compose may run multiple process roles from the same image:

- `cdms`: HTTP API and schedulers where appropriate.
- `worker`: separate BullMQ worker, outbox publisher, and downstream consumer process role.
- `postgres`: PostgreSQL database.
- `redis`: Redis for BullMQ and live progress coordination.

The worker must run as a separate process/container role for the prototype. It uses the same repository, the same NestJS source project, and preferably the same Docker image. This is not a microservice source split and not a monorepo. The separation exists for bounded processing concurrency, clearer failure isolation, and easier worker restart/failure demonstrations.

## 9. API Contracts

### Inventory Emulator

`GET /inventory/products`

- Query: optional stable composite cursor fields `updatedAfter` and `afterProductId` for incremental polling.
- Ordering: `ORDER BY updated_at ASC, id ASC`.
- Cursor semantics: return rows where `updated_at > lastUpdatedAt OR (updated_at = lastUpdatedAt AND id > lastProductId)`.
- Response: array of products.
- Status: `200`.

`GET /inventory/products/:id`

- Response: product.
- Status: `200`, `404`.

`POST /inventory/products`

- Request: `sku`, `name`, `price`, `quantity`.
- Behavior: creates version `1`.
- Status: `201`, `400`, `409` for duplicate SKU if enforced.

`PATCH /inventory/products/:id`

- Request: partial `sku`, `name`, `price`, `quantity`.
- Behavior: increments version monotonically.
- Status: `200`, `400`, `404`, `409` if conflict rules require it.

### CDMS

`POST /webhooks/inventory`

- Request: product id, version, source payload, and optional observed timestamp.
- Behavior: validate, normalize, enqueue.
- Status: `202` only after enqueue succeeds; `400` for invalid payload; `503` if Redis/BullMQ enqueue is unavailable.
- Retry semantics: caller may retry `503`; duplicates are safe at the database level.

`POST /imports/products`

- Request: multipart Excel file up to `IMPORT_MAX_FILE_SIZE_MB`, default `100`.
- Behavior: create import job, stream rows, validate, normalize, enqueue bounded batches.
- Response: `{ "importId": "...", "status": "PROCESSING" }`.
- Status: `202` after upload parsing/enqueueing finishes; `400` for malformed file/request; `503` or documented failure status if Redis fails beyond bounded retry.

`GET /imports/:id`

- Response: durable import job state.
- Status: `200`, `404`.

`GET /imports/:id/progress`

- Response: `text/event-stream`.
- Event names: `progress`, `completed`, `failed`.
- Behavior: send latest known snapshot first, then live updates.

`GET /health`

- Response: service and dependency health.
- Status: `200` when healthy, suitable error status when required dependencies are unavailable.

## 10. Database Schema

`product_state`

- `product_id` primary key.
- `version`.
- `fingerprint`.
- `payload jsonb`.
- `updated_at`.
- Purpose: latest accepted state per product.

`product_changes`

- `id uuid` primary key.
- `product_id`.
- `version`.
- `fingerprint`.
- `source`.
- `payload jsonb`.
- `created_at`.
- Unique constraint: `(product_id, version)`.
- Purpose: immutable accepted logical change history.

`outbox_events`

- `id uuid` primary key.
- `aggregate_id`.
- `event_type`.
- `payload jsonb`.
- `status`.
- `attempts`.
- `created_at`.
- `published_at nullable`.
- `last_error nullable`.

`import_jobs`

- `id uuid` primary key.
- `filename`.
- `status`: `CREATED`, `UPLOADING`, `PROCESSING`, `COMPLETED`, `FAILED`.
- `rows_read`.
- `rows_processed`.
- `rows_succeeded`.
- `rows_failed`.
- `total_rows nullable`.
- `created_at`.
- `completed_at nullable`.
- `error nullable`.

`inventory_products`

- `id`.
- `sku`.
- `name`.
- `price` as PostgreSQL `NUMERIC(18,2)`.
- `quantity`.
- `version`.
- `created_at`.
- `updated_at`.

## 11. Normalized Change Model

```ts
export enum ChangeSource {
  Polling = 'POLLING',
  Webhook = 'WEBHOOK',
  Excel = 'EXCEL',
}

export interface CanonicalProductPayload {
  sku: string;
  name: string;
  // Normalized decimal string derived from NUMERIC(18,2). Fingerprints use this exact representation.
  price: string;
  quantity: number;
}

export interface ProductChangeInput {
  productId: string;
  version: number;
  source: ChangeSource;
  payload: CanonicalProductPayload;
  observedAt: Date;
}
```

Ingress-specific DTOs must be normalized before reaching business processing. Business rules must not be duplicated across webhook, polling, and Excel paths.

## 12. Exactly-Once Effect

The prototype does not claim exactly-once message delivery. It provides exactly-once effect at the database/business level.

For each normalized input:

1. Start a PostgreSQL transaction.
2. Acquire the configured per-product concurrency protection.
3. Read `product_state`.
4. Compute deterministic fingerprint from canonical payload.
5. Apply version/fingerprint rules.
6. For accepted new changes, insert `product_changes`, upsert `product_state`, and insert `outbox_events` in the same transaction.

Processing results:

- `ACCEPTED`: no existing state or incoming version is newer.
- `STALE`: incoming version is lower than current state.
- `DUPLICATE`: incoming version equals current version and fingerprint matches.
- `VERSION_CONFLICT`: incoming version equals current version and fingerprint differs.
- `FAILED`: processing error outside expected semantic outcomes.

## 13. Concurrency Strategy

BullMQ concurrency controls throughput but is not the correctness mechanism. PostgreSQL transactions and constraints must remain correct even when multiple workers process the same product concurrently.

The planned strategy is a PostgreSQL transaction-scoped advisory lock keyed by `productId`, plus the `(product_id, version)` unique constraint as a defensive invariant. This handles existing-row and missing-row races with one per-product serialization point.

The advisory-lock key derivation must be deterministic, stable across processes and restarts, have documented collision behavior, and be tested. The implementation phase must verify the exact PostgreSQL and TypeORM APIs against official documentation before coding.

## 14. Missing-Row Race Strategy

`SELECT ... FOR UPDATE` cannot lock a row that does not exist. Concurrent first writes for the same product must be handled explicitly.

Chosen specification-level decision: use a transaction-scoped PostgreSQL advisory lock keyed by canonical `productId` before reading or writing state. This serializes first insert attempts for a product. The lock key must be derived deterministically and remain stable across processes/restarts. Collision behavior must be documented and covered by tests. The implementation must add an ADR and concurrency integration test proving many concurrent first writes produce exactly one accepted logical row.

## 15. BullMQ Ingress

All external ingestion paths enqueue normalized work before business processing. Return success to clients only after `queue.add()` succeeds. If Redis/BullMQ is unavailable before enqueue succeeds, the request is not durably accepted and must return a retriable failure.

BullMQ job IDs may be used for retry ergonomics, but database idempotency remains the correctness boundary.

## 16. Redis Failure Semantics

If Redis is unavailable before enqueue:

- Webhook returns `503` or documented retriable failure.
- Polling does not advance checkpoint and retries later.
- Excel upload pauses/retries within bounded policy or marks import `FAILED`.

If Redis fails after jobs were accepted, workers should reconnect and resume when possible.

Known limitation: catastrophic Redis data loss after an ingestion request has been acknowledged may lose queued but not yet persisted changes. This prototype does not introduce a PostgreSQL Inbox Pattern unless approved.

Excel imports use a bounded Redis enqueue retry timeout, default `IMPORT_REDIS_RETRY_TIMEOUT_MS=30000`. If Redis does not recover within the timeout, the import is marked `FAILED`.

## 17. Polling Checkpoint Semantics

Polling must use a stable composite cursor of `(updatedAt, productId)` rather than timestamp-only checkpointing. Inventory reads must use deterministic ordering:

```sql
ORDER BY updated_at ASC, id ASC
```

Cursor semantics are equivalent to:

```sql
updated_at > lastUpdatedAt
OR (updated_at = lastUpdatedAt AND id > lastProductId)
```

The checkpoint advances only after the entire fetched page has been successfully accepted by BullMQ. If any enqueue fails, the checkpoint remains at the previous value and the next cycle retries. Duplicate re-polling is preferred over skipped changes because database processing is idempotent.

## 18. Webhook Behavior

Webhook processing validates input, normalizes payload, enqueues normalized change, and returns `202 Accepted` only after successful enqueue. It must not insert business data directly or duplicate version/fingerprint logic.

## 19. Excel Streaming

Excel imports use a narrow internal streaming reader over the staged XLSX file. The flow has two bounded phases:

```text
multipart file stream -> bounded temporary XLSX file -> ZIP entry Readable -> SAX row stream -> object-mode batch Transform -> BullMQ Writable
```

Phase A streams multipart bytes to a generated, unique path under a controlled temporary directory. The client filename must not be used as a filesystem path. The temporary file is ingestion staging only, not durable storage, and must be removed in `finally` on success, parser failure, Redis retry timeout, upload limit failure, request/stream failure, or any other terminal ingestion error.

Phase B begins only after Phase A completes successfully. The reader opens only required ZIP entries, retains shared strings as a lookup table, and exposes worksheet rows through an object-mode Node stream. The batch Transform and BullMQ Writable must preserve Node stream backpressure so a pending queue write stops additional worksheet consumption. The server must not load the full upload, XLSX buffer, or worksheet row set into memory. It must not use `Buffer.concat`, `fs.readFile` for the upload, `Workbook.xlsx.load(buffer)`, `XLSX.read(fullBuffer)`, or an unbounded `allRows` collection.

Row processing is incremental and bounded with respect to worksheet rows and pending batches. Memory may still grow with workbook metadata and unique shared strings because the parser retains the shared-string table to resolve cells; the prototype does not claim constant workbook memory.

The default upload size limit is `IMPORT_MAX_FILE_SIZE_MB=100`. The limit must be enforced while streaming and must not require buffering the whole upload before rejection.

The HTTP request remains open through both phases. Return `202` only after the upload has staged, XLSX parsing has completed, the final partial batch has been submitted, and all pending enqueue operations succeeded. A full batch may enqueue before the XLSX parser reaches workbook EOF after bounded staging; it is not required to enqueue before HTTP upload EOF.

## 20. Backpressure

Use `IMPORT_BATCH_SIZE`, default `500`, and `IMPORT_MAX_PENDING_BATCHES`, default `100`. The implementation must bound in-flight or queued batches and must not busy-loop. Queue backlog inspection is acceptable, but it is not required on every batch if a cleaner bounded producer or semaphore strategy provides the same safety.

During Phase B, backpressure must pause XLSX row consumption while the current batch waits for Redis retry or capacity rather than reading and discarding workbook rows. During Phase A, the byte-limited write stream naturally applies backpressure to the multipart file stream.

## 21. Import Lifecycle

Persist import jobs with statuses:

- `CREATED`: job record exists.
- `UPLOADING`: upload stream is being read and parsed.
- `PROCESSING`: upload parsing/enqueueing completed; background jobs may still run.
- `COMPLETED`: all readable/enqueued rows reached a terminal row-processing outcome. This does not mean every row succeeded; `rowsFailed` may be greater than `0`.
- `FAILED`: the import itself could not continue or could not reach normal terminal processing.

The `POST /imports/products` connection remains open only while the server receives, parses, and enqueues the upload. It does not wait for all background processing to finish.

## 22. SSE Progress

`GET /imports/:id/progress` uses `text/event-stream` only for server-to-client progress/status. It sends the latest snapshot first. Fields:

- `rowsRead`.
- `rowsProcessed`.
- `rowsSucceeded`.
- `rowsFailed`.
- `totalRows`.
- `percent`.
- `status`.

`totalRows` may be null. `percent` must be null when total rows are unknown. Do not fabricate progress percentages.

Progress invariants:

- `rowsProcessed = rowsSucceeded + rowsFailed`.
- `rowsProcessed <= rowsRead`.
- For `COMPLETED`, `rowsProcessed = rowsRead`.

Concurrent progress updates must use atomic Redis operations. Do not implement progress counters with non-atomic read-modify-write.

PostgreSQL remains authoritative for durable progress and completion. Redis stores only an atomically written live snapshot after durable accounting commits. Each import batch carries a deterministic `batchId`, generated before its first enqueue and stable across BullMQ retries. The `import_batch_accounting` table stores only `(import_id, batch_id)` and the terminal aggregate delta; it does not store input payloads or business processing state and is not a PostgreSQL Inbox Pattern.

For a terminal batch, PostgreSQL inserts its accounting marker with `ON CONFLICT DO NOTHING`, applies `rowsProcessed`/`rowsSucceeded`/`rowsFailed` only when that insert succeeds, and evaluates completion in the same transaction. This prevents the crash window where progress commits, a worker dies before BullMQ acknowledges the job, and the replay would otherwise increment aggregate counters again. ChangeProcessor remains the separate business idempotency boundary.

On a non-final BullMQ attempt, an unexpected row-processing error fails the job without progress accounting. On the final permitted attempt, unexpected row errors are terminal row failures; remaining rows continue and the batch is accounted once. A `FAILED` import is never changed back to `PROCESSING` or `COMPLETED` by queued batch work.

## 23. Transactional Outbox

Accepted changes insert an outbox event in the same transaction as state/history writes. The publisher reads and claims pending events with bounded batches, publishes them to a dedicated BullMQ downstream queue, and marks them published only after successful enqueue. Failures increment attempts and store `last_error`.

The downstream queue has a minimal duplicate-tolerant downstream consumer that may only perform structured logging. Its purpose is to demonstrate actual asynchronous outbox publication without adding another service or infrastructure system. Duplicate downstream delivery is allowed, must not mutate business state, and must not violate database invariants. Duplicate structured log entries are acceptable for this prototype. Do not add a processed-events table, Inbox Pattern, or another persistence mechanism merely to deduplicate logs. The consumer is duplicate-tolerant, not strictly idempotent in terms of its observable logging side effect. If publication succeeds but marking published fails, duplicate publication is allowed. Accepted business changes and outbox rows are committed atomically. The outbox protects the PostgreSQL commit to asynchronous publication boundary; it does not provide exactly-once delivery.

## 24. Failure Matrix

| Scenario | Expected behavior | Retry behavior | Persistence behavior | Client behavior | Data loss | Support |
|---|---|---|---|---|---|---|
| Duplicate webhook delivery | Duplicate resolves to `DUPLICATE` | Safe retry | One `product_changes` row | Initial/duplicate enqueue returns `202` if Redis accepts | No DB duplicate | Supported |
| Concurrent webhook duplicates | PostgreSQL concurrency strategy serializes per product | Worker retry on transient DB error | One logical row | `202` after enqueue | No DB duplicate | Supported |
| Polling + webhook same change | Both normalize to same identity | Safe retry | One logical row | Webhook `202`; poll checkpoint advances after enqueue | No DB duplicate | Supported |
| Polling + webhook + Excel same change | Same as above across three sources | Safe retry | One logical row | Source-specific accepted responses after enqueue | No DB duplicate | Supported |
| Old version after new version | Result `STALE` | No semantic retry needed | State remains newer version | Accepted ingestion may still return `202` | No regression | Supported |
| Same version different payload | Result `VERSION_CONFLICT` with diagnostics | No automatic overwrite | State unchanged | Ingestion accepted if queued; conflict visible in logs/metrics/result | No silent overwrite | Supported |
| Concurrent first insert | Advisory lock plus unique constraint allows one acceptance | Transient retry if needed | One state row and one change row | Ingestion already accepted if queued | No DB duplicate | Supported |
| DB unavailable | Worker fails/retries | BullMQ retry/backoff | No partial commit | Ingestion may already be `202` if queued | No committed partial change | Supported |
| Redis unavailable before enqueue | Request is not accepted | Caller/poller/import retry | No queued work | Webhook/import returns retriable failure; polling checkpoint unchanged | No falsely accepted work | Supported |
| Redis unavailable during Excel upload | Pause/retry, then continue or fail import | Bounded retry | Import marked `FAILED` if retry window expires | Upload returns failure or failed import response | Already queued work may later complete | Supported with documented limits |
| Worker restart | Jobs resume when Redis persists them | BullMQ retry/resume | Idempotent DB processing | No direct client connection | Possible only under catastrophic Redis loss | Supported |
| Worker crash before DB commit | Transaction rolls back | Job retries | No partial commit | No direct client connection | No committed partial change | Supported |
| Worker crash after DB commit | Job may retry | Retry becomes duplicate/stale | Committed data remains | No direct client connection | No DB duplicate | Supported |
| Inventory emulator unavailable | Poll logs failure and keeps checkpoint | Next poll retries | No checkpoint corruption | Health may report dependency issue | No skipped polled changes | Supported |
| Outbox publish failure | Attempts increment and last error stored | Publisher retries | Event remains pending | Not client-visible | No lost committed event | Supported |
| Outbox duplicate publication | Downstream may see duplicate | Downstream handling must tolerate duplicate delivery; duplicate structured logs are acceptable | Outbox eventually marked published | Not client-visible | No committed event lost | Supported, duplicate possible |
| Malformed Excel row | Row counted failed; valid rows continue if file parse can continue | Row not retried unless file reuploaded | Import progress records failure | Progress shows failed row count | Malformed row not persisted | Supported |
| Oversized/large Excel | Streamed with bounded batches/backpressure | Import may fail if limits exceeded | No full-file RAM buffering | `202` or documented failure | No accepted DB duplicate | Supported |
| Queue backlog saturation | Producer pauses/throttles | Resume after backlog decreases | No unlimited Redis enqueue | Upload takes longer or fails on timeout | No read-and-discard | Supported |
| SSE reconnect | Latest snapshot sent first | Client reconnects manually | PostgreSQL retains durable progress | Receives current state then live events | No progress fabrication | Supported |

## 25. Observability

Use structured logs with fields such as `productId`, `version`, `source`, `importId`, `jobId`, `outboxEventId`, `result`, `durationMs`, and `attempt`. Log processing results as `ACCEPTED`, `STALE`, `DUPLICATE`, `VERSION_CONFLICT`, or `FAILED`. Do not log whole Excel files or large raw payloads.

## 26. Testing Strategy

Use Jest with NestJS testing utilities.

Unit tests:

- Normalization.
- Canonicalization.
- Fingerprint determinism.
- Version semantics.
- Excel row validation.

Integration tests:

- TypeORM transaction behavior.
- Unique constraints.
- Duplicate updates.
- Stale updates.
- Version conflicts.
- Outbox atomicity.
- Missing-row first insert race.

Concurrency tests:

- 100 concurrent attempts for the same `productId` and version persist exactly one logical change.
- Concurrent versions 5 and 6 leave final `product_state.version = 6`.
- No-existing-state race is tested separately.

E2E tests:

- Inventory endpoints.
- Webhook accepted/failure behavior.
- Import lifecycle and progress endpoint.
- Health endpoint.

Load tests:

- k6 spike representing many delivery attempts and fewer unique logical changes.
- Report total attempts, unique logical changes, persisted changes, duplicates prevented, stale updates prevented, latency percentiles, error rate, and queue backlog behavior.

## 27. Load Testing

Use k6 scripts under a dedicated load-test directory. Numbers may be scaled for a developer machine, but the test must prove that BullMQ absorbs spikes while bounded workers protect PostgreSQL. Post-test verification must query DB invariants rather than reporting throughput alone.

## 28. Docker Topology

Docker Compose must run on one machine with PostgreSQL, Redis, and the NestJS application. A separate worker container is required as a second process role using the same source/image, not a separate source application. The separate worker process/container role exists for bounded processing concurrency, clearer failure isolation, and worker restart/failure demonstrations.

## 29. Environment Variables

Expected environment variables:

- `PORT`.
- `DATABASE_HOST`.
- `DATABASE_PORT`.
- `DATABASE_NAME`.
- `DATABASE_USER`.
- `DATABASE_PASSWORD`.
- `REDIS_HOST`.
- `REDIS_PORT`.
- `POLL_INTERVAL_MS`.
- `INVENTORY_SEED_COUNT` default `1000`.
- `IMPORT_BATCH_SIZE`.
- `IMPORT_MAX_PENDING_BATCHES`.
- `IMPORT_MAX_FILE_SIZE_MB` default `100`.
- `IMPORT_REDIS_RETRY_TIMEOUT_MS` default `30000`.
- `CHANGE_WORKER_CONCURRENCY`.
- `OUTBOX_BATCH_SIZE`.
- `OUTBOX_POLL_INTERVAL_MS`.

Provide `.env.example` during implementation. Do not commit real credentials.

## 30. Documentation Rules

Persistent documentation must exist in both English and Vietnamese. English is canonical. Vietnamese must preserve the same semantics using natural technical Vietnamese. Planned documentation includes:

- `README.md` and `README.vi.md`.
- `docs/en/architecture.md` and `docs/vi/architecture.md`.
- `docs/en/exactly-once.md` and `docs/vi/exactly-once.md`.
- `docs/en/failure-handling.md` and `docs/vi/failure-handling.md`.
- `docs/en/excel-streaming.md` and `docs/vi/excel-streaming.md`.
- `docs/en/transactional-outbox.md` and `docs/vi/transactional-outbox.md`.
- `docs/en/redis-bullmq-failure-model.md` and `docs/vi/redis-bullmq-failure-model.md`.
- `docs/en/sse-progress.md` and `docs/vi/sse-progress.md`.
- `docs/en/testing.md` and `docs/vi/testing.md`.
- `docs/en/ai-usage.md` and `docs/vi/ai-usage.md`.
- ADRs under `docs/en/adr` and `docs/vi/adr`.

## 31. AI Disclosure

`docs/en/ai-usage.md` and `docs/vi/ai-usage.md` must accurately disclose architecture decisions, AI-assisted/generated code, reviewed or modified generated code, commands run, manually verified assumptions, and remaining unfinished work. Do not falsely claim AI-generated work was manually written.

## 32. Known Prototype Limitations

- Catastrophic Redis data loss after enqueue acknowledgement may lose queued but unpersisted changes.
- No PostgreSQL Inbox Pattern unless approved later.
- Outbox publication can be duplicated if publish succeeds but marking published fails.
- SSE is not durable messaging; it is a live status channel with database-backed snapshots.
- The inventory emulator exists only to support the assignment and should not become a full inventory system.

## 33. Acceptance Criteria

- `AGENTS.md`, `SPEC.md`, and `SPEC.vi.md` exist before implementation.
- Multiple ingestion sources converge into one normalized processing path.
- PostgreSQL, not BullMQ, enforces correctness.
- Duplicate delivery is harmless at the database level.
- Stale updates never regress state.
- Same-version payload conflicts are detected.
- Missing-row first-write race is explicitly solved and tested.
- Excel uploads are streamed with bounded batching and backpressure.
- SSE reports real progress only.
- Redis/BullMQ failure semantics are explicit.
- Transactional outbox protects committed changes from downstream dual-write loss.
- Docker Compose runs the prototype on one machine.
- Tests and k6 demonstrate the required invariants.
- English and Vietnamese docs are synchronized.

## 34. Engineering Boundaries

Always:

- One NestJS project.
- TypeORM and PostgreSQL.
- Redis/BullMQ before business processing.
- Migrations.
- Streamed Excel parsing.
- Bounded queue production.
- Database idempotency.
- Concurrency tests.
- Bilingual documentation.

Ask first:

- Monorepo.
- Kafka, Temporal, Airflow, Kubernetes, RabbitMQ, NATS.
- Inbox Pattern.
- Replacing PostgreSQL or TypeORM.
- Removing BullMQ.
- Changing durable acceptance or concurrency strategy.

Never:

- Full Excel file buffering.
- Fake SSE progress.
- Acknowledge a request when enqueue failed.
- Claim global exactly-once delivery.
- Rely solely on queue deduplication.
- Silently resolve version conflict.
- Skip database correctness tests.

## Commands

Current commands:

```bash
pnpm lint
pnpm build
pnpm test
pnpm test:e2e
```

Commands to add during implementation:

```bash
pnpm typecheck
pnpm test:integration
docker compose up --build
docker compose down -v
```

## Project Structure

Target structure, adjusted only when implementation proves a simpler feature-oriented structure is better:

```text
src/
  config/
  database/
  modules/
    inventory/
    ingestion/
    changes/
    imports/
    queue/
    outbox/
    health/
  common/
test/
docs/
  en/
  vi/
tasks/
```

## Code Style

Use strict TypeScript, explicit DTOs, NestJS DI, small services, and comments for non-obvious invariants:

```ts
async process(input: ProductChangeInput): Promise<ChangeResult> {
  return this.dataSource.transaction(async (manager) => {
    // The advisory lock serializes first-write races where no product_state row exists yet.
    await this.productLock.acquire(manager, input.productId);

    const current = await this.stateRepository.findOneForUpdate(manager, input.productId);
    return this.applyVersionRules(manager, current, input);
  });
}
```

## Open Questions

- No open architecture questions remain in the SPEC phase.
- Implementation must still verify PostgreSQL advisory lock APIs, TypeORM transaction behavior, BullMQ APIs, Excel streaming APIs, and NestJS SSE/multipart APIs against official documentation before coding.
