# Testing và Evidence

Repository dùng Jest với NestJS testing utilities. Test gồm unit, integration, e2e, concurrency và k6 load proof.

## Các layer

- Unit test DTO validation, canonicalization, fingerprint, version rules, lock, queue contracts, import parsing, progress snapshot, health mapping và service behavior.
- Integration test dùng PostgreSQL và Redis khi behavior phụ thuộc transaction, advisory lock, queue, progress accounting, polling hoặc outbox publication.
- E2E test inventory, webhook, import lifecycle/progress và health HTTP.
- Concurrency test missing-row first write, duplicate version, version ordering, final import batch và progress accounting.
- `load-tests/spike.js` cùng `load-tests/run-spike.mjs` chứng minh backlog/drain trên máy developer và verify PostgreSQL invariants sau đó.

## Số lượng đã verify

Tại thời điểm Task 24 hoàn tất:

- main Jest suite: 32 suites, 169 tests;
- integration suite: 13 suites, 58 tests;
- e2e suite: 5 suites, 16 tests.

Chạy checks:

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

Task 23 verify 100 identical first writes tạo một `ACCEPTED` effect và 99 `DUPLICATE`, gồm missing-row race. Concurrent version 5 và 6 để final state 6. Same-version competing payload tạo `VERSION_CONFLICT`, không last-writer-wins. Worker concurrency 8 vẫn tạo một logical database effect.

## Load evidence

Task 24 local spike seed 100 version-2 changes có namespace riêng, sau đó gửi 4.000 k6 webhook deliveries tại 100 VUs với duplicate factor 20: 2.000 duplicate và 2.000 stale. Cả 4.000 đều trả `202`. Queue waiting peak 261, active peak bằng worker bound 10, và queue drain thành công. PostgreSQL có 100 `product_state`, 100 `product_changes`, 100 outbox rows, không có duplicate version hoặc stale regression. p50/p95/p99 là HTTP-to-BullMQ acceptance latency, không phải business-processing latency. Đây không phải production benchmark hay SLA.
