# ADR-009: PostgreSQL-Backed SSE Progress Channel

## Status
Accepted

## Context

Clients need live import progress while reconnects must recover the current durable state.

## Decision

Send the latest PostgreSQL snapshot first, then use Redis Pub/Sub only for live hints. Close the stream on terminal status or client disconnect.

## Consequences

Redis failure can close a live view but cannot erase durable progress. SSE is not durable messaging and does not replay history.

## Alternatives Considered

Redis-only progress and a durable event-stream subsystem were rejected.
