# Transactional Outbox

Accepted product change commit các record sau cùng nhau:

```text
product_state + product_changes + outbox_events -> mot PostgreSQL transaction
```

Điều này loại bỏ database-to-queue dual-write gap cho business changes đã commit. Outbox publisher claim pending rows theo bounded batch bằng `FOR UPDATE SKIP LOCKED`, publish event vào dedicated `cdms-downstream` BullMQ queue, và chỉ mark `PUBLISHED` sau enqueue thành công. Failure tăng attempts, giữ event pending, và lưu error đã sanitize.

Crash window được chủ động ghi rõ:

```text
downstream queue publish thanh cong
-> process crash truoc PUBLISHED update
-> publisher retry committed event
```

Vì vậy publication có thể xảy ra nhiều hơn một lần. Downstream consumer là duplicate-tolerant, không phải strictly idempotent: consumer chỉ structured logging, duplicate log lines được chấp nhận, và duplicate delivery không mutate business state hay violate database invariants. Không thêm processed-event table hay Inbox Pattern chỉ để deduplicate logs.

Outbox bảo vệ boundary PostgreSQL commit đến asynchronous publication. Outbox không đảm bảo exactly-once delivery và không sửa được catastrophic Redis loss.

## Tham khao

- [TypeORM transactions](https://typeorm.io/docs/advanced-topics/transactions/)
- [PostgreSQL row locking](https://www.postgresql.org/docs/current/explicit-locking.html)
