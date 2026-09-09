# Failure Handling

## Ingestion

- Webhook validation failure returns `400`. Redis/BullMQ failure before `queue.add()` returns `503`; the webhook makes no business database write.
- Polling writes its composite checkpoint only after the complete page is enqueued. Enqueue or checkpoint failure leaves the old checkpoint. Already-enqueued rows may be re-polled, which is safe because processing is idempotent.
- Excel upload failures during multipart reading, file-size enforcement, workbook parsing, or bounded Redis retry mark the import `FAILED`. Batches already accepted by BullMQ are not rolled back; `FAILED` means ingestion could not reach normal terminal processing.

## Worker and database

- A database failure before commit rolls back the transaction and BullMQ retries the job.
- A worker crash before commit produces no partial accepted change.
- A worker crash after commit can cause a duplicate job attempt; PostgreSQL returns `DUPLICATE` or `STALE` without a second history row.
- Unexpected import row failures are retried until the final BullMQ attempt. At the final attempt, that row contributes to `rowsFailed` and other rows can still reach terminal outcomes.

## Outbox

The publisher claims a bounded batch with `FOR UPDATE SKIP LOCKED`. It keeps an event pending when downstream enqueue fails and records attempts/error text. If downstream enqueue succeeds but the `PUBLISHED` update fails, the event is published again later. The downstream consumer is duplicate-tolerant: duplicate logs are acceptable and no business table is changed.

## Progress and health

PostgreSQL is authoritative for import lifecycle and counters. Redis Pub/Sub and the Redis snapshot are best-effort live coordination. A Redis Pub/Sub failure closes that live SSE view; reconnecting loads the current PostgreSQL snapshot. `GET /health` probes PostgreSQL and Redis independently and returns `503` if either required dependency is down. The one-second health timeout bounds the HTTP probe but does not cancel a PostgreSQL query already in progress.

## Known limits

Catastrophic Redis data loss after an acknowledged enqueue can lose queued work not yet persisted to PostgreSQL. The prototype does not implement a PostgreSQL Inbox Pattern. Temporary Excel staging uses local disk, and the parser supports only the required XLSX subset.
