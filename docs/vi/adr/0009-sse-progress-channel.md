# ADR-009: SSE Progress Dua Tren PostgreSQL

## Status
Accepted

## Context

Client can xem import progress live nhung reconnect phai khoi phuc durable state hien tai.

## Decision

Gui PostgreSQL snapshot moi nhat truoc, sau do chi dung Redis Pub/Sub lam live hint. Dong stream khi terminal status hoac client disconnect.

## Consequences

Redis failure co the dong live view nhung khong xoa durable progress. SSE khong phai durable messaging va khong replay history.

## Alternatives Considered

Redis-only progress va durable event-stream subsystem bi reject.
