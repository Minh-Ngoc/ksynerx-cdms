# Dac Ta: Prototype Change Data Management Service

## 1. Muc Tieu

Xay dung prototype Change Data Management Service (CDMS) cho thay doi product va inventory. He thong nhan thay doi tu scheduled polling, webhook callback, va Excel upload dang streaming, chuan hoa ve mot contract noi bo, buffer viec xu ly qua BullMQ, va chi persist cac logical change hop le moi trong PostgreSQL.

Thanh cong nghia la prototype the hien duoc duplicate handling, stale update prevention, concurrent processing correctness, failure handling, asynchronous buffering, streaming Excel ingestion, real progress streaming, tai lieu ro rang, va van hanh bang container tren mot may.

## 2. Pham Vi

Trong pham vi:

- Chi du lieu product/inventory.
- Inventory emulator trong cung NestJS project.
- CDMS ingestion qua polling, webhook, va Excel upload.
- Mot duong xu ly chung sau khi normalize change.
- TypeORM entities va migrations cho product state, product changes, outbox events, import jobs, va inventory emulator products.
- Redis/BullMQ queues va bounded workers.
- Transactional outbox.
- Import progress qua SSE.
- Unit, integration, concurrency, e2e, va k6 spike tests.
- Tai lieu song ngu tieng Anh va tieng Viet.

## 3. Ngoai Pham Vi

- Khong xay distributed architecture cap production.
- Khong monorepo.
- Khong tach source thanh microservices.
- Khong Kafka, Temporal, Airflow, Kubernetes, RabbitMQ, NATS, hoac event sourcing.
- Khong PostgreSQL Inbox Pattern neu chua duoc chap thuan ro rang.
- Khong authentication hoac authorization neu chua co spec duoc chap thuan sau nay.
- Khong mo rong thanh inventory domain day du ngoai cac truong product/inventory can cho assignment.

## 4. Yeu Cau Chuc Nang

- Inventory emulator cung cap endpoint list product, product detail, create product, va update product.
- Moi mutation cua product tang `version` mot cach monotonically.
- Inventory emulator seed volume mac dinh la `INVENTORY_SEED_COUNT=1000` va co the cau hinh.
- Webhook endpoint chi accept inventory change sau khi validate va enqueue thanh cong.
- Polling doc thay doi incremental va chi advance checkpoint sau khi enqueue thanh cong.
- Excel import endpoint stream multipart upload qua streaming parser, validate rows, normalize rows, va enqueue bounded batches.
- Import jobs duoc persist va bao cao durable status.
- SSE endpoint stream latest import progress snapshot va completed/failed events.
- Workers xu ly normalized changes qua mot change processor chung.
- Duplicate logical changes khong tao them `product_changes` row.
- Stale versions khong bao gio lam lui `product_state`.
- Cung product/version nhung fingerprint khac nhau duoc bao cao la `VERSION_CONFLICT`.
- Accepted changes insert history, update latest state, va insert outbox event mot cach atomic.
- Outbox publisher publish pending committed events voi retry va chap nhan duplicate publication.
- Outbox downstream publication dung mot BullMQ queue rieng voi minimal duplicate-tolerant downstream consumer; consumer co the chi structured logging.

## 5. Yeu Cau Phi Chuc Nang

- Su dung strict TypeScript va NestJS dependency injection.
- Su dung TypeORM migrations, khong dung `synchronize: true`.
- Gioi han worker concurrency bang config.
- Tranh Redis tang truong khong gioi han khi Excel upload.
- Khong giu toan bo Excel file hoac toan bo rows trong memory.
- Su dung structured logs voi cac field ngu canh.
- Tranh log raw payload lon hoac noi dung day du cua Excel.
- Document moi gioi han ve persistence, concurrency, va durability.

## 6. Kien Truc

Tat ca ingestion paths normalize ve cung mot contract:

```text
Polling -----\
Webhook ------> Normalize -> BullMQ -> bounded worker -> ChangeProcessor -> PostgreSQL transaction
Excel stream -/
```

BullMQ hap thu spike, buffer workload, retry, va gioi han processing concurrency. PostgreSQL dam bao correctness bang transactions, constraints, locks, va idempotent writes.

Outbox path chi bat dau sau khi business processing thanh cong:

```text
DB transaction -> product_changes + product_state + outbox_events -> commit -> Outbox Publisher -> BullMQ/downstream
```

## 7. Ranh Gioi NestJS Module

Ranh gioi module du kien:

- `config`: validated environment configuration.
- `database`: TypeORM setup, data source, migrations.
- `inventory`: emulator endpoints va product persistence.
- `changes`: normalized contract, fingerprinting, va transactional change processing.
- `queue`: BullMQ queue producers va workers.
- `ingestion`: webhook va polling normalization.
- `imports`: streaming Excel upload, import jobs, progress, SSE.
- `outbox`: outbox entity, claiming, publishing, va retry state.
- `health`: service health endpoint.
- `common`: shared enums, types, filters, utilities, va logging helpers chi khi co nhu cau dung chung that.

Khong tao module rong hoac abstraction suy doan chi de khop voi cay thu muc muc tieu.

## 8. Runtime Topology

Source van la mot NestJS project. Docker Compose co the chay nhieu process role tu cung image:

- `cdms`: HTTP API va scheduler khi phu hop.
- `worker`: process role rieng cho BullMQ worker, outbox publisher, va downstream consumer.
- `postgres`: PostgreSQL database.
- `redis`: Redis cho BullMQ va live progress coordination.

Worker phai chay nhu mot process/container role rieng cho prototype. No dung cung repository, cung NestJS source project, va tot nhat la cung Docker image. Day khong phai microservice source split va khong phai monorepo. Viec tach nay nham bounded processing concurrency, failure isolation ro hon, va de demo worker restart/failure de hon.

## 9. API Contracts

### Inventory Emulator

`GET /inventory/products`

- Query: optional stable composite cursor fields `updatedAfter` va `afterProductId` cho incremental polling.
- Ordering: `ORDER BY updated_at ASC, id ASC`.
- Cursor semantics: tra rows voi `updated_at > lastUpdatedAt OR (updated_at = lastUpdatedAt AND id > lastProductId)`.
- Response: mang products.
- Status: `200`.

`GET /inventory/products/:id`

- Response: product.
- Status: `200`, `404`.

`POST /inventory/products`

- Request: `sku`, `name`, `price`, `quantity`.
- Behavior: tao version `1`.
- Status: `201`, `400`, `409` neu enforce duplicate SKU.

`PATCH /inventory/products/:id`

- Request: partial `sku`, `name`, `price`, `quantity`.
- Behavior: tang version monotonically.
- Status: `200`, `400`, `404`, `409` neu conflict rules yeu cau.

### CDMS

`POST /webhooks/inventory`

- Request: product id, version, source payload, va optional observed timestamp.
- Behavior: validate, normalize, enqueue.
- Status: `202` chi sau khi enqueue thanh cong; `400` neu payload khong hop le; `503` neu Redis/BullMQ enqueue khong san sang.
- Retry semantics: caller co the retry `503`; duplicate an toan o database level.

`POST /imports/products`

- Request: multipart Excel file toi da `IMPORT_MAX_FILE_SIZE_MB`, default `100`.
- Behavior: tao import job, stream rows, validate, normalize, enqueue bounded batches.
- Response: `{ "importId": "...", "status": "PROCESSING" }`.
- Status: `202` sau khi upload parsing/enqueueing hoan tat; `400` neu file/request sai; `503` hoac documented failure status neu Redis fail qua bounded retry.

`GET /imports/:id`

- Response: durable import job state.
- Status: `200`, `404`.

`GET /imports/:id/progress`

- Response: `text/event-stream`.
- Event names: `progress`, `completed`, `failed`.
- Behavior: gui latest known snapshot truoc, sau do gui live updates.

`GET /health`

- Response: service va dependency health.
- Status: `200` khi healthy, error status phu hop khi dependency bat buoc khong san sang.

## 10. Database Schema

`product_state`

- `product_id` primary key.
- `version`.
- `fingerprint`.
- `payload jsonb`.
- `updated_at`.
- Muc dich: latest accepted state cho moi product.

`product_changes`

- `id uuid` primary key.
- `product_id`.
- `version`.
- `fingerprint`.
- `source`.
- `payload jsonb`.
- `created_at`.
- Unique constraint: `(product_id, version)`.
- Muc dich: immutable accepted logical change history.

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
- `price` la PostgreSQL `NUMERIC(18,2)`.
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

Ingress-specific DTOs phai duoc normalize truoc khi vao business processing. Khong duplicate business rules giua webhook, polling, va Excel paths.

## 12. Exactly-Once Effect

Prototype khong claim exactly-once message delivery. He thong cung cap exactly-once effect o database/business level.

Voi moi normalized input:

1. Bat dau PostgreSQL transaction.
2. Lay per-product concurrency protection da cau hinh.
3. Doc `product_state`.
4. Tinh deterministic fingerprint tu canonical payload.
5. Ap dung version/fingerprint rules.
6. Voi accepted new changes, insert `product_changes`, upsert `product_state`, va insert `outbox_events` trong cung transaction.

Processing results:

- `ACCEPTED`: chua co state hoac incoming version moi hon.
- `STALE`: incoming version nho hon current state.
- `DUPLICATE`: incoming version bang current version va fingerprint khop.
- `VERSION_CONFLICT`: incoming version bang current version va fingerprint khac.
- `FAILED`: loi xu ly ngoai cac semantic outcomes du kien.

## 13. Concurrency Strategy

BullMQ concurrency kiem soat throughput nhung khong phai co che correctness. PostgreSQL transactions va constraints phai van dung khi nhieu workers xu ly cung mot product dong thoi.

Chien luoc du kien la PostgreSQL transaction-scoped advisory lock theo `productId`, cong them unique constraint `(product_id, version)` nhu invariant phong thu. Cach nay xu ly ca existing-row va missing-row races bang mot diem serialize theo product.

Advisory-lock key derivation phai deterministic, stable qua cac process va restart, co documented collision behavior, va duoc test. Implementation phase phai verify API PostgreSQL va TypeORM chinh xac bang official documentation truoc khi code.

## 14. Missing-Row Race Strategy

`SELECT ... FOR UPDATE` khong lock duoc row chua ton tai. Concurrent first writes cho cung product phai duoc xu ly ro rang.

Quyet dinh o spec level: dung transaction-scoped PostgreSQL advisory lock theo canonical `productId` truoc khi doc hoac ghi state. Cach nay serialize first insert attempts cua mot product. Lock key phai duoc derive deterministic va stable qua process/restart. Collision behavior phai duoc document va test. Implementation phai them ADR va concurrency integration test chung minh nhieu concurrent first writes chi tao dung mot accepted logical row.

## 15. BullMQ Ingress

Tat ca external ingestion paths enqueue normalized work truoc business processing. Chi tra success cho client sau khi `queue.add()` thanh cong. Neu Redis/BullMQ khong san sang truoc khi enqueue thanh cong, request chua duoc durable accepted va phai tra retriable failure.

BullMQ job IDs co the dung cho retry ergonomics, nhung database idempotency van la ranh gioi correctness.

## 16. Redis Failure Semantics

Neu Redis khong san sang truoc enqueue:

- Webhook tra `503` hoac documented retriable failure.
- Polling khong advance checkpoint va retry lan sau.
- Excel upload pause/retry trong bounded policy hoac mark import `FAILED`.

Neu Redis fail sau khi jobs da duoc accepted, workers nen reconnect va resume khi co the.

Known limitation: catastrophic Redis data loss sau khi ingestion request da duoc acknowledge co the mat queued but not yet persisted changes. Prototype nay khong them PostgreSQL Inbox Pattern neu chua duoc approve.

Excel imports dung bounded Redis enqueue retry timeout, default `IMPORT_REDIS_RETRY_TIMEOUT_MS=30000`. Neu Redis khong recover trong timeout, import duoc mark `FAILED`.

## 17. Polling Checkpoint Semantics

Polling phai dung stable composite cursor `(updatedAt, productId)` thay vi timestamp-only checkpoint. Inventory reads phai dung deterministic ordering:

```sql
ORDER BY updated_at ASC, id ASC
```

Cursor semantics tuong duong:

```sql
updated_at > lastUpdatedAt
OR (updated_at = lastUpdatedAt AND id > lastProductId)
```

Checkpoint chi advance sau khi toan bo fetched page duoc BullMQ accept thanh cong. Neu bat ky enqueue nao fail, checkpoint giu gia tri truoc do va cycle sau retry. Duplicate re-polling duoc uu tien hon skipped changes vi database processing idempotent.

## 18. Webhook Behavior

Webhook processing validate input, normalize payload, enqueue normalized change, va tra `202 Accepted` chi sau khi enqueue thanh cong. Endpoint nay khong insert business data truc tiep va khong duplicate version/fingerprint logic.

## 19. Excel Streaming

Excel imports phai dung streaming-capable library nhu ExcelJS streaming reader sau khi verify docs trong implementation. Flow:

```text
multipart stream -> streaming Excel reader -> row validation -> normalization -> bounded batches -> BullMQ
```

Server khong duoc load full upload, workbook, hoac full row set vao memory.

Upload size limit mac dinh la `IMPORT_MAX_FILE_SIZE_MB=100`. Limit phai duoc enforce trong luc streaming va khong duoc yeu cau buffer toan bo upload truoc khi reject.

## 20. Backpressure

Dung `IMPORT_BATCH_SIZE`, default `500`, va `IMPORT_MAX_PENDING_BATCHES`, default `100`. Implementation phai bound in-flight hoac queued batches va khong busy-loop. Queue backlog inspection duoc chap nhan, nhung khong bat buoc tren moi batch neu bounded producer hoac semaphore strategy sach hon cung cap cung muc an toan.

Backpressure phai lam streaming parser cham lai tu nhien thay vi doc va discard data.

## 21. Import Lifecycle

Persist import jobs voi statuses:

- `CREATED`: job record ton tai.
- `UPLOADING`: upload stream dang duoc doc va parse.
- `PROCESSING`: upload parsing/enqueueing da xong; background jobs co the van chay.
- `COMPLETED`: tat ca readable/enqueued rows da dat terminal row-processing outcome. Dieu nay khong co nghia moi row deu succeeded; `rowsFailed` co the lon hon `0`.
- `FAILED`: ban than import khong the tiep tuc hoac khong the dat normal terminal processing.

Ket noi `POST /imports/products` chi mo trong luc server nhan, parse, va enqueue upload. No khong doi tat ca background processing hoan tat.

## 22. SSE Progress

`GET /imports/:id/progress` dung `text/event-stream` chi cho server-to-client progress/status. Endpoint gui latest snapshot truoc. Fields:

- `rowsRead`.
- `rowsProcessed`.
- `rowsSucceeded`.
- `rowsFailed`.
- `totalRows`.
- `percent`.
- `status`.

`totalRows` co the null. `percent` phai null khi chua biet total rows. Khong tao progress percentage gia.

Progress invariants:

- `rowsProcessed = rowsSucceeded + rowsFailed`.
- `rowsProcessed <= rowsRead`.
- Voi `COMPLETED`, `rowsProcessed = rowsRead`.

Concurrent progress updates phai dung atomic Redis operations. Khong implement progress counters bang non-atomic read-modify-write.

## 23. Transactional Outbox

Accepted changes insert outbox event trong cung transaction voi state/history writes. Publisher doc va claim pending events theo bounded batches, publish vao mot dedicated BullMQ downstream queue, va chi mark published sau khi enqueue thanh cong. Failure tang attempts va luu `last_error`.

Downstream queue co minimal duplicate-tolerant downstream consumer co the chi structured logging. Muc dich la demo asynchronous outbox publication that ma khong them service hoac infrastructure system khac. Duplicate downstream delivery duoc chap nhan, khong duoc mutate business state, va khong duoc violate database invariants. Duplicate structured log entries duoc chap nhan cho prototype nay. Khong them processed-events table, Inbox Pattern, hoac persistence mechanism khac chi de deduplicate logs. Consumer la duplicate-tolerant, khong strictly idempotent neu xet observable logging side effect. Neu publication thanh cong nhung mark published fail, duplicate publication duoc chap nhan. Accepted business changes va outbox rows duoc commit atomically. Outbox bao ve boundary tu PostgreSQL commit den asynchronous publication; no khong cung cap exactly-once delivery.

## 24. Failure Matrix

| Scenario | Expected behavior | Retry behavior | Persistence behavior | Client behavior | Data loss | Support |
|---|---|---|---|---|---|---|
| Duplicate webhook delivery | Duplicate thanh `DUPLICATE` | Safe retry | Mot `product_changes` row | Lan dau/duplicate tra `202` neu Redis accept | Khong duplicate DB | Supported |
| Concurrent webhook duplicates | PostgreSQL concurrency strategy serialize theo product | Worker retry khi transient DB error | Mot logical row | `202` sau enqueue | Khong duplicate DB | Supported |
| Polling + webhook same change | Ca hai normalize cung identity | Safe retry | Mot logical row | Webhook `202`; poll checkpoint advance sau enqueue | Khong duplicate DB | Supported |
| Polling + webhook + Excel same change | Tuong tu tren qua ba sources | Safe retry | Mot logical row | Response theo tung source sau enqueue | Khong duplicate DB | Supported |
| Old version after new version | Result `STALE` | Khong can semantic retry | State van o version moi hon | Ingestion da queued co the van `202` | Khong regression | Supported |
| Same version different payload | Result `VERSION_CONFLICT` voi diagnostics | Khong tu dong overwrite | State khong doi | Ingestion accepted neu queued; conflict hien trong logs/metrics/result | Khong silent overwrite | Supported |
| Concurrent first insert | Advisory lock cong unique constraint chi cho mot acceptance | Transient retry neu can | Mot state row va mot change row | Ingestion da accepted neu queued | Khong duplicate DB | Supported |
| DB unavailable | Worker fail/retry | BullMQ retry/backoff | Khong partial commit | Ingestion co the da `202` neu queued | Khong committed partial change | Supported |
| Redis unavailable before enqueue | Request khong duoc accepted | Caller/poller/import retry | Khong queued work | Webhook/import tra retriable failure; polling checkpoint giu nguyen | Khong false acceptance | Supported |
| Redis unavailable during Excel upload | Pause/retry, roi continue hoac fail import | Bounded retry | Import mark `FAILED` neu retry window het han | Upload tra failure hoac failed import response | Queued work co the hoan tat sau | Supported voi documented limits |
| Worker restart | Jobs resume khi Redis con giu jobs | BullMQ retry/resume | DB processing idempotent | Khong co direct client connection | Chi co the mat khi catastrophic Redis loss | Supported |
| Worker crash before DB commit | Transaction rollback | Job retry | Khong partial commit | Khong co direct client connection | Khong committed partial change | Supported |
| Worker crash after DB commit | Job co the retry | Retry thanh duplicate/stale | Committed data giu nguyen | Khong co direct client connection | Khong duplicate DB | Supported |
| Inventory emulator unavailable | Poll log failure va giu checkpoint | Poll sau retry | Khong corrupt checkpoint | Health co the bao dependency issue | Khong skip polled changes | Supported |
| Outbox publish failure | Attempts tang va last error duoc luu | Publisher retry | Event van pending | Khong hien truc tiep cho client | Khong mat committed event | Supported |
| Outbox duplicate publication | Downstream co the nhan duplicate | Downstream handling phai tolerate duplicate delivery; duplicate structured logs duoc chap nhan | Outbox cuoi cung mark published | Khong hien truc tiep cho client | Khong mat committed event | Supported, duplicate possible |
| Malformed Excel row | Row tinh failed; valid rows tiep tuc neu file parser tiep tuc duoc | Row khong retry tru khi reupload file | Import progress ghi nhan failure | Progress hien failed row count | Malformed row khong persisted | Supported |
| Oversized/large Excel | Streaming voi bounded batches/backpressure | Import co the fail neu vuot limit | Khong full-file RAM buffering | `202` hoac documented failure | Khong duplicate DB da accepted | Supported |
| Queue backlog saturation | Producer pause/throttle | Resume khi backlog giam | Khong enqueue Redis vo han | Upload cham hon hoac fail do timeout | Khong read-and-discard | Supported |
| SSE reconnect | Gui latest snapshot truoc | Client tu reconnect | PostgreSQL giu durable progress | Nhan current state roi live events | Khong fake progress | Supported |

## 25. Observability

Su dung structured logs voi cac field nhu `productId`, `version`, `source`, `importId`, `jobId`, `outboxEventId`, `result`, `durationMs`, va `attempt`. Log processing results la `ACCEPTED`, `STALE`, `DUPLICATE`, `VERSION_CONFLICT`, hoac `FAILED`. Khong log full Excel files hoac raw payload lon.

## 26. Testing Strategy

Dung Jest voi NestJS testing utilities.

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

- 100 concurrent attempts cho cung `productId` va version persist dung mot logical change.
- Concurrent versions 5 va 6 de final `product_state.version = 6`.
- No-existing-state race duoc test rieng.

E2E tests:

- Inventory endpoints.
- Webhook accepted/failure behavior.
- Import lifecycle va progress endpoint.
- Health endpoint.

Load tests:

- k6 spike dai dien cho nhieu delivery attempts va it unique logical changes hon.
- Bao cao total attempts, unique logical changes, persisted changes, duplicates prevented, stale updates prevented, latency percentiles, error rate, va queue backlog behavior.

## 27. Load Testing

Dung k6 scripts trong thu muc load-test rieng. Co the giam so lieu cho developer machine, nhung test phai chung minh BullMQ hap thu spike trong khi bounded workers bao ve PostgreSQL. Verification sau test phai query DB invariants thay vi chi bao throughput.

## 28. Docker Topology

Docker Compose phai chay tren mot may voi PostgreSQL, Redis, va NestJS application. Worker container rieng la bat buoc nhu process role thu hai dung cung source/image, khong phai source application rieng. Separate worker process/container role ton tai de bounded processing concurrency, failure isolation ro hon, va demo worker restart/failure.

## 29. Environment Variables

Environment variables du kien:

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

Tao `.env.example` trong implementation. Khong commit credentials that.

## 30. Documentation Rules

Tai lieu persistent phai co ca tieng Anh va tieng Viet. Tieng Anh la ban canonical. Ban tieng Viet phai giu cung semantics bang tieng Viet ky thuat tu nhien. Tai lieu du kien gom:

- `README.md` va `README.vi.md`.
- `docs/en/architecture.md` va `docs/vi/architecture.md`.
- `docs/en/exactly-once.md` va `docs/vi/exactly-once.md`.
- `docs/en/failure-handling.md` va `docs/vi/failure-handling.md`.
- `docs/en/excel-streaming.md` va `docs/vi/excel-streaming.md`.
- `docs/en/transactional-outbox.md` va `docs/vi/transactional-outbox.md`.
- `docs/en/redis-bullmq-failure-model.md` va `docs/vi/redis-bullmq-failure-model.md`.
- `docs/en/sse-progress.md` va `docs/vi/sse-progress.md`.
- `docs/en/testing.md` va `docs/vi/testing.md`.
- `docs/en/ai-usage.md` va `docs/vi/ai-usage.md`.
- ADRs trong `docs/en/adr` va `docs/vi/adr`.

## 31. AI Disclosure

`docs/en/ai-usage.md` va `docs/vi/ai-usage.md` phai disclose chinh xac architecture decisions, code AI-assisted/generated, generated code da duoc review hoac modify, commands da chay, assumptions da manually verified, va unfinished work con lai. Khong claim sai rang AI-generated work la manually written.

## 32. Known Prototype Limitations

- Catastrophic Redis data loss sau enqueue acknowledgement co the lam mat queued but unpersisted changes.
- Khong PostgreSQL Inbox Pattern neu chua duoc approve sau nay.
- Outbox publication co the duplicate neu publish thanh cong nhung marking published fail.
- SSE khong phai durable messaging; no la live status channel voi database-backed snapshots.
- Inventory emulator chi ton tai de ho tro assignment va khong nen thanh full inventory system.

## 33. Acceptance Criteria

- `AGENTS.md`, `SPEC.md`, va `SPEC.vi.md` ton tai truoc implementation.
- Nhieu ingestion sources hoi tu ve mot normalized processing path.
- PostgreSQL, khong phai BullMQ, enforce correctness.
- Duplicate delivery an toan o database level.
- Stale updates khong bao gio regress state.
- Same-version payload conflicts duoc detect.
- Missing-row first-write race duoc giai quyet ro va test.
- Excel uploads duoc streaming voi bounded batching va backpressure.
- SSE chi bao real progress.
- Redis/BullMQ failure semantics ro rang.
- Transactional outbox bao ve committed changes khoi downstream dual-write loss.
- Docker Compose chay prototype tren mot may.
- Tests va k6 chung minh cac invariants bat buoc.
- Tai lieu tieng Anh va tieng Viet duoc dong bo.

## 34. Engineering Boundaries

Always:

- Mot NestJS project.
- TypeORM va PostgreSQL.
- Redis/BullMQ truoc business processing.
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
- Thay PostgreSQL hoac TypeORM.
- Bo BullMQ.
- Doi durable acceptance hoac concurrency strategy.

Never:

- Full Excel file buffering.
- Fake SSE progress.
- Acknowledge request khi enqueue failed.
- Claim global exactly-once delivery.
- Chi dua vao queue deduplication.
- Silently resolve version conflict.
- Skip database correctness tests.

## Commands

Commands hien tai:

```bash
pnpm lint
pnpm build
pnpm test
pnpm test:e2e
```

Commands can them trong implementation:

```bash
pnpm typecheck
pnpm test:integration
docker compose up --build
docker compose down -v
```

## Project Structure

Target structure, chi dieu chinh khi implementation chung minh cau truc feature-oriented don gian hon la tot hon:

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

Dung strict TypeScript, DTO ro rang, NestJS DI, service nho, va comments cho invariant khong obvious:

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

- Khong con open architecture questions trong SPEC phase.
- Implementation van phai verify PostgreSQL advisory lock APIs, TypeORM transaction behavior, BullMQ APIs, Excel streaming APIs, va NestJS SSE/multipart APIs bang official documentation truoc khi code.
