# ADR-006: Transactional Outbox

## Status
Accepted

## Context

Ghi business state và publish asynchronous như hai operation riêng có thể làm mất event đã commit.

## Decision

Insert state, history và `outbox_events` trong cùng PostgreSQL transaction. Worker publisher claim pending row theo bounded batch, enqueue downstream, rồi mark published.

## Consequences

Event đã commit được bảo vệ qua retry publisher. Crash sau publish trước mark có thể tạo duplicate delivery, vì vậy consumer duplicate-tolerant và chỉ logging.

## Alternatives Considered

Direct dual-write và processed-event Inbox bị reject trong prototype này.
