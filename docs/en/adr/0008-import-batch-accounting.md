# ADR-008: Import Batch Accounting for Progress Idempotency

## Status
Accepted

## Context

An import batch can replay after its database progress commit but before BullMQ acknowledges completion.

## Decision

Use `import_batch_accounting(import_id, batch_id)` with an atomic terminal delta transaction. The marker is progress accounting only, not an Inbox and not business state.

## Consequences

Counter replays are ignored while `rowsRead`, `rowsProcessed`, `rowsSucceeded`, and `rowsFailed` remain constrained. Redis receives only a best-effort live mirror.

## Alternatives Considered

Aggregate-only counters and a full PostgreSQL Inbox were rejected.
