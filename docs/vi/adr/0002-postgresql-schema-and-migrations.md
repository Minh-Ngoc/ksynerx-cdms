# ADR-002: PostgreSQL Schema va TypeORM Migrations

## Status
Accepted

## Context

Business correctness, import lifecycle ben vung va inventory emulator can relational constraint va schema evolution ro rang.

## Decision

Dung PostgreSQL voi TypeORM entities va migrations. Tat `synchronize`. Database enforce unique va progress invariants.

## Consequences

Environment moi can chay migration, nhung constraint van la authority khi worker race hoac retry.

## Alternatives Considered

Runtime synchronization va correctness store khong phai relational bi reject.
