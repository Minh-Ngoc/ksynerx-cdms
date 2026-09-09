# ADR-008: Import Batch Accounting cho Progress Idempotency

## Status
Accepted

## Context

Import batch có thể replay sau progress database commit nhưng trước khi BullMQ acknowledge completion.

## Decision

Dùng `import_batch_accounting(import_id, batch_id)` với terminal delta trong atomic transaction. Marker chỉ là progress accounting, không phải Inbox và không phải business state.

## Consequences

Counter replay bị bỏ qua trong khi `rowsRead`, `rowsProcessed`, `rowsSucceeded`, `rowsFailed` vẫn được constraint. Redis chỉ nhận live mirror best-effort.

## Alternatives Considered

Chỉ dùng aggregate counters và PostgreSQL Inbox đầy đủ bị reject.
