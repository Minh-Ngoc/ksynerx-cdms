# ADR-005: Canonical Change Processing va Version Rules

## Status
Accepted

## Context

Ba ingestion path phai cho cung business result khi product state tuong duong.

## Decision

Normalize price thanh decimal string, fingerprint cac canonical payload field, va ap dung decision table `ACCEPTED`, `DUPLICATE`, `STALE`, `VERSION_CONFLICT` trong mot transaction.

## Consequences

Delivery tuong duong giua cac source an toan. Du lieu conflict cung version duoc hien thi thay vi bi overwrite ngam.

## Alternatives Considered

Business rule rieng theo source va queue-only deduplication bi reject.
