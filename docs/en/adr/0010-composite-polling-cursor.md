# ADR-010: Stable Composite Polling Cursor

## Status
Accepted

## Context

A timestamp-only checkpoint can skip products sharing the same update timestamp.

## Decision

Persist and query `(updated_at, product_id)` in ascending order. Advance only after the complete page is accepted by BullMQ.

## Consequences

Ties are deterministic and enqueue failures cause duplicate re-polling rather than skipped changes. The database processor absorbs those duplicates.

## Alternatives Considered

Timestamp-only checkpoints and advancing before enqueue completion were rejected.
