# ADR-006: Transactional Outbox

## Status
Accepted

## Context

Ghi business state va publish asynchronous nhu hai operation rieng co the lam mat event da commit.

## Decision

Insert state, history va `outbox_events` trong cung PostgreSQL transaction. Worker publisher claim pending row theo bounded batch, enqueue downstream, roi mark published.

## Consequences

Event da commit duoc bao ve qua retry publisher. Crash sau publish truoc mark co the tao duplicate delivery, vi vay consumer duplicate-tolerant va chi logging.

## Alternatives Considered

Direct dual-write va processed-event Inbox bi reject trong prototype nay.
