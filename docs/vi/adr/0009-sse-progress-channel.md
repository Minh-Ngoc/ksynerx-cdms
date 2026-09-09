# ADR-009: SSE Progress Dựa Trên PostgreSQL

## Status
Accepted

## Context

Client cần xem import progress live nhưng reconnect phải khôi phục durable state hiện tại.

## Decision

Gửi PostgreSQL snapshot mới nhất trước, sau đó chỉ dùng Redis Pub/Sub làm live hint. Đóng stream khi terminal status hoặc client disconnect.

## Consequences

Redis failure có thể làm gián đoạn live view nhưng không xóa durable progress. SSE không phải durable messaging và không replay history.

## Alternatives Considered

Redis-only progress và durable event-stream subsystem bị reject.
