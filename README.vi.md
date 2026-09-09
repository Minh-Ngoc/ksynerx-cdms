# CDMS Prototype

Repository nay chua prototype Change Data Management Service cho thay doi product va inventory. He thong nhan thay doi tu polling inventory, webhook, va upload XLSX streaming; normalize ve mot change contract, buffer bang BullMQ, va ap dung correctness nghiep vu tai PostgreSQL.

Day la prototype chay mot may, khong phai cam ket capacity production. Source van la mot NestJS project. Docker Compose chay API va worker process role rieng tu cung image; day khong phai monorepo va khong phai source split thanh microservice.

## Kien truc

```text
Polling -----\
Webhook ------> normalize -> BullMQ change queue -> bounded worker
Excel -------/                                      |
                                                    v
                                             ChangeProcessor
                                                    |
                                                    v
                                         PostgreSQL state/history/outbox

PostgreSQL commit -> outbox publisher -> BullMQ downstream queue -> duplicate-tolerant logger
```

API process so huu HTTP, polling scheduler, upload ingestion, SSE va health checks. Worker process so huu change consumer, import-batch consumer, outbox publication va downstream logging. PostgreSQL la correctness boundary; Redis/BullMQ cung cap buffering, retry va bounded worker concurrency.

## Yeu cau moi truong

- Node.js 24 hoac Node runtime tuong thich.
- pnpm 12.3.4.
- Docker Desktop hoac Docker Compose tuong thich.
- k6 cho local spike proof cua Task 24.

## Cai dat local

```bash
pnpm --version
```

Version mong doi la `12.3.4`. Neu pnpm khong co tren `PATH`, bootstrap mot lan bang Corepack:

```bash
corepack enable
corepack prepare pnpm@12.3.4 --activate
pnpm --version
```

Sau do dung cac lenh `pnpm` truc tiep:

```bash
pnpm install
cp .env.example .env
pnpm build
pnpm migration:run
```

Gia tri trong `.env.example` chi danh cho demo local. Khong dung credential nay trong production. Configuration duoc validate qua mot typed NestJS configuration boundary.

## Docker Compose

```bash
docker compose up --build
```

Compose khoi dong `cdms` (HTTP API va polling scheduler), `worker` (Nest application context rieng cho BullMQ consumer va outbox), `postgres`, va `redis`. API tai `http://localhost:3000`. Chay migration voi database moi:

```bash
pnpm migration:run
```

Sau `pnpm build`, co the chay cung cac role local trong hai terminal rieng khi PostgreSQL va Redis da san sang:

```bash
pnpm start:prod
pnpm start:worker
```

## Lenh thuong dung

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm load:spike
```

`pnpm load:spike` can API, worker, PostgreSQL, Redis healthy va k6. Lenh nay seed baseline co namespace rieng, chay webhook duplicate-heavy va stale, sample change queue, cho queue drain, sau do verify PostgreSQL invariants. Co the cau hinh `BASE_URL`, `UNIQUE_CHANGES`, `DUPLICATE_FACTOR`, `SPIKE_VUS`, `CHANGE_WORKER_CONCURRENCY` va `REDIS_PORT`.

## API

- `GET /health`
- `GET /inventory/products`
- `GET /inventory/products/:id`
- `POST /inventory/products`
- `PATCH /inventory/products/:id`
- `POST /webhooks/inventory`
- `POST /imports/products`
- `GET /imports/:id`
- `GET /imports/:id/progress` (SSE)

Polling dung cursor on dinh `(updatedAt, productId)` va chi advance sau khi ca page duoc BullMQ chap nhan. HTTP success cua webhook va import chi co nghia la enqueue bat dong bo da duoc chap nhan, khong phai business processing da hoan tat.

## Default configuration

Default da validate gom `PORT=3000`, PostgreSQL `localhost:5432`, Redis `localhost:6379`, `POLL_INTERVAL_MS=5000`, `INVENTORY_SEED_COUNT=1000`, `IMPORT_BATCH_SIZE=500`, `IMPORT_MAX_PENDING_BATCHES=100`, `IMPORT_MAX_FILE_SIZE_MB=100`, `IMPORT_REDIS_RETRY_TIMEOUT_MS=30000`, `CHANGE_WORKER_CONCURRENCY=10`, `OUTBOX_BATCH_SIZE=100`, va `OUTBOX_POLL_INTERVAL_MS=1000`. Xem `.env.example` va [tai lieu kien truc](docs/vi/architecture.md).

## Guarantees va limitations

He thong cung cap exactly-once effect o PostgreSQL/business level, khong cung cap exactly-once message delivery. PostgreSQL transaction-scoped advisory lock, canonical fingerprint, version rules va unique constraint `(product_id, version)` bao ve correctness cua state/history. Transactional outbox bao ve boundary tu PostgreSQL commit den asynchronous publication, nhung downstream publication co the bi lap.

Excel duoc streaming qua temporary file co kiem soat va bounded Node stream pipeline. Parser ho tro XLSX subset can thiet o worksheet dau tien; shared strings dung memory theo kich thuoc shared-string table va staging dung local disk. SSE la live status channel, khong phai durable messaging. Mat Redis nghiem trong sau khi enqueue da duoc acknowledge co the lam mat queued work chua den PostgreSQL.

Ket qua Task 24 la developer-machine evidence, khong phai SLA hay chung nhan production capacity.

## Tai lieu chi tiet

- [Huong dan su dung cho nguoi dung va reviewer](docs/vi/usage-guide.md) | [English](docs/en/usage-guide.md)
- [Workflow diagrams](docs/vi/workflows.md) | [English](docs/en/workflows.md)
- [Kien truc](docs/vi/architecture.md) | [English](docs/en/architecture.md)
- [Exactly-once effect](docs/vi/exactly-once.md) | [English](docs/en/exactly-once.md)
- [Failure handling](docs/vi/failure-handling.md) | [English](docs/en/failure-handling.md)
- [Excel streaming](docs/vi/excel-streaming.md) | [English](docs/en/excel-streaming.md)
- [Transactional outbox](docs/vi/transactional-outbox.md) | [English](docs/en/transactional-outbox.md)
- [Redis/BullMQ failure model](docs/vi/redis-bullmq-failure-model.md) | [English](docs/en/redis-bullmq-failure-model.md)
- [SSE progress](docs/vi/sse-progress.md) | [English](docs/en/sse-progress.md)
- [Testing](docs/vi/testing.md) | [English](docs/en/testing.md)
- [AI usage disclosure](docs/vi/ai-usage.md) | [English](docs/en/ai-usage.md)
- [Architecture decisions](docs/en/adr/0001-one-nestjs-project.md)

AI usage disclosure ghi lai pham vi ho tro, human review, verification evidence, cac huong tiep can bi reject va limitations con lai.
