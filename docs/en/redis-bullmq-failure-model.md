# Redis and BullMQ Failure Model

BullMQ provides buffering, retry/backoff, and bounded worker concurrency. It is not the correctness mechanism. PostgreSQL transactions, advisory locks, constraints, and the ChangeProcessor decision table provide business correctness.

## Acceptance boundaries

- Webhook: `202 Accepted` is returned only after BullMQ accepts the job. A pre-enqueue Redis failure returns a retriable `503`.
- Polling: the page cursor advances only after the entire page is accepted. Failure leaves the previous cursor.
- Excel: each batch enqueue is retried within `IMPORT_REDIS_RETRY_TIMEOUT_MS` (default 30000 ms). If the timeout expires, ingestion is marked `FAILED`.

If Redis fails after acceptance, workers reconnect/retry according to BullMQ behavior. A process restart does not turn a database effect into a duplicate because processing is guarded in PostgreSQL.

The change queue, import-batch queue, and downstream queue use the same repository and dedicated worker process role. Change worker concurrency is configured by `CHANGE_WORKER_CONCURRENCY` (default 10). Queue backlog is a throughput signal, not a correctness proof.

## Durable limitation

An HTTP response after enqueue acknowledges Redis/BullMQ ownership, not PostgreSQL persistence. Catastrophic Redis loss after that point can lose jobs that have not yet reached PostgreSQL. This prototype intentionally does not add an Inbox Pattern or another broker.

## References

- [NestJS queues](https://docs.nestjs.com/techniques/queues)
- [BullMQ worker concurrency](https://docs.bullmq.io/guide/workers/concurrency)
- [BullMQ retries](https://docs.bullmq.io/guide/retrying-failing-jobs)
