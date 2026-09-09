# CDMS Prototype

Repository này chứa prototype Change Data Management Service cho thay đổi product và inventory. Hệ thống nhận thay đổi từ polling inventory, webhook, và upload XLSX streaming; normalize về một change contract, buffer bằng BullMQ, và áp dụng correctness nghiệp vụ tại PostgreSQL.

Đây là prototype chạy một máy, không phải cam kết capacity production. Source vẫn là một NestJS project. Docker Compose chạy API và worker process role riêng từ cùng image; đây không phải monorepo và không phải source split thành microservice.

## Kiến trúc

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

API process sở hữu HTTP, polling scheduler, upload ingestion, SSE và health checks. Worker process sở hữu change consumer, import-batch consumer, outbox publication và downstream logging. PostgreSQL là correctness boundary; Redis/BullMQ cùng cấp buffering, retry và bounded worker concurrency.

## Yêu cầu môi trường

- Node.js 24 hoặc Node runtime tương thích.
- pnpm 12.3.4.
- Docker Desktop hoặc Docker Compose tương thích.
- k6 cho local spike proof của Task 24.

## Cài đặt local

```bash
pnpm --version
```

Version mong đợi là `12.3.4`. Nếu pnpm không có trên `PATH`, bootstrap một lần bằng Corepack:

```bash
corepack enable
corepack prepare pnpm@12.3.4 --activate
pnpm --version
```

Sau đó dùng các lệnh `pnpm` trực tiếp:

```bash
pnpm install
cp .env.example .env
pnpm build
pnpm migration:run
```

Giá trị trong `.env.example` chỉ dành cho demo local. Không dùng credential này trong production. Configuration được validate qua một typed NestJS configuration boundary.

## Docker Compose

```bash
docker compose up --build
```

Compose khởi động `cdms` (HTTP API và polling scheduler), `worker` (Nest application context riêng cho BullMQ consumer và outbox), `postgres`, và `redis`. API tại `http://localhost:3000`. Chạy migration với database hiện tại:

```bash
pnpm migration:run
```

Sau `pnpm build`, có thể chạy cùng các role local trong hai terminal riêng khi PostgreSQL và Redis đã sẵn sàng:

```bash
pnpm start:prod
pnpm start:worker
```

## Lệnh thường dùng

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm load:spike
```

`pnpm load:spike` cần API, worker, PostgreSQL, Redis healthy và k6. Lệnh này seed baseline có namespace riêng, chạy webhook duplicate-heavy và stale, sample change queue, chờ queue drain, sau đó verify PostgreSQL invariants. Có thể cấu hình `BASE_URL`, `UNIQUE_CHANGES`, `DUPLICATE_FACTOR`, `SPIKE_VUS`, `CHANGE_WORKER_CONCURRENCY` và `REDIS_PORT`.

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

Polling dùng cursor ổn định `(updatedAt, productId)` và chỉ advance sau khi cả page được BullMQ chấp nhận. HTTP success của webhook và import chỉ có nghĩa là enqueue bất đồng bộ đã được chấp nhận, không phải business processing đã hoàn tất.

## Default configuration

Default đã validate gồm `PORT=3000`, PostgreSQL `localhost:5432`, Redis `localhost:6379`, `POLL_INTERVAL_MS=5000`, `INVENTORY_SEED_COUNT=1000`, `IMPORT_BATCH_SIZE=500`, `IMPORT_MAX_PENDING_BATCHES=100`, `IMPORT_MAX_FILE_SIZE_MB=100`, `IMPORT_REDIS_RETRY_TIMEOUT_MS=30000`, `CHANGE_WORKER_CONCURRENCY=10`, `OUTBOX_BATCH_SIZE=100`, và `OUTBOX_POLL_INTERVAL_MS=1000`. Xem `.env.example` và [tài liệu kiến trúc](docs/vi/architecture.md).

## Guarantees và limitations

Hệ thống cùng cấp exactly-once effect ở PostgreSQL/business level, không cùng cấp exactly-once message delivery. PostgreSQL transaction-scoped advisory lock, canonical fingerprint, version rules và unique constraint `(product_id, version)` bảo vệ correctness của state/history. Transactional outbox bảo vệ boundary từ PostgreSQL commit đến asynchronous publication, nhưng downstream publication có thể bị lặp.

Excel được streaming qua temporary file có kiểm soát và bounded Node stream pipeline. Parser hỗ trợ XLSX subset cần thiết ở worksheet đầu tiên; shared strings dùng memory theo kích thước shared-string table và staging dùng local disk. SSE là live status channel, không phải durable messaging. Mất Redis nghiêm trọng sau khi enqueue đã được acknowledge có thể làm mất queued work chưa đến PostgreSQL.

Kết quả Task 24 là developer-machine evidence, không phải SLA hay chứng nhận production capacity.

## Tài liệu chi tiết

- [Hướng dẫn sử dụng cho người dùng và reviewer](docs/vi/usage-guide.md) | [English](docs/en/usage-guide.md)
- [Workflow diagrams](docs/vi/workflows.md) | [English](docs/en/workflows.md)
- [Kiến trúc](docs/vi/architecture.md) | [English](docs/en/architecture.md)
- [Exactly-once effect](docs/vi/exactly-once.md) | [English](docs/en/exactly-once.md)
- [Failure handling](docs/vi/failure-handling.md) | [English](docs/en/failure-handling.md)
- [Excel streaming](docs/vi/excel-streaming.md) | [English](docs/en/excel-streaming.md)
- [Transactional outbox](docs/vi/transactional-outbox.md) | [English](docs/en/transactional-outbox.md)
- [Redis/BullMQ failure model](docs/vi/redis-bullmq-failure-model.md) | [English](docs/en/redis-bullmq-failure-model.md)
- [SSE progress](docs/vi/sse-progress.md) | [English](docs/en/sse-progress.md)
- [Testing](docs/vi/testing.md) | [English](docs/en/testing.md)
- [Công bố việc sử dụng AI](docs/vi/ai-usage.md) | [English](docs/en/ai-usage.md)
- [Các quyết định kiến trúc](docs/vi/adr/0001-one-nestjs-project.md) | [English](docs/en/adr/0001-one-nestjs-project.md)

Công bố việc sử dụng AI ghi lại phạm vi hỗ trợ, human review, verification evidence, các hướng tiếp cận bị reject và limitations còn lại.
