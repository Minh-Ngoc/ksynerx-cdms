# ADR-005: Canonical Change Processing và Version Rules

## Status
Accepted

## Context

Ba ingestion path phải cho cùng business result khi product state tương đương.

## Decision

Normalize price thành decimal string, fingerprint các canonical payload field, và áp dụng decision table `ACCEPTED`, `DUPLICATE`, `STALE`, `VERSION_CONFLICT` trong một transaction.

## Consequences

Delivery tương đương giữa các source an toàn. Dữ liệu conflict cùng version được hiển thị thay vì bị overwrite ngầm.

## Alternatives Considered

Business rule riêng theo source và queue-only deduplication bị reject.
