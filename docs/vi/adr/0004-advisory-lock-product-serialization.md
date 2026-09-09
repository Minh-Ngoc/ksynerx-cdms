# ADR-004: PostgreSQL Advisory Lock cho Product Serialization

## Status
Accepted

## Context

`SELECT FOR UPDATE` không serialize được first write khi chưa có row `product_state`.

## Decision

Acquire `pg_advisory_xact_lock` bằng key signed 64-bit deterministic từ SHA-256 của `productId` trước khi đọc hoặc ghi state.

## Consequences

Missing-row race dùng chung serialization point. Hash collision có thể giảm parallelism nhưng không làm hỏng data. Lock được release khi transaction kết thúc.

## Alternatives Considered

Chỉ dùng row lock, queue ordering, và Redis lock bị reject vì không đủ cho correctness boundary.
