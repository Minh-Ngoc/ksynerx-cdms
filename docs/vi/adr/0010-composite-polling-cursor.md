# ADR-010: Composite Polling Cursor On Dinh

## Status
Accepted

## Context

Checkpoint chi co timestamp co the bo qua product co cung update timestamp.

## Decision

Persist va query `(updated_at, product_id)` theo thu tu tang dan. Chi advance sau khi ca page duoc BullMQ chap nhan.

## Consequences

Tie co thu tu deterministic va enqueue failure tao re-poll duplicate thay vi bo sot change. Database processor xu ly duplicate nay.

## Alternatives Considered

Timestamp-only checkpoint va advance truoc enqueue completion bi reject.
