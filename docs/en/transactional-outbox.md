# Transactional Outbox

An accepted product change commits these records together:

```text
product_state + product_changes + outbox_events -> one PostgreSQL transaction
```

This removes the database-to-queue dual-write gap for committed business changes. The outbox publisher later claims pending rows in bounded batches using `FOR UPDATE SKIP LOCKED`, publishes each event to the dedicated `cdms-downstream` BullMQ queue, and marks it `PUBLISHED` only after enqueue succeeds. Failures increment attempts, retain the event as pending, and store a sanitized error.

The crash window is intentional and documented:

```text
downstream queue publish succeeds
-> process crashes before PUBLISHED update
-> publisher retries the committed event
```

Therefore publication may happen more than once. The downstream consumer is duplicate-tolerant rather than strictly idempotent: it performs structured logging only, duplicate log lines are acceptable, and duplicate delivery does not mutate business state or violate database invariants. No processed-event table or Inbox Pattern is used merely to deduplicate logs.

The outbox protects the PostgreSQL commit to asynchronous publication boundary. It does not guarantee exactly-once delivery and does not repair catastrophic Redis loss.

## References

- [TypeORM transactions](https://typeorm.io/docs/transactions/)
- [PostgreSQL row locking](https://www.postgresql.org/docs/current/explicit-locking.html)
