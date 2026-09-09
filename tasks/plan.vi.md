# Ke Hoach Trien Khai: Prototype CDMS

## Pham Vi

Ke hoach nay implement `SPEC.md` da duoc approve ma khong doi kien truc. Project van la mot NestJS source project voi separate worker process/container role, PostgreSQL la correctness boundary, Redis/BullMQ nam truoc business processing, polling dung stable composite cursor, Excel ingestion streaming voi bounded backpressure, Redis failure semantics, transactional outbox, dedicated downstream BullMQ queue, va SSE progress semantics.

## Source Verification Da Thuc Hien Cho Plan

- NestJS BullMQ: `@nestjs/bullmq`, `BullModule.registerQueue()`, queue injection, processors, va queue/worker events duoc document tai https://docs.nestjs.com/techniques/queues.
- NestJS Schedule: `@nestjs/schedule` va `ScheduleModule.forRoot()` duoc document tai https://docs.nestjs.com/techniques/task-scheduling.
- NestJS SSE: route `@Sse()` return `Observable<MessageEvent>` theo https://docs.nestjs.com/techniques/server-sent-events.
- NestJS multipart/file upload: official Nest file upload guide dua tren Multer va expose `MulterModule`/interceptors tai https://docs.nestjs.com/techniques/file-upload. Vi SPEC yeu cau streaming that va khong full-file buffering, implementation phai verify streaming multipart parser duoc chon truoc khi code import endpoint.
- TypeORM transactions va `QueryRunner`: document tai https://typeorm.io/docs/transactions/.
- PostgreSQL transaction-level advisory locks: document tai https://www.postgresql.org/docs/current/explicit-locking.html.
- BullMQ concurrency va retry/backoff: document tai https://docs.bullmq.io/guide/workers/concurrency va https://docs.bullmq.io/guide/retrying-failing-jobs.
- Excel streaming qualification: `exceljs@4.4.0` documented `WorkbookReader` fail voi XLSX hop le do ExcelJS tao. `xlsx-extract@0.2.0` va `xlsx-stream-reader@1.1.1` bi reject vi EventEmitter row APIs chay ahead of async consumer va khong the cung cap producer-side backpressure bat buoc. Task 19 dung narrow internal reader xay dung tren `yauzl` ZIP entry streams va `sax`, expose worksheet rows qua Node object-mode stream. No can bounded temporary-file staging; no giu workbook metadata va shared strings, nhung khong giu XLSX buffer hoac tat ca worksheet rows/cells.

Khong co official documentation nao da review cho plan mau thuan voi SPEC da approve.

## Thu Tu Phu Thuoc

Foundation tasks tao Jest/config/Docker/database primitives truoc. Contract va pure business tests di truoc transactional implementation. Queue, worker, webhook, va polling duoc xay sau normalized contract va database processor. Import streaming/progress/SSE di sau queue infrastructure. Documentation, ADRs, k6, review, va simplification ket thuc plan.

## Task Rui Ro Cao Nhat

- Task 9 advisory-lock helper: correctness phu thuoc stable key derivation va PostgreSQL lock behavior.
- Task 10 transactional ChangeProcessor: loi cua database exactly-once effect, duplicate/stale/conflict semantics, va outbox atomicity.
- Task 19 Excel streaming/backpressure: phai enforce limits ma khong buffer va phai xu ly Redis failure trong upload.
- Task 20 atomic progress counters: concurrent worker updates phai giu invariants.
- Task 23 concurrency/failure tests: chung minh cac invariants quan trong nhat cua assignment.

## Danh Sach Task

### Task 1: Can Chinh Tooling Ve Jest Va Strict Verification

**Objective:** Thay starter Vitest setup bang Jest voi NestJS testing utilities va them verification scripts con thieu.

**Dependencies:** Khong co.

**Files/modules expected to change:** `package.json`, Jest config files, `test/`, `tsconfig*.json`, starter test files.

**Implementation scope:** Cau hinh Jest cho unit, integration, va e2e tests; them `pnpm typecheck`; bo Vitest usage neu chua duoc approve.

**Test strategy:** Convert starter e2e smoke test sang Jest va them mot unit smoke test don gian.

**Verification commands:** `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`.

**Acceptance criteria:** Jest chay thanh cong; Vitest khong can thiet; TypeScript strict van bat.

**Documentation impact:** Cap nhat README command references trong documentation tasks sau.

**Comment requirements:** Khong co logic phuc tap; khong comment config obvious.

### Task 2: Bootstrap Config Va Environment Validation

**Objective:** Them validated environment configuration cho API, worker, database, Redis, polling, import, va outbox settings.

**Dependencies:** Task 1.

**Files/modules expected to change:** `src/config/*`, `src/app.module.ts`, `.env.example`, `package.json`.

**Implementation scope:** Them config module, environment schema, defaults tu SPEC, va typed config access.

**Test strategy:** Unit tests cho defaults, invalid values, va required secrets/placeholders.

**Verification commands:** `pnpm typecheck`, `pnpm test -- config`.

**Acceptance criteria:** Invalid config lam startup fail; defaults gom `INVENTORY_SEED_COUNT=1000`, `IMPORT_MAX_FILE_SIZE_MB=100`, `IMPORT_REDIS_RETRY_TIMEOUT_MS=30000`.

**Documentation impact:** Ghi final config trong README/docs.

**Comment requirements:** Comment validation bounds khong obvious va ly do defaults bao ve prototype behavior.

### Task 3: Docker Compose Va Process Roles

**Objective:** Them Docker Compose topology mot may voi `cdms`, `worker`, `postgres`, va `redis`.

**Dependencies:** Task 2.

**Files/modules expected to change:** `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `package.json`, `.env.example`.

**Implementation scope:** Dung cung repository/source/image cho API va worker commands; them cau hinh startup than thien voi health.

**Test strategy:** Compose smoke test sau khi runtime code phu thuoc ton tai; task ban dau verify config va image build.

**Verification commands:** `docker compose config`, `docker compose build`.

**Acceptance criteria:** API va worker la process roles rieng; khong them monorepo hoac microservice source split.

**Documentation impact:** Docker docs va ADR-001 sau.

**Comment requirements:** Chi comment Docker command/process-role trade-offs khong obvious.

### Task 4: Database Module, Data Source, Va Initial Migrations

**Objective:** Them TypeORM PostgreSQL setup va migrations cho tat ca core tables da approve.

**Dependencies:** Task 2.

**Files/modules expected to change:** `src/database/*`, `src/modules/*/entities/*`, `src/database/migrations/*`, `package.json`.

**Implementation scope:** Dinh nghia entities va migrations cho `inventory_products`, `product_state`, `product_changes`, `outbox_events`, `import_jobs`, va polling checkpoint neu can. `import_jobs` phai co durable ingestion/enqueue completion signal, tot nhat la `enqueue_completed_at timestamptz nullable`, de phan biet "workers hien dang bat kip" voi "upload parsing va enqueue production da ket thuc."

**Test strategy:** Migration integration test tren PostgreSQL rong; schema constraint checks.

**Verification commands:** `pnpm typecheck`, `pnpm test:integration -- database`, migration run command, migration revert command.

**Acceptance criteria:** Migrations tao schema tu DB rong; unique constraint `(product_id, version)` ton tai; import job schema co durable enqueue-completion signal; khong dung `synchronize: true`.

**Documentation impact:** Database schema docs va ADR-002.

**Comment requirements:** Comment TypeORM/PostgreSQL migration choices khong obvious va constraints bao ve invariant.

### Task 5: API Contract DTOs Va Error Shape

**Objective:** Tach REST API contracts thanh DTOs, response types, va structured error semantics nhat quan.

**Dependencies:** Tasks 1-2.

**Files/modules expected to change:** `src/common/*`, `src/modules/*/dto/*`, controller specs.

**Implementation scope:** Dinh nghia public request/response DTOs cho inventory, webhook, imports, progress, va health ma chua implement business logic.

**Test strategy:** DTO validation tests va API contract snapshots cho status/error shape.

**Verification commands:** `pnpm typecheck`, `pnpm test -- dto`.

**Acceptance criteria:** Contracts khop SPEC; external inputs duoc validate o boundary; response fields dung camelCase on dinh.

**Documentation impact:** API docs sau.

**Comment requirements:** Comment validation decisions va retry/status semantics khong obvious.

### Task 6: Tests Truoc Cho Canonical Normalization Va Fingerprinting

**Objective:** Them failing tests cho normalization, canonical decimal price strings, canonical JSON, va SHA-256 fingerprints.

**Dependencies:** Task 5.

**Files/modules expected to change:** `src/modules/changes/**/*.spec.ts`, `src/modules/ingestion/**/*.spec.ts`, `src/modules/imports/**/*.spec.ts`.

**Implementation scope:** Chi tests khi phu hop: payload canonicalization, decimal normalization, deterministic key ordering, va source normalization.

**Test strategy:** Red tests cho equivalent payloads tao cung fingerprint va different payloads tao fingerprint khac.

**Verification commands:** `pnpm test -- fingerprint`.

**Acceptance criteria:** Tests fail truoc implementation va cover polling, webhook, va Excel normalization paths.

**Documentation impact:** Chua co.

**Comment requirements:** Ten test nen document invariants; chua can production comments.

### Task 7: Implement Canonical Normalization Va Fingerprinting

**Objective:** Implement shared normalization va fingerprinting dung cho tat ca ingestion paths.

**Dependencies:** Task 6.

**Files/modules expected to change:** `src/modules/changes/*`, `src/modules/ingestion/*`, `src/modules/imports/*`, tests.

**Implementation scope:** Deterministic canonical JSON, normalized `NUMERIC(18,2)` decimal string, `ProductChangeInput`, `ChangeSource`, va shared mappers.

**Test strategy:** Lam Task 6 tests pass; them edge cases cho whitespace, decimal scale, va field ordering.

**Verification commands:** `pnpm typecheck`, `pnpm test -- fingerprint`.

**Acceptance criteria:** Moi source tao cung canonical payload cho cung product state; fingerprints deterministic va khong global unique.

**Documentation impact:** Exactly-once/fingerprinting docs sau.

**Comment requirements:** Comment vi sao can canonical decimal va key ordering, invariant duplicate duoc bao ve, va trade-off khong lam fingerprint global unique.

### Task 8: Tests Truoc Cho Advisory Lock Helper

**Objective:** Them tests chung minh deterministic advisory-lock key derivation va document collision behavior.

**Dependencies:** Task 1.

**Files/modules expected to change:** `src/modules/changes/*lock*.spec.ts`, integration test setup.

**Implementation scope:** Tests cho stable process-independent key derivation va integration test skeleton cho transaction-scoped lock behavior.

**Test strategy:** Unit tests same product -> same key, different products -> expected distribution, restart-independent fixture values; integration test lock blocking/serialization.

**Verification commands:** `pnpm test -- advisory`, `pnpm test:integration -- advisory`.

**Acceptance criteria:** Tests dinh nghia collision behavior va fail truoc helper implementation khi phu hop.

**Documentation impact:** ADR-010 sau.

**Comment requirements:** Mo ta test phai neu missing-row race invariant.

### Task 9: Implement Advisory Lock Helper

**Objective:** Implement PostgreSQL transaction-scoped advisory lock acquisition qua TypeORM.

**Dependencies:** Tasks 4 va 8.

**Files/modules expected to change:** `src/modules/changes/product-lock.service.ts`, integration tests.

**Implementation scope:** Derive stable advisory key tu productId, acquire `pg_advisory_xact_lock` trong cung transaction manager/query runner, expose helper hep.

**Test strategy:** Pass unit va integration advisory-lock tests.

**Verification commands:** `pnpm typecheck`, `pnpm test -- advisory`, `pnpm test:integration -- advisory`.

**Acceptance criteria:** Lock la transaction-scoped, deterministic, stable qua restart, collision behavior duoc document/test.

**Documentation impact:** ADR-010 va concurrency docs sau.

**Comment requirements:** Comment vi sao row locks khong bao ve missing rows, invariant duoc bao ve, collision trade-off, va transaction-scoped release behavior.

### Task 10: Tests Truoc Cho ChangeProcessor Behavior

**Objective:** Them tests cho accepted, duplicate, stale, version-conflict, outbox atomicity, va concurrent order behavior.

**Dependencies:** Tasks 4, 7, va 9.

**Files/modules expected to change:** `src/modules/changes/**/*.spec.ts`, `test/integration/**/*.spec.ts`.

**Implementation scope:** Tests first cho version matrix va transaction outcomes.

**Test strategy:** Unit tests cho decision table; integration tests cho DB rows va rollback behavior.

**Verification commands:** `pnpm test -- change-processor`, `pnpm test:integration -- changes`.

**Acceptance criteria:** Tests chung minh duplicate/stale/conflict cases va fail truoc implementation khi phu hop.

**Documentation impact:** Chua co.

**Comment requirements:** Test cases phai goi ten business invariant duoc bao ve.

### Task 11: Implement Transactional ChangeProcessor

**Objective:** Implement exactly-once effect o database/business level.

**Dependencies:** Task 10.

**Files/modules expected to change:** `src/modules/changes/*`, `src/modules/outbox/*`, tests.

**Implementation scope:** Transactional processing, advisory lock, state read, version/fingerprint decision table, history insert, state upsert, outbox insert, structured result.

**Test strategy:** Pass Task 10 tests va them transient DB failure rollback test neu can.

**Verification commands:** `pnpm typecheck`, `pnpm test -- change-processor`, `pnpm test:integration -- changes`.

**Acceptance criteria:** `ACCEPTED`, `DUPLICATE`, `STALE`, va `VERSION_CONFLICT` dung SPEC; accepted writes atomic voi outbox.

**Documentation impact:** Exactly-once docs va ADR-004/005/006 sau.

**Comment requirements:** Comment transaction boundary, advisory lock ordering, decision table invariants, duplicate/stale/conflict edge cases, va outbox atomicity trade-off.

### Task 12: Inventory Emulator

**Objective:** Implement inventory product persistence, seed data, va emulator endpoints.

**Dependencies:** Tasks 4 va 5.

**Files/modules expected to change:** `src/modules/inventory/*`, migrations/tests neu can.

**Implementation scope:** CRUD-limited emulator endpoints, version increment khi mutation, composite cursor list query, configurable seed count.

**Test strategy:** Unit/e2e tests cho create, patch version increments, get/list, va cursor ordering.

**Verification commands:** `pnpm typecheck`, `pnpm test -- inventory`, `pnpm test:e2e -- inventory`.

**Acceptance criteria:** Endpoints khop SPEC; `price` dung DB numeric va response decimal string; cursor ordering deterministic.

**Documentation impact:** README/API docs sau.

**Comment requirements:** Comment version increment invariant, composite cursor query edge cases, va seed trade-offs.

### Task 13: BullMQ Infrastructure Va Worker Process Role

**Objective:** Cau hinh BullMQ queues, producers, processors, worker bootstrap, retry, va bounded concurrency.

**Dependencies:** Tasks 2, 3, 7, va 11.

**Files/modules expected to change:** `src/modules/queue/*`, `src/worker.ts`, `src/app.module.ts`, `package.json`, Docker files.

**Implementation scope:** Register change, import-batch, va downstream queues; them worker entrypoint; cau hinh attempts/backoff/concurrency.

**Test strategy:** Unit tests voi queue abstraction mocks; integration smoke voi Redis khi co.

**Verification commands:** `pnpm typecheck`, `pnpm test -- queue`, `pnpm test:integration -- queue`, `docker compose config`.

**Acceptance criteria:** API enqueue duoc; worker process consume duoc; concurrency bounded bang config; dung cung source/image.

**Documentation impact:** Redis/BullMQ va Docker docs sau.

**Comment requirements:** Comment Redis acceptance boundary, retry trade-offs, muc dich worker concurrency, va vi sao BullMQ khong phai correctness.

### Task 14: Webhook Ingestion

**Objective:** Implement `POST /webhooks/inventory` validation, normalization, enqueue, va retriable failure behavior.

**Dependencies:** Tasks 5, 7, va 13.

**Files/modules expected to change:** `src/modules/ingestion/webhook/*`, queue producer tests, e2e tests.

**Implementation scope:** Validate request, normalize thanh `ProductChangeInput`, goi queue producer, tra `202` chi sau enqueue thanh cong; tra `503` khi Redis enqueue failure.

**Test strategy:** E2E tests cho valid `202`, invalid `400`, Redis failure `503`, duplicate delivery acceptance.

**Verification commands:** `pnpm typecheck`, `pnpm test -- webhook`, `pnpm test:e2e -- webhook`.

**Acceptance criteria:** Khong false acceptance khi enqueue fail; webhook controller khong ghi business DB truc tiep.

**Documentation impact:** API/failure docs sau.

**Comment requirements:** Comment enqueue-before-ack invariant va Redis failure semantics.

### Task 15: Tests Truoc Cho Polling Composite Checkpoint

**Objective:** Them tests chung minh stable `(updatedAt, productId)` polling cursor va safe checkpoint advancement.

**Dependencies:** Tasks 12 va 13.

**Files/modules expected to change:** `src/modules/ingestion/polling/**/*.spec.ts`, integration/e2e tests.

**Implementation scope:** Tests first cho ordering, same timestamp tie-breaker, no checkpoint advance after enqueue failure, va duplicate re-poll preference.

**Test strategy:** Unit tests cho cursor predicate; integration tests voi emulator rows cung timestamp va mocked queue failure.

**Verification commands:** `pnpm test -- polling`, `pnpm test:integration -- polling`.

**Acceptance criteria:** Tests fail truoc polling implementation khi phu hop va cover skipped-change prevention ro rang.

**Documentation impact:** ADR/checkpoint docs sau.

**Comment requirements:** Ten test phai noi duplicate re-poll duoc uu tien hon skip.

### Task 16: Implement Polling Scheduler Va Safe Checkpoint

**Objective:** Implement scheduled incremental polling voi composite cursor va safe enqueue/checkpoint semantics.

**Dependencies:** Task 15.

**Files/modules expected to change:** `src/modules/ingestion/polling/*`, checkpoint entity/repository neu can, tests.

**Implementation scope:** `@nestjs/schedule` interval, inventory client/service call, page enqueue, checkpoint persistence chi sau khi full page duoc BullMQ accept.

**Test strategy:** Pass Task 15 tests; them scheduler disabled/enabled config tests.

**Verification commands:** `pnpm typecheck`, `pnpm test -- polling`, `pnpm test:integration -- polling`.

**Acceptance criteria:** Products cung timestamp khong bi skip; Redis/inventory failure giu checkpoint nguyen.

**Documentation impact:** Polling/failure docs va ADR neu can.

**Comment requirements:** Comment cursor predicate, checkpoint advancement invariant, enqueue failure edge case, va scheduler trade-off.

### Task 17: Transactional Outbox Publisher Va Downstream Consumer

**Objective:** Implement outbox claiming, retry state, dedicated downstream BullMQ publication, va minimal duplicate-tolerant downstream consumer.

**Dependencies:** Tasks 11 va 13.

**Files/modules expected to change:** `src/modules/outbox/*`, `src/modules/queue/processors/*`, integration tests.

**Implementation scope:** Claim pending events voi bounded reads, publish vao downstream queue, mark published sau enqueue, update attempts/errors khi fail, va consume duplicate-tolerantly chi voi structured logging. Duplicate downstream delivery duoc chap nhan, khong duoc mutate business state, va khong duoc violate database invariants. Duplicate structured log entries duoc chap nhan. Khong them processed-events table, Inbox Pattern, hoac extra persistence chi de deduplicate logs.

**Test strategy:** Integration tests cho publish failure, duplicate publication, retry attempts, va duplicate-tolerant downstream behavior.

**Verification commands:** `pnpm typecheck`, `pnpm test -- outbox`, `pnpm test:integration -- outbox`.

**Acceptance criteria:** Khong mat committed outbox events trong failure da test; duplicate publication harmless voi business state va database invariants, ke ca khi duplicate logs xay ra.

**Documentation impact:** Transactional outbox docs va ADR-006.

**Comment requirements:** Comment claim strategy, DB-to-queue dual-write protection, duplicate publication edge case, va duplicate-tolerant logging trade-off.

### Task 18: Tests Truoc Cho Excel Streaming, Upload Limit, Backpressure, Va Redis Retry

**Objective:** Them tests va fixtures cho streaming imports truoc implementation.

**Dependencies:** Tasks 7 va 13.

**Files/modules expected to change:** `src/modules/imports/**/*.spec.ts`, `test/fixtures/*`, e2e tests.

**Implementation scope:** Tests cho row validation, upload size enforcement trong khi multipart bytes stage vao bounded temporary file, incremental parser-to-batch production, khong busy-looping, Redis enqueue retry timeout, malformed rows, temporary-file cleanup, va generated-path isolation.

**Test strategy:** Unit tests cho row parsing/validation va Phase B backpressure; e2e streaming upload tests; mocked queue backpressure/retry tests. Chung minh staging ket thuc truoc parsing, sau do full batch enqueue khi XLSX parser con unread rows va chua emit EOF. Khong yeu cau enqueue truoc HTTP upload EOF.

**Verification commands:** `pnpm test -- imports`, `pnpm test:e2e -- imports`.

**Acceptance criteria:** Tests dinh nghia bounded staging, path isolation, cleanup, parser-EOF-before-full-workbook-materialization, va backpressure expectations; tests fail truoc implementation khi phu hop. Test contract cho phep upload EOF truoc khi parsing bat dau nhung khong cho phep full upload/workbook buffering hoac unbounded row collection.

**Documentation impact:** Excel streaming docs sau.

**Comment requirements:** Ten test va non-obvious fixtures phai state Phase A/Phase B boundary, parser-EOF streaming invariant, cleanup/security behavior, va bounded-production invariant.

### Task 19: Implement Import Job Lifecycle Va Excel Streaming

**Objective:** Implement `POST /imports/products` voi bounded two-phase XLSX ingestion, upload limit, bounded production, Redis retry timeout, va ingestion-phase import lifecycle.

**Dependencies:** Task 18.

**Files/modules expected to change:** `src/modules/imports/*`, queue producer, tests.

**Implementation scope:** Phase A stream Busboy file `Readable` vao generated unique file trong controlled temporary directory, enforce byte limit trong khi write, va khong bao gio trust client filename lam path. Phase B mo staged file qua `yauzl` ZIP entry Readables, incrementally parse selected worksheet XML voi `sax`, expose raw rows qua Node object-mode stream, sau do normalize rows va produce bounded BullMQ batches. Temporary file khong phai durable storage va duoc delete trong `finally` o moi terminal success/failure path. Trong Phase B, blocked Redis batch giu BullMQ Writable unresolved de Node stream backpressure pause XLSX row consumption va retry cung batch trong timeout; khong doc va discard rows. Task 19 so huu `CREATED -> UPLOADING -> PROCESSING` va co the transition sang `FAILED` khi multipart upload khong the tiep tuc, streaming parser fail o file level, upload size limit bi vuot, bounded Redis enqueue retry het han, hoac ingestion-phase error khong recover khac xay ra. Flow thanh cong chi ket thuc o `PROCESSING` sau ca hai phase, final partial-batch submission, va moi pending enqueue thanh cong; flow ghi durable enqueue-completion signal va khong duoc mark import da upload/enqueue thanh cong la `COMPLETED`.

**Test strategy:** Pass Task 18 tests; them integration tests cho controlled unique paths, cleanup khi success va moi terminal failure, upload-limit cleanup truoc parsing, va partial-queue/parser-failure semantics. Chung minh Phase B co the enqueue full batch truoc parser EOF sau staging, trong khi khong co all-row collection. Chung minh persisted import job state transitions qua `CREATED`, `UPLOADING`, va `PROCESSING`, mark `FAILED` cho ingestion-phase failures, ghi enqueue completion khi production thanh cong, va khong mark `COMPLETED` chi sau upload/enqueue.

**Verification commands:** `pnpm typecheck`, `pnpm test -- imports`, `pnpm test:e2e -- imports`.

**Acceptance criteria:** Multipart bytes khong bao gio fully buffered va chi write vao controlled generated temporary paths; limit duoc enforce trong Phase A; temporary file duoc remove o moi terminal path; Phase B incrementally process parser rows voi bounded batches va pending work; Redis timeout mark import `FAILED`; successful two-phase upload parsing/enqueue production ket thuc o `PROCESSING` voi enqueue completion recorded va khong prematurely mark `COMPLETED`. Memory bounded theo worksheet rows va pending batches, trong khi metadata/shared-string memory van duoc document.

**Documentation impact:** Excel/failure docs sau.

**Comment requirements:** Comment Phase A/Phase B lifecycle, temporary-path security va cleanup, parser/backpressure mechanism, Redis retry timeout, malformed-row versus file-level failure handling, partial-queue/parser-failure trade-off, vi sao upload/enqueue completion khong phai processing completion, enqueue-completion invariant, shared-string memory trade-off, va ingestion-phase failure modes.

### Task 20: Atomic Redis Progress Counters Va Import Batch Worker

**Objective:** Xu ly import batches, duy tri progress counters bang atomic Redis operations, va so huu terminal transition `PROCESSING -> COMPLETED`.

**Dependencies:** Tasks 13 va 19.

**Files/modules expected to change:** `src/modules/imports/import-progress*`, `src/modules/queue/processors/import-batch*`, tests.

**Implementation scope:** Task 19 assign `batchId` deterministic truoc first enqueue va carry no qua BullMQ retries. Import-batch processor goi ChangeProcessor tung row va ghi semantic outcomes nhu successes. `import_batch_accounting` la minimal accounting marker keyed boi `(import_id, batch_id)` va terminal aggregate delta; no khong phai Inbox va khong luu payload hoac business state. O non-final attempt, unexpected failure throw ma khong accounting; o final allowed attempt, unexpected rows count failed trong khi remaining rows tiep tuc. Mot PostgreSQL transaction insert marker voi `ON CONFLICT DO NOTHING`, chi apply counters cho marker moi, va conditionally transition `PROCESSING -> COMPLETED`. Uploader/import service increment `rowsRead`; import batch workers increment `rowsProcessed`, `rowsSucceeded`, va `rowsFailed`; PostgreSQL van la durable import lifecycle state; Redis chi nhan atomic post-commit live snapshot. Completion can ca `enqueue_completed_at` va `rowsProcessed === rowsRead`; khong determine chi dua vao counters.

**Test strategy:** Chung minh batch replay va simulated post-commit/pre-ack replay chi them mot durable delta, trong khi concurrent duplicate deliveries tao mot accounting marker. Test non-final retry khong accounting, final-attempt terminal failures, malformed pre-enqueue rows, FAILED non-resurrection, PostgreSQL final-batch races, va real Redis/BullMQ retry. Them tests trong do `rowsProcessed === rowsRead` tam thoi trong khi upload production van mo, chung minh `COMPLETED` khong the xay ra truoc durable enqueue-completion signal.

**Verification commands:** `pnpm typecheck`, `pnpm test -- progress`, `pnpm test:integration -- imports`.

**Acceptance criteria:** Deterministic batch ID va accounting marker lam durable progress retry-idempotent ma khong tro thanh Inbox; `rowsProcessed = rowsSucceeded + rowsFailed`; `rowsProcessed <= rowsRead`; `COMPLETED` can enqueue phase completed va `rowsProcessed = rowsRead`; retries/concurrent updates tao mot terminal state dung ma khong duplicate aggregate deltas hoac terminal transitions.

**Documentation impact:** SSE/progress docs sau.

**Comment requirements:** Comment business-versus-progress idempotency, post-commit/pre-ack crash window, batch retry va final-attempt semantics, atomic marker/counter transaction, invariant preservation, vi sao `rowsProcessed === rowsRead` mot minh la khong an toan, final-batch terminal transition race, durable enqueue-completion signal, FAILED non-resurrection, va durable-versus-live Redis trade-off.

### Task 21: SSE Progress Va Import Status API

**Objective:** Implement `GET /imports/:id` va `GET /imports/:id/progress`.

**Dependencies:** Task 20.

**Files/modules expected to change:** `src/modules/imports/imports.controller.ts`, progress service, e2e tests.

**Implementation scope:** Return durable import state; SSE gui latest snapshot truoc va stream progress/completed/failed events.

**Test strategy:** E2E tests cho status lookup, SSE initial snapshot, completion event, failure event, va reconnect behavior.

**Verification commands:** `pnpm typecheck`, `pnpm test:e2e -- imports`.

**Acceptance criteria:** SSE chi bao real status; `percent` null khi chua biet total; reconnect nhan latest snapshot.

**Documentation impact:** SSE docs va ADR-008.

**Comment requirements:** Comment SSE lifecycle edge cases, disconnect cleanup, snapshot-first behavior, va null percent invariant.

### Task 22: Structured Logging Va Health Checks

**Objective:** Them contextual structured logs va `GET /health` dependency checks.

**Dependencies:** Tasks 2, 4, va 13.

**Files/modules expected to change:** `src/common/logging/*`, `src/modules/health/*`, services lien quan.

**Implementation scope:** Dung Nest logger hoac structured logger wrapper; them required context fields; health checks cho app, Postgres, va Redis.

**Test strategy:** Unit tests cho log context helpers; e2e health checks voi mocked dependency failure khi phu hop.

**Verification commands:** `pnpm typecheck`, `pnpm test -- health`, `pnpm test:e2e -- health`.

**Acceptance criteria:** Logs gom `productId`, `version`, `source`, `importId`, `jobId`, `outboxEventId`, `result`, `durationMs`, `attempt` khi phu hop; health endpoint phan anh dependency state bat buoc.

**Documentation impact:** Observability/failure docs sau.

**Comment requirements:** Comment redaction choices va dependency health trade-offs khong obvious.

### Task 23: Required Concurrency Va Failure Proof Tests

**Objective:** Them va chay integration/concurrency/failure tests quan trong cua assignment.

**Dependencies:** Tasks 11, 14, 16, 17, 20, va 21.

**Files/modules expected to change:** `test/integration/*`, `test/e2e/*`, helper fixtures.

**Implementation scope:** Tests chung minh 100 concurrent same product/version attempts persist mot row; concurrent v5/v6 de final state v6; first-write race safe; Redis unavailable before enqueue khong false acceptance; polling checkpoint khong advance sau enqueue failure; import upload/enqueue completion mot minh khong mark `COMPLETED`; `COMPLETED` khong the xay ra truoc khi enqueue production ket thuc; concurrent final batch workers tao mot terminal state dung; progress invariants duoi concurrent workers; `rowsProcessed` khong bao gio vuot `rowsRead`; `rowsProcessed = rowsSucceeded + rowsFailed`; outbox duplicate publication harmless ke ca khi duplicate logs xay ra.

**Test strategy:** Real PostgreSQL/Redis integration tests khi kha thi; controlled mocks chi cho failure injection kho thuc hien voi live dependencies.

**Verification commands:** `pnpm test:integration`, `pnpm test:e2e`.

**Acceptance criteria:** Moi proof duoc liet ke co passing test va assert database/lifecycle invariants, khong chi HTTP responses.

**Documentation impact:** Testing docs sau.

**Comment requirements:** Comment test harness concurrency controls, failure injection points, va vi sao moi invariant quan trong.

### Task 24: k6 Spike Tests Va DB Invariant Verification

**Objective:** Them load/spike testing chung minh BullMQ buffering va bounded worker protection.

**Dependencies:** Tasks 14, 16, 20, va 23.

**Files/modules expected to change:** `load-tests/*`, scripts cho invariant queries, README snippets.

**Implementation scope:** k6 scenario voi nhieu delivery attempts va it unique logical changes hon; post-run DB invariant verification script.

**Test strategy:** Chay scaled local spike test va verify persisted changes, duplicates prevented, stale prevented, latency/error metrics, va queue backlog behavior.

**Verification commands:** `k6 run load-tests/spike.js`, invariant query command, `pnpm test:integration`.

**Acceptance criteria:** Results gom total attempts, unique logical changes, persisted changes, duplicates/stale prevented, p50/p95/p99 khi kha thi, error rate, va queue backlog behavior.

**Documentation impact:** Testing/load docs sau.

**Comment requirements:** Comment load-test data distribution, duplicate/stale mix, va machine-scaling trade-offs.

### Task 25: Bilingual Documentation Va ADRs

**Objective:** Tao synchronized English/Vietnamese project docs va required ADRs.

**Dependencies:** Tasks 3, 4, 9, 11, 13, 16, 17, 19, 21, 23, va 24.

**Files/modules expected to change:** `README.md`, `README.vi.md`, `docs/en/*`, `docs/vi/*`, `docs/en/adr/*`, `docs/vi/adr/*`.

**Implementation scope:** Architecture, exactly-once, failure handling, Excel streaming, outbox, Redis/BullMQ failure model, SSE progress, testing, tat ca ADRs 001-010.

**Test strategy:** Documentation consistency review; link/path checks khi kha thi.

**Verification commands:** `rg` checks cho docs/ADRs bat buoc, manual bilingual synchronization review.

**Acceptance criteria:** English va Vietnamese docs semantically equivalent; docs mo ta actual implementation, khong chi initial design.

**Documentation impact:** Day la documentation task.

**Comment requirements:** Khong ap dung cho code; document trade-offs trong ADRs.

### Task 26: AI Usage Disclosure

**Objective:** Document chinh xac AI-assisted work va verification evidence.

**Dependencies:** Task 25 va implementation evidence tu cac task truoc.

**Files/modules expected to change:** `docs/en/ai-usage.md`, `docs/vi/ai-usage.md`.

**Implementation scope:** Ghi candidate decisions, AI-generated/assisted code, generated code da review/modify, commands da chay, assumptions da verify, va unfinished work.

**Test strategy:** Manual consistency check voi git history/task log.

**Verification commands:** `rg -n "AI|commands|unfinished|verified" docs/en/ai-usage.md docs/vi/ai-usage.md`.

**Acceptance criteria:** Disclosure chinh xac va khong claim AI-generated code la manually written.

**Documentation impact:** AI usage docs.

**Comment requirements:** Khong ap dung.

### Task 27: Final Review Va Code Simplification

**Objective:** Thuc hien code-review-and-quality va code-simplification ma khong lam yeu guarantees bat buoc.

**Dependencies:** Tasks 1-26.

**Files/modules expected to change:** Chi files can review fixes hoac simplification.

**Implementation scope:** Review correctness, concurrency, failure semantics, TypeORM use, queue semantics, security/input validation, tests, docs; bo complexity khong can thiet.

**Test strategy:** Full suite sau thay doi.

**Verification commands:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, `docker compose up --build`, k6 spike command.

**Acceptance criteria:** Khong con speculative abstractions; transactions, constraints, idempotency, checkpoint safety, backpressure, Redis failure handling, va docs van nguyen.

**Documentation impact:** Cap nhat docs neu review doi behavior.

**Comment requirements:** Dam bao complex blocks co explanatory comments; bo stale hoac obvious comments.

## Checkpoints

- Sau Tasks 1-5: tooling, config, Docker skeleton, database schema, va API contracts co the review.
- Sau Tasks 6-11: canonical change processing va exactly-once effect duoc chung minh.
- Sau Tasks 12-17: inventory, queues, webhook, polling, worker role, va outbox operational.
- Sau Tasks 18-23: imports, progress, SSE, health, va critical concurrency/failure proofs pass.
- Sau Tasks 24-27: k6, documentation, AI disclosure, final review, va simplification hoan tat.

## Tasks Can Source Verification Trong Implementation

- Task 3: Docker/Nest worker bootstrap details.
- Task 4: TypeORM migrations va PostgreSQL numeric/JSON/constraint behavior.
- Task 9: PostgreSQL advisory locks qua TypeORM.
- Task 13: NestJS BullMQ queue/processor APIs va BullMQ retry/concurrency options.
- Task 16: NestJS Schedule setup va scheduler lifecycle.
- Task 19: Busboy streaming semantics, Node temporary-file APIs, `yauzl` ZIP entry stream behavior, va `sax` incremental XML parser behavior.
- Task 20: Redis atomic operations cho progress counters.
- Task 21: NestJS SSE `Observable<MessageEvent>` behavior va disconnect handling.

## Open Questions

Khong con open architecture questions cho PLAN. Implementation-specific API details phai duoc verify tu official docs trong task lien quan truoc khi code.
