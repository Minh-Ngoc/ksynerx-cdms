# ADR-003: BullMQ Truoc Business Processing

## Status
Accepted

## Context

Polling, webhook va Excel co the den theo burst. Processing can bounded va retryable nhung queue khong duoc la correctness store.

## Decision

Normalize o ingress, enqueue vao BullMQ queue rieng, va process trong worker. PostgreSQL van la correctness boundary.

## Consequences

Ingress co the acknowledge queue ownership truoc business processing. Mat Redis sau acknowledge la limitation da biet; database idempotency xu ly retry.

## Alternatives Considered

Ghi database truc tiep tu ingress va thay BullMQ bang broker khac bi reject.
