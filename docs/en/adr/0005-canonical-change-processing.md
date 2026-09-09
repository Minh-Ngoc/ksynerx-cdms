# ADR-005: Canonical Change Processing and Version Rules

## Status
Accepted

## Context

Three ingestion paths must produce the same business result for equivalent product state.

## Decision

Normalize price as a decimal string, fingerprint canonical payload fields, and apply the `ACCEPTED`, `DUPLICATE`, `STALE`, and `VERSION_CONFLICT` decision table inside one transaction.

## Consequences

Equivalent deliveries are safe across sources. Conflicting same-version data is visible instead of silently overwritten.

## Alternatives Considered

Source-specific business rules and queue-only deduplication were rejected.
