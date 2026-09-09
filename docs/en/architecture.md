# Architecture

## Runtime flow

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

There is one NestJS source project. Compose uses the same built image for two application roles:

- `cdms`: HTTP controllers, inventory emulator, scheduled polling, upload ingestion, SSE, and health.
- `worker`: standalone Nest application context for change consumers, import-batch consumers, the outbox publisher, and the downstream consumer.
- `postgres`: durable source of truth.
- `redis`: BullMQ transport/retry coordination and live progress mirror.

The worker role is a process/container separation for bounded concurrency and failure isolation. It is not a microservice source split and the repository is not a monorepo.

## Ingestion and processing

Webhook and polling payloads are validated and normalized before they enter `cdms-change`. Excel rows follow the same internal `ProductChangeInput` contract. The worker calls `ChangeProcessor`; it does not trust BullMQ job identity for correctness.

Polling uses `ORDER BY updated_at ASC, id ASC` with the cursor predicate `updated_at > lastUpdatedAt OR (updated_at = lastUpdatedAt AND id > lastProductId)`. The checkpoint is written only after every row in the fetched page has been accepted by BullMQ. Duplicate re-polling is preferred over skipping a change.

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

The temporary file is local staging, not durable import storage. See [Excel streaming](excel-streaming.md).

## Outbox flow

```text
PostgreSQL commit
  -> outbox publisher
  -> dedicated BullMQ downstream queue
  -> duplicate-tolerant structured logger consumer
```

The downstream consumer may emit duplicate log lines. It does not mutate business tables, and no Inbox or processed-event table is used merely to deduplicate logging.

## Persistence model

- `inventory_products`: emulator state, numeric price, version, and timestamps.
- `product_state`: latest accepted state per product.
- `product_changes`: immutable accepted history with unique `(product_id, version)`.
- `outbox_events`: committed events awaiting or completing downstream publication.
- `import_jobs`: durable import lifecycle and progress counters, including `enqueue_completed_at`.
- `import_batch_accounting`: one terminal progress delta per `(import_id, batch_id)`.
- `polling_checkpoints`: one composite `(updated_at, product_id)` cursor per polling source.

Important `import_jobs` checks enforce non-negative counters, `rowsProcessed <= rowsRead`, and `rowsProcessed = rowsSucceeded + rowsFailed`. `COMPLETED` additionally requires the producer completion signal and counter equality.

## Configuration

The single typed configuration boundary validates API, database, Redis, polling, inventory seed, import, worker, and outbox settings. Defaults are documented in `.env.example`: `PORT=3000`, `DATABASE_HOST=localhost`, `DATABASE_PORT=5432`, `DATABASE_NAME=cdms`, `DATABASE_USER=cdms`, `DATABASE_PASSWORD=cdms_demo_password`, `REDIS_HOST=localhost`, `REDIS_PORT=6379`, `POLL_INTERVAL_MS=5000`, seed count 1000, import batch size 500, pending batch limit 100, file limit 100 MB, Redis enqueue retry timeout 30000 ms, worker concurrency 10, outbox batch size 100, and outbox interval 1000 ms. The password is a demo-only local value.
