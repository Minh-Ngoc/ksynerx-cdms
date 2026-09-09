# Implementation Plan: CDMS Prototype

## Scope

This plan implements the approved `SPEC.md` without changing its architecture. The project remains one NestJS source project with a separate worker process/container role, PostgreSQL as the correctness boundary, Redis/BullMQ before business processing, a stable polling composite cursor, streamed Excel ingestion with bounded backpressure, Redis failure semantics, transactional outbox, a dedicated downstream BullMQ queue, and SSE progress semantics.

## Source Verification Completed for Planning

- NestJS BullMQ: `@nestjs/bullmq`, `BullModule.registerQueue()`, queue injection, processors, and queue/worker events are documented in https://docs.nestjs.com/techniques/queues.
- NestJS Schedule: `@nestjs/schedule` and `ScheduleModule.forRoot()` are documented in https://docs.nestjs.com/techniques/task-scheduling.
- NestJS SSE: `@Sse()` routes return `Observable<MessageEvent>` streams per https://docs.nestjs.com/techniques/server-sent-events.
- NestJS multipart/file upload: the official Nest file upload guide is Multer-based and exposes `MulterModule`/interceptors at https://docs.nestjs.com/techniques/file-upload. Because the SPEC requires true streaming and no full-file buffering, implementation must verify the chosen streaming multipart parser before coding the import endpoint.
- TypeORM transactions and `QueryRunner`: documented in https://typeorm.io/docs/transactions/.
- PostgreSQL transaction-level advisory locks: documented in https://www.postgresql.org/docs/current/explicit-locking.html.
- BullMQ concurrency and retry/backoff: documented in https://docs.bullmq.io/guide/workers/concurrency and https://docs.bullmq.io/guide/retrying-failing-jobs.
- Excel streaming qualification: `exceljs@4.4.0` documented `WorkbookReader` failed on an ExcelJS-generated valid XLSX. `xlsx-extract@0.2.0` and `xlsx-stream-reader@1.1.1` were rejected because their EventEmitter row APIs run ahead of an asynchronous consumer and cannot provide the required producer-side backpressure. Task 19 uses a narrow internal reader built on `yauzl` ZIP entry streams and `sax`, exposing worksheet rows through a Node object-mode stream. It requires bounded temporary-file staging; it retains workbook metadata and shared strings, but not the XLSX buffer or all worksheet rows/cells.

No official documentation reviewed for the plan contradicts the approved SPEC.

## Dependency Ordering

Foundation tasks create Jest/config/Docker/database primitives first. Contract and pure business tests come before transactional implementation. Queue, worker, webhook, and polling are built after the normalized contract and database processor exist. Import streaming/progress/SSE follows queue infrastructure. Documentation, ADRs, k6, review, and simplification close the plan.

## Highest-Risk Tasks

- Task 9 advisory-lock helper: correctness depends on stable key derivation and PostgreSQL lock behavior.
- Task 10 transactional ChangeProcessor: core database exactly-once effect, duplicate/stale/conflict semantics, and outbox atomicity.
- Task 19 Excel streaming/backpressure: must enforce limits without buffering and must handle Redis failure during upload.
- Task 20 atomic progress counters: concurrent worker updates must preserve invariants.
- Task 23 concurrency/failure tests: proves the assignment’s most important invariants.

## Task List

### Task 1: Align Tooling Around Jest and Strict Verification

**Objective:** Replace starter Vitest setup with Jest-based NestJS testing utilities and add missing verification scripts.

**Dependencies:** None.

**Files/modules expected to change:** `package.json`, Jest config files, `test/`, `tsconfig*.json`, starter test files.

**Implementation scope:** Configure Jest for unit, integration, and e2e tests; add `pnpm typecheck`; remove Vitest usage unless explicitly approved later.

**Test strategy:** Convert the starter e2e smoke test to Jest and add one trivial unit smoke test.

**Verification commands:** `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`.

**Acceptance criteria:** Jest runs successfully; Vitest is not required; TypeScript strict settings remain enabled.

**Documentation impact:** Update README command references later in documentation tasks.

**Comment requirements:** No complex logic expected; do not comment obvious config.

### Task 2: Bootstrap Config and Environment Validation

**Objective:** Add validated environment configuration for API, worker, database, Redis, polling, import, and outbox settings.

**Dependencies:** Task 1.

**Files/modules expected to change:** `src/config/*`, `src/app.module.ts`, `.env.example`, `package.json`.

**Implementation scope:** Add config module, environment schema, defaults from SPEC, and typed config access.

**Test strategy:** Unit tests for defaults, invalid values, and required secrets/placeholders.

**Verification commands:** `pnpm typecheck`, `pnpm test -- config`.

**Acceptance criteria:** Invalid config fails startup; defaults include `INVENTORY_SEED_COUNT=1000`, `IMPORT_MAX_FILE_SIZE_MB=100`, `IMPORT_REDIS_RETRY_TIMEOUT_MS=30000`.

**Documentation impact:** Mention final config in README/docs.

**Comment requirements:** Comment non-obvious validation bounds and why defaults protect prototype behavior.

### Task 3: Docker Compose and Process Roles

**Objective:** Add single-machine Docker Compose topology with `cdms`, `worker`, `postgres`, and `redis`.

**Dependencies:** Task 2.

**Files/modules expected to change:** `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `package.json`, `.env.example`.

**Implementation scope:** Use same repository/source/image for API and worker commands; add health-friendly startup configuration.

**Test strategy:** Compose smoke test after dependent runtime code exists; initial task verifies config generation and image build.

**Verification commands:** `docker compose config`, `docker compose build`.

**Acceptance criteria:** API and worker are separate process roles; no monorepo or microservice source split is introduced.

**Documentation impact:** Later Docker docs and ADR-001.

**Comment requirements:** Comment only non-obvious Docker command/process-role trade-offs.

### Task 4: Database Module, Data Source, and Initial Migrations

**Objective:** Add TypeORM PostgreSQL setup and migrations for all approved core tables.

**Dependencies:** Task 2.

**Files/modules expected to change:** `src/database/*`, `src/modules/*/entities/*`, `src/database/migrations/*`, `package.json`.

**Implementation scope:** Define entities and migrations for `inventory_products`, `product_state`, `product_changes`, `outbox_events`, `import_jobs`, and polling checkpoint if needed. `import_jobs` must include a durable ingestion/enqueue completion signal, preferably `enqueue_completed_at timestamptz nullable`, to distinguish "workers are currently caught up" from "upload parsing and enqueue production finished."

**Test strategy:** Migration integration test on empty PostgreSQL; schema constraint checks.

**Verification commands:** `pnpm typecheck`, `pnpm test:integration -- database`, migration run command, migration revert command.

**Acceptance criteria:** Migrations create schema from empty DB; `(product_id, version)` unique constraint exists; import job schema includes the durable enqueue-completion signal; `synchronize: true` is not used.

**Documentation impact:** Database schema docs and ADR-002.

**Comment requirements:** Comment unusual TypeORM/PostgreSQL migration choices and invariant-enforcing constraints.

### Task 5: API Contract DTOs and Error Shape

**Objective:** Decompose REST API contracts into DTOs, response types, and consistent structured error semantics.

**Dependencies:** Tasks 1-2.

**Files/modules expected to change:** `src/common/*`, `src/modules/*/dto/*`, controller specs.

**Implementation scope:** Define public request/response DTOs for inventory, webhook, imports, progress, and health without implementing business logic.

**Test strategy:** DTO validation tests and API contract snapshots for status/error shape.

**Verification commands:** `pnpm typecheck`, `pnpm test -- dto`.

**Acceptance criteria:** Contracts match SPEC; external inputs are validated at boundaries; response fields use stable camelCase names.

**Documentation impact:** API docs later.

**Comment requirements:** Comment non-obvious validation decisions and retry/status semantics.

### Task 6: Canonical Normalization and Fingerprinting Tests First

**Objective:** Add failing tests for normalization, canonical decimal price strings, canonical JSON, and SHA-256 fingerprints.

**Dependencies:** Task 5.

**Files/modules expected to change:** `src/modules/changes/**/*.spec.ts`, `src/modules/ingestion/**/*.spec.ts`, `src/modules/imports/**/*.spec.ts`.

**Implementation scope:** Tests only where practical: payload canonicalization, decimal normalization, deterministic key ordering, and source normalization.

**Test strategy:** Red tests for equivalent payloads producing identical fingerprints and different payloads producing different fingerprints.

**Verification commands:** `pnpm test -- fingerprint`.

**Acceptance criteria:** Tests fail before implementation and cover polling, webhook, and Excel normalization paths.

**Documentation impact:** None yet.

**Comment requirements:** Test names should document invariants; no production comments yet.

### Task 7: Canonical Normalization and Fingerprinting Implementation

**Objective:** Implement shared normalization and fingerprinting used by all ingestion paths.

**Dependencies:** Task 6.

**Files/modules expected to change:** `src/modules/changes/*`, `src/modules/ingestion/*`, `src/modules/imports/*`, tests.

**Implementation scope:** Deterministic canonical JSON, normalized `NUMERIC(18,2)` decimal string, `ProductChangeInput`, `ChangeSource`, and shared mappers.

**Test strategy:** Make Task 6 tests pass; add edge cases for whitespace, decimal scale, and field ordering.

**Verification commands:** `pnpm typecheck`, `pnpm test -- fingerprint`.

**Acceptance criteria:** All sources produce the same canonical payload for the same product state; fingerprints are deterministic and not globally unique.

**Documentation impact:** Exactly-once/fingerprinting docs later.

**Comment requirements:** Comment why canonical decimal and key ordering exist, what duplicate invariant they protect, and the trade-off of not making fingerprint globally unique.

### Task 8: Advisory Lock Helper Tests First

**Objective:** Add tests proving deterministic advisory-lock key derivation and documenting collision behavior.

**Dependencies:** Task 1.

**Files/modules expected to change:** `src/modules/changes/*lock*.spec.ts`, integration test setup.

**Implementation scope:** Tests for stable process-independent key derivation and integration test skeleton for transaction-scoped lock behavior.

**Test strategy:** Unit tests for same product -> same key, different products -> expected distribution, restart-independent fixture values; integration test for lock blocking/serialization.

**Verification commands:** `pnpm test -- advisory`, `pnpm test:integration -- advisory`.

**Acceptance criteria:** Tests define collision behavior and fail before helper implementation where practical.

**Documentation impact:** ADR-010 later.

**Comment requirements:** Test descriptions must state missing-row race invariant.

### Task 9: Advisory Lock Helper Implementation

**Objective:** Implement PostgreSQL transaction-scoped advisory lock acquisition through TypeORM.

**Dependencies:** Tasks 4 and 8.

**Files/modules expected to change:** `src/modules/changes/product-lock.service.ts`, integration tests.

**Implementation scope:** Derive stable advisory key from productId, acquire `pg_advisory_xact_lock` within the same transaction manager/query runner, and expose a narrow helper.

**Test strategy:** Pass unit and integration advisory-lock tests.

**Verification commands:** `pnpm typecheck`, `pnpm test -- advisory`, `pnpm test:integration -- advisory`.

**Acceptance criteria:** Lock is transaction-scoped, deterministic, stable across restarts, collision behavior documented/tested.

**Documentation impact:** ADR-010 and concurrency docs later.

**Comment requirements:** Comment why row locks cannot protect missing rows, invariant protected, collision trade-off, and transaction-scoped release behavior.

### Task 10: ChangeProcessor Behavior Tests First

**Objective:** Add tests for accepted, duplicate, stale, version-conflict, outbox atomicity, and concurrent order behavior.

**Dependencies:** Tasks 4, 7, and 9.

**Files/modules expected to change:** `src/modules/changes/**/*.spec.ts`, `test/integration/**/*.spec.ts`.

**Implementation scope:** Tests first for version matrix and transaction outcomes.

**Test strategy:** Unit tests for decision table; integration tests for DB rows and rollback behavior.

**Verification commands:** `pnpm test -- change-processor`, `pnpm test:integration -- changes`.

**Acceptance criteria:** Tests prove duplicate/stale/conflict cases and fail before implementation where practical.

**Documentation impact:** None yet.

**Comment requirements:** Test cases must name the business invariant being protected.

### Task 11: Transactional ChangeProcessor Implementation

**Objective:** Implement exactly-once effect at the database/business level.

**Dependencies:** Task 10.

**Files/modules expected to change:** `src/modules/changes/*`, `src/modules/outbox/*`, tests.

**Implementation scope:** Transactional processing, advisory lock use, state read, version/fingerprint decision table, history insert, state upsert, outbox insert, structured result.

**Test strategy:** Pass Task 10 tests and add transient DB failure rollback test if needed.

**Verification commands:** `pnpm typecheck`, `pnpm test -- change-processor`, `pnpm test:integration -- changes`.

**Acceptance criteria:** `ACCEPTED`, `DUPLICATE`, `STALE`, and `VERSION_CONFLICT` behave exactly as SPEC; accepted writes are atomic with outbox.

**Documentation impact:** Exactly-once docs and ADR-004/005/006 later.

**Comment requirements:** Comment transaction boundary, advisory lock ordering, decision table invariants, duplicate/stale/conflict edge cases, and outbox atomicity trade-off.

### Task 12: Inventory Emulator

**Objective:** Implement inventory product persistence, seed data, and emulator endpoints.

**Dependencies:** Tasks 4 and 5.

**Files/modules expected to change:** `src/modules/inventory/*`, migrations/tests if needed.

**Implementation scope:** CRUD-limited emulator endpoints, version increment on mutation, composite cursor list query, configurable seed count.

**Test strategy:** Unit/e2e tests for create, patch version increments, get/list, and cursor ordering.

**Verification commands:** `pnpm typecheck`, `pnpm test -- inventory`, `pnpm test:e2e -- inventory`.

**Acceptance criteria:** Endpoints match SPEC; `price` uses DB numeric and response decimal string; cursor ordering is deterministic.

**Documentation impact:** README/API docs later.

**Comment requirements:** Comment version increment invariant, composite cursor query edge cases, and seed trade-offs.

### Task 13: BullMQ Infrastructure and Worker Process Role

**Objective:** Configure BullMQ queues, producers, processors, worker bootstrap, retry, and bounded concurrency.

**Dependencies:** Tasks 2, 3, 7, and 11.

**Files/modules expected to change:** `src/modules/queue/*`, `src/worker.ts`, `src/app.module.ts`, `package.json`, Docker files.

**Implementation scope:** Register change, import-batch, and downstream queues; add worker entrypoint; configure attempts/backoff/concurrency.

**Test strategy:** Unit tests with queue abstraction mocks; integration smoke with Redis when available.

**Verification commands:** `pnpm typecheck`, `pnpm test -- queue`, `pnpm test:integration -- queue`, `docker compose config`.

**Acceptance criteria:** API can enqueue; worker process consumes; concurrency is bounded by config; same source/image is used.

**Documentation impact:** Redis/BullMQ and Docker docs later.

**Comment requirements:** Comment Redis acceptance boundary, retry trade-offs, worker concurrency purpose, and why BullMQ is not correctness.

### Task 14: Webhook Ingestion

**Objective:** Implement `POST /webhooks/inventory` validation, normalization, enqueue, and retriable failure behavior.

**Dependencies:** Tasks 5, 7, and 13.

**Files/modules expected to change:** `src/modules/ingestion/webhook/*`, queue producer tests, e2e tests.

**Implementation scope:** Validate request, normalize to `ProductChangeInput`, call queue producer, return `202` only after enqueue succeeds; return `503` on Redis enqueue failure.

**Test strategy:** E2E tests for valid `202`, invalid `400`, Redis failure `503`, duplicate delivery acceptance.

**Verification commands:** `pnpm typecheck`, `pnpm test -- webhook`, `pnpm test:e2e -- webhook`.

**Acceptance criteria:** No false acceptance when enqueue fails; no business DB write occurs in webhook controller.

**Documentation impact:** API/failure docs later.

**Comment requirements:** Comment enqueue-before-ack invariant and Redis failure semantics.

### Task 15: Polling Composite Checkpoint Tests First

**Objective:** Add tests proving stable `(updatedAt, productId)` polling cursor and safe checkpoint advancement.

**Dependencies:** Tasks 12 and 13.

**Files/modules expected to change:** `src/modules/ingestion/polling/**/*.spec.ts`, integration/e2e tests.

**Implementation scope:** Tests first for ordering, same timestamp tie-breaker, no checkpoint advance after enqueue failure, and duplicate re-poll preference.

**Test strategy:** Unit tests for cursor predicate; integration tests with emulator rows sharing timestamps and mocked queue failure.

**Verification commands:** `pnpm test -- polling`, `pnpm test:integration -- polling`.

**Acceptance criteria:** Tests fail before polling implementation where practical and explicitly cover skipped-change prevention.

**Documentation impact:** ADR/checkpoint docs later.

**Comment requirements:** Test names must state duplicate re-poll is preferred over skip.

### Task 16: Polling Scheduler and Safe Checkpoint Implementation

**Objective:** Implement scheduled incremental polling with composite cursor and safe enqueue/checkpoint semantics.

**Dependencies:** Task 15.

**Files/modules expected to change:** `src/modules/ingestion/polling/*`, checkpoint entity/repository if needed, tests.

**Implementation scope:** `@nestjs/schedule` interval, inventory client/service call, page enqueue, checkpoint persistence only after full page accepted by BullMQ.

**Test strategy:** Pass Task 15 tests; add scheduler disabled/enabled config tests.

**Verification commands:** `pnpm typecheck`, `pnpm test -- polling`, `pnpm test:integration -- polling`.

**Acceptance criteria:** Same timestamp products are not skipped; Redis/inventory failure keeps checkpoint unchanged.

**Documentation impact:** Polling/failure docs and ADR if applicable.

**Comment requirements:** Comment cursor predicate, checkpoint advancement invariant, enqueue failure edge case, and scheduler trade-off.

### Task 17: Transactional Outbox Publisher and Downstream Consumer

**Objective:** Implement outbox claiming, retry state, dedicated downstream BullMQ publication, and a minimal duplicate-tolerant downstream consumer.

**Dependencies:** Tasks 11 and 13.

**Files/modules expected to change:** `src/modules/outbox/*`, `src/modules/queue/processors/*`, integration tests.

**Implementation scope:** Claim pending events with bounded reads, publish to downstream queue, mark published after enqueue, update attempts/errors on failure, and consume duplicate-tolerantly with structured logging only. Duplicate downstream delivery is allowed, must not mutate business state, and must not violate database invariants. Duplicate structured log entries are acceptable. Do not add a processed-events table, Inbox Pattern, or extra persistence solely to deduplicate logs.

**Test strategy:** Integration tests for publish failure, duplicate publication, retry attempts, and duplicate-tolerant downstream behavior.

**Verification commands:** `pnpm typecheck`, `pnpm test -- outbox`, `pnpm test:integration -- outbox`.

**Acceptance criteria:** No lost committed outbox events under tested failure; duplicate publication remains harmless to business state and database invariants, even if duplicate logs occur.

**Documentation impact:** Transactional outbox docs and ADR-006.

**Comment requirements:** Comment claim strategy, DB-to-queue dual-write protection, duplicate publication edge case, and duplicate-tolerant logging trade-off.

### Task 18: Excel Streaming, Upload Limit, Backpressure, and Redis Retry Tests First

**Objective:** Add tests and fixtures for streaming imports before implementation.

**Dependencies:** Tasks 7 and 13.

**Files/modules expected to change:** `src/modules/imports/**/*.spec.ts`, `test/fixtures/*`, e2e tests.

**Implementation scope:** Tests for row validation, upload size enforcement while multipart bytes stage to a bounded temporary file, incremental parser-to-batch production, no busy-looping, Redis enqueue retry timeout, malformed rows, temporary-file cleanup, and generated-path isolation.

**Test strategy:** Unit tests for row parsing/validation and Phase B backpressure; e2e streaming upload tests; mocked queue backpressure/retry tests. Prove staging finishes before parsing, then a full batch enqueues while the XLSX parser still has unread rows and has not emitted EOF. Do not require enqueue before HTTP upload EOF.

**Verification commands:** `pnpm test -- imports`, `pnpm test:e2e -- imports`.

**Acceptance criteria:** Tests define bounded staging, path isolation, cleanup, parser-EOF-before-full-workbook-materialization, and backpressure expectations; they fail before implementation where practical. The test contract permits upload EOF before parsing begins but does not permit full upload/workbook buffering or unbounded row collection.

**Documentation impact:** Excel streaming docs later.

**Comment requirements:** Test names and non-obvious fixtures must state the Phase A/Phase B boundary, parser-EOF streaming invariant, cleanup/security behavior, and bounded-production invariant.

### Task 19: Import Job Lifecycle and Excel Streaming Implementation

**Objective:** Implement `POST /imports/products` with bounded two-phase XLSX ingestion, upload limit, bounded production, Redis retry timeout, and ingestion-phase import lifecycle.

**Dependencies:** Task 18.

**Files/modules expected to change:** `src/modules/imports/*`, queue producer, tests.

**Implementation scope:** Phase A streams the Busboy file `Readable` to a generated unique file under a controlled temporary directory, enforces the byte limit while writing, and never trusts the client filename as a path. Phase B opens the staged file through `yauzl` ZIP entry Readables, incrementally parses the selected worksheet XML with `sax`, exposes raw rows through a Node object-mode stream, then normalizes rows and produces bounded BullMQ batches. The temporary file is not durable storage and is deleted in `finally` on every terminal success/failure path. During Phase B, a blocked Redis batch keeps the BullMQ Writable unresolved so Node stream backpressure pauses XLSX row consumption and retries that same batch within the timeout; it never reads and discards rows. Task 19 owns `CREATED -> UPLOADING -> PROCESSING` and may transition to `FAILED` when multipart upload cannot continue, the streaming parser fails at file level, the upload size limit is exceeded, bounded Redis enqueue retry expires, or another unrecoverable ingestion-phase error occurs. A successful flow ends at `PROCESSING` only after both phases, final partial-batch submission, and all pending enqueues succeed; it records the durable enqueue-completion signal and must not mark a successfully uploaded/enqueued import as `COMPLETED`.

**Test strategy:** Pass Task 18 tests; add integration tests for controlled unique paths, cleanup on success and each terminal failure, upload-limit cleanup before parsing, and partial-queue/parser-failure semantics. Prove Phase B can enqueue a full batch before parser EOF after staging, while no all-row collection occurs. Prove persisted import job state transitions through `CREATED`, `UPLOADING`, and `PROCESSING`, marks `FAILED` for ingestion-phase failures, records enqueue completion on successful production, and does not mark `COMPLETED` after upload/enqueue alone.

**Verification commands:** `pnpm typecheck`, `pnpm test -- imports`, `pnpm test:e2e -- imports`.

**Acceptance criteria:** Multipart bytes are never fully buffered and write only to controlled generated temporary paths; the limit is enforced during Phase A; the temporary file is removed on every terminal path; Phase B incrementally processes parser rows with bounded batches and pending work; Redis timeout marks import `FAILED`; successful two-phase upload parsing/enqueue production ends at `PROCESSING` with enqueue completion recorded and never prematurely marks `COMPLETED`. Memory is bounded with respect to worksheet rows and pending batches, while metadata/shared-string memory remains documented.

**Documentation impact:** Excel/failure docs later.

**Comment requirements:** Comment Phase A/Phase B lifecycle, temporary-path security and cleanup, parser/backpressure mechanism, Redis retry timeout, malformed-row versus file-level failure handling, partial-queue/parser-failure trade-off, why upload/enqueue completion is not processing completion, the enqueue-completion invariant, shared-string memory trade-off, and ingestion-phase failure modes.

### Task 20: Atomic Redis Progress Counters and Import Batch Worker

**Objective:** Process import batches, maintain progress counters with atomic Redis operations, and own the terminal `PROCESSING -> COMPLETED` transition.

**Dependencies:** Tasks 13 and 19.

**Files/modules expected to change:** `src/modules/imports/import-progress*`, `src/modules/queue/processors/import-batch*`, tests.

**Implementation scope:** Task 19 assigns a deterministic `batchId` before the first enqueue and carries it through BullMQ retries. The import-batch processor calls ChangeProcessor per row and records semantic outcomes as successes. `import_batch_accounting` is a minimal accounting marker keyed by `(import_id, batch_id)` and terminal aggregate delta; it is not an Inbox and stores neither payloads nor business state. On a non-final attempt, unexpected failure throws with no accounting; on the final allowed attempt, unexpected rows count failed while remaining rows continue. One PostgreSQL transaction inserts the marker with `ON CONFLICT DO NOTHING`, applies counters only for a new marker, and conditionally transitions `PROCESSING -> COMPLETED`. The uploader/import service increments `rowsRead`; import batch workers increment `rowsProcessed`, `rowsSucceeded`, and `rowsFailed`; PostgreSQL remains the durable import lifecycle state; Redis receives only an atomic post-commit live snapshot. Completion eligibility requires both `enqueue_completed_at` and `rowsProcessed === rowsRead`; do not determine it from counters alone.

**Test strategy:** Prove batch replay and simulated post-commit/pre-ack replay add one durable delta, while concurrent duplicate deliveries create one accounting marker. Test non-final retry without accounting, final-attempt terminal failures, malformed pre-enqueue rows, FAILED non-resurrection, PostgreSQL final-batch races, and real Redis/BullMQ retry. Include tests where `rowsProcessed === rowsRead` temporarily while upload production is still open, proving `COMPLETED` cannot occur before the durable enqueue-completion signal exists.

**Verification commands:** `pnpm typecheck`, `pnpm test -- progress`, `pnpm test:integration -- imports`.

**Acceptance criteria:** A deterministic batch ID and accounting marker make durable progress retry-idempotent without becoming an Inbox; `rowsProcessed = rowsSucceeded + rowsFailed`; `rowsProcessed <= rowsRead`; `COMPLETED` requires enqueue phase completed and `rowsProcessed = rowsRead`; retries/concurrent updates produce one correct terminal state without duplicate aggregate deltas or terminal transitions.

**Documentation impact:** SSE/progress docs later.

**Comment requirements:** Comment business-versus-progress idempotency, the post-commit/pre-ack crash window, batch retry and final-attempt semantics, atomic marker/counter transaction, invariant preservation, why `rowsProcessed === rowsRead` alone is unsafe, final-batch terminal transition race, durable enqueue-completion signal, FAILED non-resurrection, and durable-versus-live Redis trade-off.

### Task 21: SSE Progress and Import Status API

**Objective:** Implement `GET /imports/:id` and `GET /imports/:id/progress`.

**Dependencies:** Task 20.

**Files/modules expected to change:** `src/modules/imports/imports.controller.ts`, progress service, e2e tests.

**Implementation scope:** Return durable import state; SSE sends latest snapshot first and streams progress/completed/failed events.

**Test strategy:** E2E tests for status lookup, SSE initial snapshot, completion event, failure event, and reconnect behavior.

**Verification commands:** `pnpm typecheck`, `pnpm test:e2e -- imports`.

**Acceptance criteria:** SSE reports real status only; `percent` is null when total is unknown; reconnect receives latest snapshot.

**Documentation impact:** SSE docs and ADR-008.

**Comment requirements:** Comment SSE lifecycle edge cases, disconnect cleanup, snapshot-first behavior, and null percent invariant.

### Task 22: Structured Logging and Health Checks

**Objective:** Add contextual structured logs and `GET /health` dependency checks.

**Dependencies:** Tasks 2, 4, and 13.

**Files/modules expected to change:** `src/common/logging/*`, `src/modules/health/*`, affected services.

**Implementation scope:** Use Nest logger or structured logger wrapper; include required context fields; health checks for app, Postgres, and Redis.

**Test strategy:** Unit tests for log context helpers; e2e health checks with mocked dependency failure where practical.

**Verification commands:** `pnpm typecheck`, `pnpm test -- health`, `pnpm test:e2e -- health`.

**Acceptance criteria:** Logs include `productId`, `version`, `source`, `importId`, `jobId`, `outboxEventId`, `result`, `durationMs`, `attempt` where applicable; health endpoint reflects required dependency state.

**Documentation impact:** Observability/failure docs later.

**Comment requirements:** Comment non-obvious redaction choices and dependency health trade-offs.

### Task 23: Required Concurrency and Failure Proof Tests

**Objective:** Add and run assignment-critical integration/concurrency/failure tests.

**Dependencies:** Tasks 11, 14, 16, 17, 20, and 21.

**Files/modules expected to change:** `test/integration/*`, `test/e2e/*`, helper fixtures.

**Implementation scope:** Tests proving 100 concurrent same product/version attempts persist one row; concurrent v5/v6 leaves final state v6; first-write race safety; Redis unavailable before enqueue returns no false acceptance; polling checkpoint not advanced after enqueue failure; import upload/enqueue completion alone does not mark `COMPLETED`; `COMPLETED` cannot happen before enqueue production is finished; concurrent final batch workers produce one correct terminal state; progress invariants under concurrent workers; `rowsProcessed` never exceeds `rowsRead`; `rowsProcessed = rowsSucceeded + rowsFailed`; outbox duplicate publication is harmless even if duplicate logs occur.

**Test strategy:** Real PostgreSQL/Redis integration tests where feasible; controlled mocks only for failure injection not practical against live dependencies.

**Verification commands:** `pnpm test:integration`, `pnpm test:e2e`.

**Acceptance criteria:** Every listed proof has a passing test and asserts database/lifecycle invariants, not just HTTP responses.

**Documentation impact:** Testing docs later.

**Comment requirements:** Comment test harness concurrency controls, failure injection points, and why each invariant matters.

### Task 24: k6 Spike Tests and DB Invariant Verification

**Objective:** Add load/spike testing that demonstrates BullMQ buffering and bounded worker protection.

**Dependencies:** Tasks 14, 16, 20, and 23.

**Files/modules expected to change:** `load-tests/*`, scripts for invariant queries, README snippets.

**Implementation scope:** k6 scenario with many delivery attempts and fewer unique logical changes; post-run DB invariant verification script.

**Test strategy:** Run scaled local spike test and verify persisted changes, duplicates prevented, stale prevented, latency/error metrics, and queue backlog behavior.

**Verification commands:** `k6 run load-tests/spike.js`, invariant query command, `pnpm test:integration`.

**Acceptance criteria:** Results include total attempts, unique logical changes, persisted changes, duplicates/stale prevented, p50/p95/p99 where practical, error rate, and queue backlog behavior.

**Documentation impact:** Testing/load docs later.

**Comment requirements:** Comment load-test data distribution, duplicate/stale mix, and machine-scaling trade-offs.

### Task 25: Bilingual Documentation and ADRs

**Objective:** Create synchronized English/Vietnamese project docs and required ADRs.

**Dependencies:** Tasks 3, 4, 9, 11, 13, 16, 17, 19, 21, 23, and 24.

**Files/modules expected to change:** `README.md`, `README.vi.md`, `docs/en/*`, `docs/vi/*`, `docs/en/adr/*`, `docs/vi/adr/*`.

**Implementation scope:** Architecture, exactly-once, failure handling, Excel streaming, outbox, Redis/BullMQ failure model, SSE progress, testing, all ADRs 001-010.

**Test strategy:** Documentation consistency review; link/path checks where practical.

**Verification commands:** `rg` checks for required docs/ADRs, manual bilingual synchronization review.

**Acceptance criteria:** English and Vietnamese docs are semantically equivalent; docs describe actual implementation, not only initial design.

**Documentation impact:** This is the documentation task.

**Comment requirements:** Not applicable to code; document trade-offs in ADRs.

### Task 26: AI Usage Disclosure

**Objective:** Accurately document AI-assisted work and verification evidence.

**Dependencies:** Task 25 and implementation evidence from prior tasks.

**Files/modules expected to change:** `docs/en/ai-usage.md`, `docs/vi/ai-usage.md`.

**Implementation scope:** Record candidate decisions, AI-generated/assisted code, reviewed/modified generated code, commands run, verified assumptions, and unfinished work.

**Test strategy:** Manual consistency check against git history/task log.

**Verification commands:** `rg -n "AI|commands|unfinished|verified" docs/en/ai-usage.md docs/vi/ai-usage.md`.

**Acceptance criteria:** Disclosure is accurate and does not claim AI-generated code was manually written.

**Documentation impact:** AI usage docs.

**Comment requirements:** Not applicable.

### Task 27: Final Review and Code Simplification

**Objective:** Perform code-review-and-quality and code-simplification without weakening required guarantees.

**Dependencies:** Tasks 1-26.

**Files/modules expected to change:** Only files needing review fixes or simplification.

**Implementation scope:** Review correctness, concurrency, failure semantics, TypeORM use, queue semantics, security/input validation, tests, docs; remove unnecessary complexity.

**Test strategy:** Full suite after changes.

**Verification commands:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, `docker compose up --build`, k6 spike command.

**Acceptance criteria:** No speculative abstractions remain; transactions, constraints, idempotency, checkpoint safety, backpressure, Redis failure handling, and docs remain intact.

**Documentation impact:** Update docs if review changes behavior.

**Comment requirements:** Ensure complex blocks have explanatory comments; remove stale or obvious comments.

## Checkpoints

- After Tasks 1-5: tooling, config, Docker skeleton, database schema, and API contracts are reviewable.
- After Tasks 6-11: canonical change processing and exactly-once effect are proven.
- After Tasks 12-17: inventory, queues, webhook, polling, worker role, and outbox are operational.
- After Tasks 18-23: imports, progress, SSE, health, and critical concurrency/failure proofs pass.
- After Tasks 24-27: k6, documentation, AI disclosure, final review, and simplification are complete.

## Tasks Requiring Source Verification During Implementation

- Task 3: Docker/Nest worker bootstrap details.
- Task 4: TypeORM migrations and PostgreSQL numeric/JSON/constraint behavior.
- Task 9: PostgreSQL advisory locks through TypeORM.
- Task 13: NestJS BullMQ queue/processor APIs and BullMQ retry/concurrency options.
- Task 16: NestJS Schedule setup and scheduler lifecycle.
- Task 19: Busboy streaming semantics, Node temporary-file APIs, `yauzl` ZIP entry stream behavior, and `sax` incremental XML parser behavior.
- Task 20: Redis atomic operations for progress counters.
- Task 21: NestJS SSE `Observable<MessageEvent>` behavior and disconnect handling.

## Open Questions

No open architecture questions remain for PLAN. Implementation-specific API details must be verified from official docs inside the relevant task before coding.
