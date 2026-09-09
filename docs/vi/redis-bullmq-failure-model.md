# Redis va BullMQ Failure Model

BullMQ cung cap buffering, retry/backoff va bounded worker concurrency. BullMQ khong phai correctness mechanism. PostgreSQL transaction, advisory lock, constraint va ChangeProcessor decision table moi cung cap business correctness.

## Acceptance boundaries

- Webhook: chi tra `202 Accepted` sau khi BullMQ chap nhan job. Redis failure truoc enqueue tra `503` retriable.
- Polling: cursor page chi advance sau khi ca page accepted. Failure giu cursor truoc do.
- Excel: moi batch enqueue retry trong `IMPORT_REDIS_RETRY_TIMEOUT_MS` (default 30000 ms). Het timeout thi ingestion `FAILED`.

Neu Redis fail sau khi accepted, worker reconnect/retry theo BullMQ. Process restart khong bien database effect thanh duplicate vi PostgreSQL bao ve processing.

Change queue, import-batch queue va downstream queue dung cung repository va worker process rieng. Change worker concurrency dung `CHANGE_WORKER_CONCURRENCY` (default 10). Queue backlog la throughput signal, khong phai correctness proof.

## Gioi han ben vung

HTTP response sau enqueue acknowledge Redis/BullMQ ownership, khong phai PostgreSQL persistence. Mat Redis nghiem trong sau do co the lam mat job chua toi PostgreSQL. Prototype co y khong them Inbox Pattern hay broker khac.

## Tham khao

- [NestJS queues](https://docs.nestjs.com/techniques/queues)
- [BullMQ worker concurrency](https://docs.bullmq.io/guide/workers/concurrency)
- [BullMQ retries](https://docs.bullmq.io/guide/retrying-failing-jobs)
