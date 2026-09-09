# ADR-003: BullMQ Before Business Processing

## Status
Accepted

## Context

Polling, webhooks, and Excel can arrive in bursts. Processing must be bounded and retryable without making the queue the correctness store.

## Decision

Normalize at ingress, enqueue to dedicated BullMQ queues, and process through the worker. PostgreSQL remains the correctness boundary.

## Consequences

Ingress can acknowledge queue ownership before business processing. Redis loss after acknowledgement remains a known limitation; database idempotency handles retries.

## Alternatives Considered

Direct database writes from ingress and replacing BullMQ with another broker were rejected.
