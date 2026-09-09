# ADR-004: PostgreSQL Advisory Lock cho Product Serialization

## Status
Accepted

## Context

`SELECT FOR UPDATE` khong serialize duoc first write khi chua co row `product_state`.

## Decision

Acquire `pg_advisory_xact_lock` bang key signed 64-bit deterministic tu SHA-256 cua `productId` truoc khi doc hoac ghi state.

## Consequences

Missing-row race dung chung serialization point. Hash collision co the giam parallelism nhung khong lam hong data. Lock tu release khi transaction ket thuc.

## Alternatives Considered

Chi dung row lock, queue ordering, va Redis lock bi reject vi khong du cho correctness boundary.
