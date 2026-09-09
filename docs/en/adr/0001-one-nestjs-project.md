# ADR-001: One NestJS Project with Separate API and Worker Roles

## Status
Accepted

## Context

The prototype needs HTTP ingestion and bounded asynchronous processing without introducing microservice source-split overhead.

## Decision

Keep one NestJS source project and run `cdms` and `worker` as separate process/container roles from the same image.

## Consequences

Worker restart and concurrency are isolated from HTTP. The repository stays simple, but roles share release and source boundaries.

## Alternatives Considered

Monorepo and separate microservice applications were rejected as outside prototype scope.
