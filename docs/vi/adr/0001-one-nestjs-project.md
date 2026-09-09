# ADR-001: Một NestJS Project với API và Worker Role Riêng

## Status
Accepted

## Context

Prototype cần HTTP ingestion và asynchronous processing có bounded concurrency nhưng không cần source split thành microservice.

## Decision

Giữ một NestJS source project và chạy `cdms`, `worker` thành process/container role riêng từ cùng image.

## Consequences

Worker restart và concurrency được tách khỏi HTTP. Repository đơn giản hơn, nhưng các role vẫn chung release và source boundary.

## Alternatives Considered

Monorepo và các microservice application riêng bị reject vì nằm ngoài scope prototype.
