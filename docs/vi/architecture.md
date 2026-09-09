# Kien truc

## Luong runtime

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

Day la mot NestJS source project duy nhat. Compose dung cung built image cho hai role:

- `cdms`: HTTP controllers, inventory emulator, polling scheduler, upload ingestion, SSE va health.
- `worker`: Nest application context doc lap cho change consumer, import-batch consumer, outbox publisher va downstream consumer.
- `postgres`: source of truth ben vung.
- `redis`: BullMQ transport/retry coordination va live progress mirror.

Worker role tach process/container de gioi han concurrency va co failure isolation. Day khong phai source split thanh microservice va repository khong phai monorepo.

## Ingestion va processing

Webhook va polling payload duoc validate, normalize truoc khi vao `cdms-change`. Excel rows dung cung `ProductChangeInput`. Worker goi `ChangeProcessor`; khong dua vao BullMQ job identity de dam bao correctness.

Polling dung `ORDER BY updated_at ASC, id ASC` voi predicate `updated_at > lastUpdatedAt OR (updated_at = lastUpdatedAt AND id > lastProductId)`. Checkpoint chi duoc ghi sau khi moi row trong page da duoc BullMQ chap nhan. Re-poll duplicate duoc uu tien hon bo sot change.

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

Temporary file chi la local staging, khong phai durable import storage. Xem [Excel streaming](excel-streaming.md).

## Outbox flow

```text
PostgreSQL commit
  -> outbox publisher
  -> dedicated BullMQ downstream queue
  -> duplicate-tolerant structured logger consumer
```

Downstream consumer co the ghi log trung lap. Consumer khong mutate business tables va khong dung Inbox hay processed-event table chi de deduplicate logging.

## Persistence model

- `inventory_products`: emulator state, numeric price, version va timestamps.
- `product_state`: state moi nhat da accept theo product.
- `product_changes`: accepted history bat bien voi unique `(product_id, version)`.
- `outbox_events`: events da commit dang cho hoac da publication.
- `import_jobs`: import lifecycle va progress counters ben vung, gom `enqueue_completed_at`.
- `import_batch_accounting`: mot terminal progress delta theo `(import_id, batch_id)`.
- `polling_checkpoints`: composite `(updated_at, product_id)` cursor theo polling source.

CHECK quan trong cua `import_jobs` dam bao counter khong am, `rowsProcessed <= rowsRead`, va `rowsProcessed = rowsSucceeded + rowsFailed`. `COMPLETED` con can producer completion signal va counter equality.

## Configuration

Mot typed configuration boundary validate API, database, Redis, polling, inventory seed, import, worker va outbox. Default trong `.env.example`: `PORT=3000`, `DATABASE_HOST=localhost`, `DATABASE_PORT=5432`, `DATABASE_NAME=cdms`, `DATABASE_USER=cdms`, `DATABASE_PASSWORD=cdms_demo_password`, `REDIS_HOST=localhost`, `REDIS_PORT=6379`, `POLL_INTERVAL_MS=5000`, seed 1000, import batch 500, pending batch limit 100, file limit 100 MB, Redis enqueue retry timeout 30000 ms, worker concurrency 10, outbox batch 100 va interval 1000 ms. Password la demo-only local value.
