# Testing and Evidence

The repository uses Jest with NestJS testing utilities. Tests are organized as unit, integration, e2e, concurrency, and k6 load proof layers.

## Verification layers

- Unit tests cover DTO validation, canonicalization, fingerprints, version rules, locks, queue contracts, import parsing, progress snapshots, health mapping, and service behavior.
- Integration tests use PostgreSQL and Redis where the behavior depends on transactions, advisory locks, queues, progress accounting, polling, or outbox publication.
- E2E tests cover inventory, webhook, import lifecycle/progress, and health HTTP behavior.
- Concurrency tests cover missing-row first writes, duplicate versions, version ordering, final import batches, and progress accounting.
- `load-tests/spike.js` plus `load-tests/run-spike.mjs` proves a developer-machine backlog/drain and verifies PostgreSQL invariants afterward.

## Final verified counts

At Task 24 completion:

- main Jest suite: 32 suites, 169 tests;
- integration suite: 13 suites, 58 tests;
- e2e suite: 5 suites, 16 tests.

Run the standard checks with:

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

Task 23 proved 100 identical first writes produce one `ACCEPTED` effect and 99 `DUPLICATE` outcomes, including the missing-row race. Concurrent versions 5 and 6 leave final state at 6. Same-version competing payloads produce `VERSION_CONFLICT` without last-writer-wins. Worker concurrency 8 still yields one logical database effect.

## Load evidence

The final Task 24 local spike seeded 100 namespaced version-2 changes, then sent 4,000 k6 webhook deliveries at 100 VUs with duplicate factor 20: 2,000 duplicate and 2,000 stale deliveries. All 4,000 returned `202`. Queue waiting peaked at 261, active peaked at the configured worker bound of 10, and the queue drained. PostgreSQL contained 100 `product_state`, 100 `product_changes`, and 100 outbox rows, with no duplicate versions or stale regressions. Reported p50/p95/p99 are HTTP-to-BullMQ acceptance latency, not business-processing latency. This is not a production benchmark or SLA.
