# Transactional Outbox

Accepted product change commit cac record sau cung nhau:

```text
product_state + product_changes + outbox_events -> mot PostgreSQL transaction
```

Dieu nay loai bo database-to-queue dual-write gap cho business changes da commit. Outbox publisher claim pending rows theo bounded batch bang `FOR UPDATE SKIP LOCKED`, publish event vao dedicated `cdms-downstream` BullMQ queue, va chi mark `PUBLISHED` sau enqueue thanh cong. Failure tang attempts, giu event pending, va luu error da sanitize.

Crash window duoc chu dong ghi ro:

```text
downstream queue publish thanh cong
-> process crash truoc PUBLISHED update
-> publisher retry committed event
```

Vi vay publication co the xay ra nhieu hon mot lan. Downstream consumer la duplicate-tolerant, khong phai strictly idempotent: consumer chi structured logging, duplicate log lines duoc chap nhan, va duplicate delivery khong mutate business state hay violate database invariants. Khong them processed-event table hay Inbox Pattern chi de deduplicate logs.

Outbox bao ve boundary PostgreSQL commit den asynchronous publication. Outbox khong dam bao exactly-once delivery va khong sua duoc catastrophic Redis loss.

## Tham khao

- [TypeORM transactions](https://typeorm.io/docs/advanced-topics/transactions/)
- [PostgreSQL row locking](https://www.postgresql.org/docs/current/explicit-locking.html)
