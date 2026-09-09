# ADR-002: PostgreSQL Schema and TypeORM Migrations

## Status
Accepted

## Context

Business correctness, durable import lifecycle, and the inventory emulator need relational constraints and explicit schema evolution.

## Decision

Use PostgreSQL with TypeORM entities and migrations. Disable `synchronize`. Enforce unique and progress invariants in the database.

## Consequences

Fresh environments need migrations, but constraints remain authoritative even when workers race or retry.

## Alternatives Considered

Runtime synchronization and a non-relational correctness store were rejected.
