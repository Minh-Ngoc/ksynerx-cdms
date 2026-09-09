# ADR-010: Composite Polling Cursor Ổn định

## Status
Accepted

## Context

Checkpoint chỉ có timestamp có thể bỏ qua product có cùng update timestamp.

## Decision

Persist và query `(updated_at, product_id)` theo thứ tự tăng dần. Chỉ advance sau khi cả page được BullMQ chấp nhận.

## Consequences

Tie có thứ tự deterministic và enqueue failure tạo re-poll duplicate thay vì bỏ sót change. Database processor xử lý duplicate này.

## Alternatives Considered

Timestamp-only checkpoint và advance trước enqueue completion bị reject.
