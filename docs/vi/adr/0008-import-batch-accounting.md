# ADR-008: Import Batch Accounting cho Progress Idempotency

## Status
Accepted

## Context

Import batch co the replay sau progress database commit nhung truoc khi BullMQ acknowledge completion.

## Decision

Dung `import_batch_accounting(import_id, batch_id)` voi terminal delta trong atomic transaction. Marker chi la progress accounting, khong phai Inbox va khong phai business state.

## Consequences

Counter replay bi bo qua trong khi `rowsRead`, `rowsProcessed`, `rowsSucceeded`, `rowsFailed` van duoc constraint. Redis chi nhan live mirror best-effort.

## Alternatives Considered

Chi dung aggregate counters va PostgreSQL Inbox day du bi reject.
