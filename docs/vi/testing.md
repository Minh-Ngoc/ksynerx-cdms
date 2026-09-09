# Testing va Evidence

Repository dung Jest voi NestJS testing utilities. Test gom unit, integration, e2e, concurrency va k6 load proof.

## Cac layer

- Unit test DTO validation, canonicalization, fingerprint, version rules, lock, queue contracts, import parsing, progress snapshot, health mapping va service behavior.
- Integration test dung PostgreSQL va Redis khi behavior phu thuoc transaction, advisory lock, queue, progress accounting, polling hoac outbox publication.
- E2E test inventory, webhook, import lifecycle/progress va health HTTP.
- Concurrency test missing-row first write, duplicate version, version ordering, final import batch va progress accounting.
- `load-tests/spike.js` cung `load-tests/run-spike.mjs` chung minh backlog/drain tren may developer va verify PostgreSQL invariants sau do.

## So luong da verify

Tai thoi diem Task 24 hoan tat:

- main Jest suite: 32 suites, 169 tests;
- integration suite: 13 suites, 58 tests;
- e2e suite: 5 suites, 16 tests.

Chay checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
git diff --check
```

## Concurrency evidence

Task 23 verify 100 identical first writes tao mot `ACCEPTED` effect va 99 `DUPLICATE`, gom missing-row race. Concurrent version 5 va 6 de final state 6. Same-version competing payload tao `VERSION_CONFLICT`, khong last-writer-wins. Worker concurrency 8 van tao mot logical database effect.

## Load evidence

Task 24 local spike seed 100 version-2 changes co namespace rieng, sau do gui 4.000 k6 webhook deliveries tai 100 VUs voi duplicate factor 20: 2.000 duplicate va 2.000 stale. Ca 4.000 deu tra `202`. Queue waiting peak 261, active peak bang worker bound 10, va queue drain thanh cong. PostgreSQL co 100 `product_state`, 100 `product_changes`, 100 outbox rows, khong co duplicate version hoac stale regression. p50/p95/p99 la HTTP-to-BullMQ acceptance latency, khong phai business-processing latency. Day khong phai production benchmark hay SLA.
