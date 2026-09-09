# CDMS Prototype

This repository contains a Change Data Management Service prototype for product and inventory changes. It accepts changes from inventory polling, webhooks, and streamed XLSX uploads, normalizes them into one change contract, buffers them in BullMQ, and applies business correctness in PostgreSQL.

This is a one-machine prototype, not a production capacity claim. The source remains one NestJS project. Docker Compose runs separate API and worker process roles from the same image; this is neither a monorepo nor a microservice source split.

## Architecture

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

The API process owns HTTP, polling, upload ingestion, SSE, and health checks. The worker process owns change consumption, import-batch consumption, outbox publication, and downstream logging. PostgreSQL is the correctness boundary; Redis/BullMQ provides buffering, retries, and bounded worker concurrency.

## Prerequisites

- Node.js 24 or compatible current Node runtime.
- pnpm 12.3.4.
- Docker Desktop or another Docker Compose implementation.
- k6 for the Task 24 local spike proof.

## Local setup

```bash
pnpm --version
```

The expected version is `12.3.4`. If pnpm is not available on `PATH`, bootstrap it once with Corepack:

```bash
corepack enable
corepack prepare pnpm@12.3.4 --activate
pnpm --version
```

After that, use direct `pnpm` commands:

```bash
pnpm install
cp .env.example .env
pnpm build
pnpm migration:run
```

The `.env.example` values are demo-only local defaults. Do not use them as production credentials. Configuration is validated through one typed NestJS configuration boundary.

## Docker Compose

```bash
docker compose up --build
```

Compose starts `cdms` (HTTP API and scheduled polling), `worker` (a separate Nest application context for BullMQ consumers and outbox work), `postgres`, and `redis`. The API is available at `http://localhost:3000`. Run migrations before using a fresh database:

```bash
pnpm migration:run
```

After `pnpm build`, the same roles can be run locally in separate terminals when PostgreSQL and Redis are already available:

```bash
pnpm start:prod
pnpm start:worker
```

## Useful commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm load:spike
```

`pnpm load:spike` requires a healthy API, worker, PostgreSQL, Redis, and k6. It first seeds a namespaced baseline, runs duplicate-heavy and stale webhook deliveries, samples the change queue, waits for drain, and verifies PostgreSQL invariants. Configure `BASE_URL`, `UNIQUE_CHANGES`, `DUPLICATE_FACTOR`, `SPIKE_VUS`, `CHANGE_WORKER_CONCURRENCY`, and `REDIS_PORT` as needed.

## API surface

- `GET /health`
- `GET /inventory/products`
- `GET /inventory/products/:id`
- `POST /inventory/products`
- `PATCH /inventory/products/:id`
- `POST /webhooks/inventory`
- `POST /imports/products`
- `GET /imports/:id`
- `GET /imports/:id/progress` (SSE)

Polling uses the stable `(updatedAt, productId)` cursor and advances only after a complete page has been accepted by BullMQ. Webhook and import HTTP success means asynchronous enqueue acceptance, not completed business processing.

## Configuration defaults

Validated defaults include `PORT=3000`, PostgreSQL on `localhost:5432`, Redis on `localhost:6379`, `POLL_INTERVAL_MS=5000`, `INVENTORY_SEED_COUNT=1000`, `IMPORT_BATCH_SIZE=500`, `IMPORT_MAX_PENDING_BATCHES=100`, `IMPORT_MAX_FILE_SIZE_MB=100`, `IMPORT_REDIS_RETRY_TIMEOUT_MS=30000`, `CHANGE_WORKER_CONCURRENCY=10`, `OUTBOX_BATCH_SIZE=100`, and `OUTBOX_POLL_INTERVAL_MS=1000`. See `.env.example` and [the architecture document](docs/en/architecture.md).

## Guarantees and limitations

The service provides exactly-once effect at the PostgreSQL/business level, not exactly-once message delivery. A transaction-scoped PostgreSQL advisory lock, canonical fingerprinting, version rules, and the unique `(product_id, version)` constraint protect state/history correctness. The transactional outbox protects the PostgreSQL commit to asynchronous publication boundary, but downstream publication may be duplicated.

Excel files are streamed through a controlled temporary file and a bounded Node stream pipeline. The parser supports the required first-worksheet XLSX subset; shared strings consume memory proportional to the workbook's shared-string table, and staging uses local disk. SSE is a live status channel, not durable messaging. Catastrophic Redis loss after acknowledged enqueue may lose queued work that has not reached PostgreSQL.

Task 24 results are developer-machine evidence, not an SLA or production capacity certification.

## Detailed documentation

- [End-user and reviewer usage guide](docs/en/usage-guide.md) | [Vietnamese](docs/vi/usage-guide.md)
- [Workflow diagrams](docs/en/workflows.md) | [Vietnamese](docs/vi/workflows.md)
- [Architecture](docs/en/architecture.md) | [Vietnamese](docs/vi/architecture.md)
- [Exactly-once effect](docs/en/exactly-once.md) | [Vietnamese](docs/vi/exactly-once.md)
- [Failure handling](docs/en/failure-handling.md) | [Vietnamese](docs/vi/failure-handling.md)
- [Excel streaming](docs/en/excel-streaming.md) | [Vietnamese](docs/vi/excel-streaming.md)
- [Transactional outbox](docs/en/transactional-outbox.md) | [Vietnamese](docs/vi/transactional-outbox.md)
- [Redis/BullMQ failure model](docs/en/redis-bullmq-failure-model.md) | [Vietnamese](docs/vi/redis-bullmq-failure-model.md)
- [SSE progress](docs/en/sse-progress.md) | [Vietnamese](docs/vi/sse-progress.md)
- [Testing](docs/en/testing.md) | [Vietnamese](docs/vi/testing.md)
- [AI usage disclosure](docs/en/ai-usage.md) | [Vietnamese](docs/vi/ai-usage.md)
- [Architecture decisions](docs/en/adr/0001-one-nestjs-project.md)

The AI usage disclosure records assistance, human review, verification evidence, rejected approaches, and remaining limitations.
