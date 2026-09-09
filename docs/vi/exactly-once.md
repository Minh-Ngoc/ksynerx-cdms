# Exactly-Once Effect

Prototype này cùng cấp exactly-once effect ở PostgreSQL/business level. Hệ thống không cùng cấp exactly-once message delivery. BullMQ retry và duplicate delivery là input dự kiến.

## Decision table

| Input | State hiện tại | Result | Database effect |
|---|---|---|---|
| version thấp hơn | version mới hơn đã tồn tại | `STALE` | không ghi |
| cùng version, fingerprint canonical giống hệt | cùng state | `DUPLICATE` | không ghi |
| cùng version, fingerprint khác | cùng state | `VERSION_CONFLICT` | không overwrite |
| version mới hơn hoặc chưa có state | absent/older | `ACCEPTED` | ghi history, state và outbox |

Fingerprint chỉ dùng canonical payload. Price là decimal string đã normalize tương thích PostgreSQL `NUMERIC(18,2)` và thứ tự key JSON được cố định. Delivery metadata như source và observed time không tạo same-version conflict giả.

## Serialization và transaction

Mỗi product được serialize bằng `pg_advisory_xact_lock`, acquire qua TypeORM manager gắn với transaction trước khi đọc `product_state`. Key là 8 bytes đầu của SHA-256 trên product ID UTF-8 đã trim, diễn giải thành signed PostgreSQL `bigint`. Key deterministic giữa process và restart. Collision 64-bit có thể serialize product không liên quan, nhưng không làm hỏng data vì lock chỉ thêm ordering.

Lock bao phủ missing-row và existing-row race. Unique `(product_id, version)` vẫn là database invariant phòng vệ. Accepted change insert `product_changes`, upsert `product_state`, và insert `outbox_events` trong một PostgreSQL transaction.

## Progress là một vẫn để riêng

Business idempotency dùng product/version/fingerprint trong `ChangeProcessor`. Import progress idempotency dùng `importId + batchId` trong `import_batch_accounting`. Chỉ dùng aggregate counters không thể nhận diện replay sau khi PostgreSQL commit nhưng trước khi BullMQ acknowledge job. Accounting table chỉ lưu terminal progress delta; đây không phải PostgreSQL Inbox Pattern và không lưu message payload hay business state.

Uploader sở hữu `rowsRead`. Batch worker sở hữu terminal `rowsProcessed`, `rowsSucceeded`, `rowsFailed`. PostgreSQL giữ `rowsProcessed = rowsSucceeded + rowsFailed` và `rowsProcessed <= rowsRead`. Completion cần `enqueue_completed_at IS NOT NULL` và `rowsProcessed = rowsRead`.

## Evidence

Task 23 verify 100 identical first writes tạo một accepted effect và 99 duplicate outcomes, gồm missing-row race. Concurrent version 5 và 6 để lại final state version 6. Same-version competing payload tạo `VERSION_CONFLICT`, không last-writer-wins. Worker concurrency 8 vẫn cho một logical database effect trong integration proof. Các test này xác nhận invariant ở concurrency đã test, không chứng nhận infinite-scale correctness.
