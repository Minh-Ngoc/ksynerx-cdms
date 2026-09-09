# ADR-006: Transactional Outbox

## Status
Accepted

## Context

Writing business state and publishing asynchronously as unrelated operations can lose committed events.

## Decision

Insert state, history, and `outbox_events` in the same PostgreSQL transaction. A worker publisher claims bounded pending rows, enqueues downstream, then marks published.

## Consequences

Committed events survive publisher retries. Publish-before-mark crashes can duplicate downstream delivery, so the consumer is duplicate-tolerant and logging-only.

## Alternatives Considered

Direct dual-write and a processed-event Inbox were rejected for this prototype.
