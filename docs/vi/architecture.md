# Kiến trúc

## Luồng runtime

```text
Polling -----\
Webhook ------> Normalize -> BullMQ change queue -> bounded worker
Excel -------/                                      |
                                                    v
                                             ChangeProcessor
                                                    |
                                                    v
                                      PostgreSQL state/history/outbox
```

Đây là một NestJS source project duy nhất. Compose dùng cùng built image cho hai role:

- `cdms`: HTTP controllers, inventory emulator, polling scheduler, upload ingestion, SSE và health.
- `worker`: Nest application context độc lập cho change consumer, import-batch consumer, outbox publisher và downstream consumer.
- `postgres`: source of truth bền vững.
- `redis`: BullMQ transport/retry coordination và live progress mirror.

Worker role tách process/container để giới hạn concurrency và có failure isolation. Đây không phải source split thành microservice và repository không phải monorepo.

## Ingestion và processing

Webhook và polling payload được validate, normalize trước khi vào `cdms-change`. Excel rows dùng cùng `ProductChangeInput`. Worker gọi `ChangeProcessor`; không dựa vào BullMQ job identity để đảm bảo correctness.

Polling dùng `ORDER BY updated_at ASC, id ASC` với predicate `updated_at > lastUpdatedAt OR (updated_at = lastUpdatedAt AND id > lastProductId)`. Checkpoint chỉ được ghi sau khi mỗi row trong page đã được BullMQ chấp nhận. Re-poll duplicate được ưu tiên hơn bỏ sót change.

## Excel flow

```text
Busboy multipart
  -> controlled temporary XLSX file
  -> yauzl ZIP entry streams
  -> shared strings/workbook metadata
  -> sax worksheet parser
  -> Node object-mode row stream
  -> bounded batch Transform
  -> BullMQ import-batch queue
```

Temporary file chỉ là local staging, không phải durable import storage. Xem [Excel streaming](excel-streaming.md).

## Outbox flow

```text
PostgreSQL commit
  -> outbox publisher
  -> dedicated BullMQ downstream queue
  -> duplicate-tolerant structured logger consumer
```

Downstream consumer có thể ghi log trùng lặp. Consumer không mutate business tables và không dùng Inbox hay processed-event table chỉ để deduplicate logging.

## Persistence model

- `inventory_products`: emulator state, numeric price, version và timestamps.
- `product_state`: state mới nhất đã accept theo product.
- `product_changes`: accepted history bất biến với unique `(product_id, version)`.
- `outbox_events`: events đã commit đang chờ hoặc đã publication.
- `import_jobs`: import lifecycle và progress counters bền vững, gồm `enqueue_completed_at`.
- `import_batch_accounting`: một terminal progress delta theo `(import_id, batch_id)`.
- `polling_checkpoints`: composite `(updated_at, product_id)` cursor theo polling source.

CHECK quan trọng của `import_jobs` đảm bảo counter không âm, `rowsProcessed <= rowsRead`, và `rowsProcessed = rowsSucceeded + rowsFailed`. `COMPLETED` còn cần producer completion signal và counter equality.

## Configuration

Một typed configuration boundary validate API, database, Redis, polling, inventory seed, import, worker và outbox. Default trong `.env.example`: `PORT=3000`, `DATABASE_HOST=localhost`, `DATABASE_PORT=5432`, `DATABASE_NAME=cdms`, `DATABASE_USER=cdms`, `DATABASE_PASSWORD=cdms_demo_password`, `REDIS_HOST=localhost`, `REDIS_PORT=6379`, `POLL_INTERVAL_MS=5000`, seed 1000, import batch 500, pending batch limit 100, file limit 100 MB, Redis enqueue retry timeout 30000 ms, worker concurrency 10, outbox batch 100 và interval 1000 ms. Password là demo-only local value.
