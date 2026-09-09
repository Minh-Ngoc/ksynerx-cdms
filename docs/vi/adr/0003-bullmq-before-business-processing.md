# ADR-003: BullMQ Trước Business Processing

## Status
Accepted

## Context

Polling, webhook và Excel có thể đến theo burst. Processing cần bounded và retryable nhưng queue không được là correctness store.

## Decision

Normalize ở ingress, enqueue vào BullMQ queue riêng, và process trong worker. PostgreSQL vẫn là correctness boundary.

## Consequences

Ingress có thể acknowledge queue ownership trước business processing. Mất Redis sau acknowledge là limitation đã biết; database idempotency xử lý retry.

## Alternatives Considered

Ghi database trực tiếp từ ingress và thấy BullMQ bằng broker khác bị reject.
