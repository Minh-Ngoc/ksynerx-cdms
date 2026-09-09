# ADR-004: PostgreSQL Advisory Lock for Product Serialization

## Status
Accepted

## Context

`SELECT FOR UPDATE` cannot serialize a first write when no `product_state` row exists.

## Decision

Acquire `pg_advisory_xact_lock` using a deterministic SHA-256-derived signed 64-bit key from `productId` before reading or writing state.

## Consequences

Missing-row races share the same serialization point. Hash collisions may reduce parallelism but cannot corrupt data. The lock releases at transaction end.

## Alternatives Considered

Only row locks, queue ordering, and Redis locks were rejected as incomplete correctness boundaries.
