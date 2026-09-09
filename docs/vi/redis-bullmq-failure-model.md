# Redis và BullMQ Failure Model

BullMQ cùng cấp buffering, retry/backoff và bounded worker concurrency. BullMQ không phải correctness mechanism. PostgreSQL transaction, advisory lock, constraint và ChangeProcessor decision table đều cùng cấp business correctness.

## Acceptance boundaries

- Webhook: chỉ trả `202 Accepted` sau khi BullMQ chấp nhận job. Redis failure trước enqueue trả `503` retriable.
- Polling: cursor page chỉ advance sau khi cả page accepted. Failure giữ cursor trước đó.
- Excel: mỗi batch enqueue retry trong `IMPORT_REDIS_RETRY_TIMEOUT_MS` (default 30000 ms). Hết timeout thì ingestion `FAILED`.

Nếu Redis fail sau khi accepted, worker reconnect/retry theo BullMQ. Process restart không biến database effect thành duplicate vì PostgreSQL bảo vệ processing.

Change queue, import-batch queue và downstream queue dùng cùng repository và worker process riêng. Change worker concurrency dùng `CHANGE_WORKER_CONCURRENCY` (default 10). Queue backlog là throughput signal, không phải correctness proof.

## Giới hạn bền vững

HTTP response sau enqueue acknowledge Redis/BullMQ ownership, không phải PostgreSQL persistence. Mất Redis nghiêm trọng sau đó có thể làm mất job chưa tới PostgreSQL. Prototype cố ý không thêm Inbox Pattern hay broker khác.

## Tham khao

- [NestJS queues](https://docs.nestjs.com/techniques/queues)
- [BullMQ worker concurrency](https://docs.bullmq.io/guide/workers/concurrency)
- [BullMQ retries](https://docs.bullmq.io/guide/retrying-failing-jobs)
