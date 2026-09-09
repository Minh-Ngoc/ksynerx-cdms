# ADR-002: PostgreSQL Schema và TypeORM Migrations

## Status
Accepted

## Context

Business correctness, import lifecycle bền vững và inventory emulator cần relational constraint và schema evolution rõ ràng.

## Decision

Dùng PostgreSQL với TypeORM entities và migrations. Tắt `synchronize`. Database enforce unique và progress invariants.

## Consequences

Mỗi environment cần chạy migration, nhưng constraint vẫn là authority khi worker race hoặc retry.

## Alternatives Considered

Runtime synchronization và correctness store không phải relational bị reject.
