# ADR-001: Mot NestJS Project voi API va Worker Role Rieng

## Status
Accepted

## Context

Prototype can HTTP ingestion va asynchronous processing co bounded concurrency nhung khong can source split thanh microservice.

## Decision

Giu mot NestJS source project va chay `cdms`, `worker` thanh process/container role rieng tu cung image.

## Consequences

Worker restart va concurrency duoc tach khoi HTTP. Repository don gian hon, nhung cac role van chung release va source boundary.

## Alternatives Considered

Monorepo va cac microservice application rieng bi reject vi nam ngoai scope prototype.
