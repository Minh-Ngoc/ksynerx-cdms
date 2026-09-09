# CDMS End-User and Reviewer Usage Guide

This guide is the practical runbook for exercising the finished CDMS prototype. It covers a clean local setup, the three ingestion paths, progress observation, failure scenarios, database verification, automated tests, concurrency proof, and the local k6 spike proof.

The examples use http://localhost:3000, the demo PostgreSQL credentials from .env.example, and a shell with curl. HTTP 202 ACCEPTED means that the request was accepted for asynchronous enqueue. It does not mean that the worker has already committed the business change to PostgreSQL.

## 1. Prerequisites

Install or make available:

- Node.js 24 or a compatible current Node runtime.
- pnpm 12.3.4.
- Docker Desktop or another Docker Compose implementation.
- curl for the HTTP examples.
- k6 only for the optional spike proof.

Confirm the tools:

~~~bash
node --version
pnpm --version
docker compose version
curl --version
k6 version
~~~

Expect pnpm --version to print 12.3.4. Corepack is only an optional bootstrap when pnpm is not available on PATH:

~~~bash
corepack enable
corepack prepare pnpm@12.3.4 --activate
pnpm --version
~~~

After this bootstrap, continue using direct pnpm commands.

The k6 command is optional for normal API and integration review. The repository uses one NestJS project and two runtime roles: the API process and the worker process.

## 2. Start the project

### Option A: Docker Compose

From the repository root:

~~~bash
pnpm install
docker compose up --build -d
pnpm migration:run
~~~

Compose starts:

- cdms: HTTP API, scheduled polling, upload ingestion, SSE, and health checks.
- worker: change consumers, import-batch consumers, outbox publication, and downstream logging.
- postgres: PostgreSQL 16 on host port 5432 by default.
- redis: Redis 7 on host port 6379 by default.

The API is available at http://localhost:3000. Migrations are intentionally a separate command; docker compose up --build does not change the database schema automatically.

To follow the application logs:

~~~bash
docker compose logs -f cdms worker
~~~

### Option B: local API and worker processes

Use this when you want the TypeScript application processes visible in separate terminals:

~~~bash
pnpm install
cp .env.example .env
docker compose up -d postgres redis
pnpm build
pnpm migration:run
~~~

Then use two terminals from the repository root:

~~~bash
pnpm start:prod
~~~

~~~bash
pnpm start:worker
~~~

For development with automatic recompilation, the API terminal can use pnpm start:dev; the worker still needs to be running separately. The .env.example values target PostgreSQL and Redis on localhost.

### Configuration that affects the walkthrough

The validated defaults are:

| Variable | Default | Purpose |
| --- | ---: | --- |
| PORT | 3000 | HTTP port |
| POLL_INTERVAL_MS | 5000 | Inventory polling interval |
| INVENTORY_SEED_COUNT | 1000 | Seed count when inventory is empty |
| IMPORT_BATCH_SIZE | 500 | Rows per import batch |
| IMPORT_MAX_PENDING_BATCHES | 100 | Import backpressure bound |
| IMPORT_MAX_FILE_SIZE_MB | 100 | Streaming upload size limit |
| IMPORT_REDIS_RETRY_TIMEOUT_MS | 30000 | Bounded Redis enqueue retry timeout |
| CHANGE_WORKER_CONCURRENCY | 10 | Change worker concurrency |
| OUTBOX_BATCH_SIZE | 100 | Outbox publisher batch size |
| OUTBOX_POLL_INTERVAL_MS | 1000 | Outbox polling interval |

Use unique product IDs such as review-20260909-001 during manual review. The API seeds inventory only when the inventory table is empty, so a fresh database may also contain the configured seed products.

## 3. Demo dataset

The repository includes a deterministic product/inventory demo scenario for reviewers. It uses `@faker-js/faker` with seed `20260910` by default and scopes generated identifiers to `demo-`/`DEMO-`.

Run it after PostgreSQL and Redis are healthy and migrations are applied:

```bash
pnpm demo:seed
pnpm demo:verify
pnpm demo:clean
```

`demo:seed` starts a temporary API and worker context, keeps the regular startup seed at zero, creates 50 source inventory rows, polls 15 of them through versions 1 to 3 using the real checkpoint and BullMQ path, sends 10 webhook products with ordered version, duplicate, stale, and same-version conflict deliveries, and uploads two XLSX workbooks through the production streaming import endpoint. One workbook has 11 valid rows; the other has 8 valid rows and 2 malformed rows. The runner waits for queue and outbox drain using durable queue state before reporting counts.

The scenario replays `demo-poll-015` through Polling, Webhook, and Excel with the same canonical `productId`/`version`/payload. Since `source` is delivery metadata and is excluded from the canonical fingerprint, the cross-source replay is a duplicate and does not create a second history row.

The default local result is approximately 50 source inventory rows, 38 product states, 54 accepted history rows, 54 outbox rows, and 2 completed imports. Use `DEMO_SEED=<integer>` for another deterministic Faker dataset. `demo:clean` removes only `demo-` source/business/import rows and demo queue jobs; it does not truncate shared tables or touch unrelated data.

Reviewer SQL:

```sql
SELECT product_id, version, count(*)
FROM product_changes
WHERE product_id LIKE 'demo-%'
GROUP BY product_id, version
HAVING count(*) > 1;

SELECT s.product_id, s.version AS state_version, max(c.version) AS max_history_version
FROM product_state s
JOIN product_changes c ON c.product_id = s.product_id
WHERE s.product_id LIKE 'demo-%'
GROUP BY s.product_id, s.version
HAVING s.version <> max(c.version);

SELECT filename, status, rows_read, rows_processed, rows_succeeded, rows_failed
FROM import_jobs
WHERE filename LIKE 'demo-%'
ORDER BY created_at;
```

## 4. Health check

~~~bash
curl -i http://localhost:3000/health
~~~

With PostgreSQL and Redis available, expect HTTP 200 and a response like:

~~~json
{"status":"ok","dependencies":{"postgres":"up","redis":"up"}}
~~~

When either dependency is unavailable, expect HTTP 503, status "error", and the affected dependency reported as "down". This endpoint is the first check after startup and after any infrastructure failure test.

## 5. Inventory API smoke test

Create a product. Save the returned id for the read and update calls:

~~~bash
curl -i -X POST http://localhost:3000/inventory/products \
  -H 'Content-Type: application/json' \
  -d '{"sku":"REVIEW-SKU-001","name":"Reviewer product","price":"10.50","quantity":4}'
~~~

The response contains id, sku, name, price, quantity, version, createdAt, and updatedAt. A newly created product starts at version 1.

Read the collection and one product:

~~~bash
curl -s http://localhost:3000/inventory/products
curl -s http://localhost:3000/inventory/products/<product-id>
~~~

Update any subset of the mutable fields. At least one field is required:

~~~bash
curl -i -X PATCH http://localhost:3000/inventory/products/<product-id> \
  -H 'Content-Type: application/json' \
  -d '{"price":"11.25","quantity":7}'
~~~

The update increments the product version. A nonexistent product returns 404; invalid prices, negative quantities, or an empty patch return 400.

## 6. Scheduled polling scenario

Polling reads the inventory table on the configured interval and submits normalized changes with source POLLING.

1. Create a product with the inventory API and note its id.
2. Wait longer than POLL_INTERVAL_MS (the default is at least five seconds).
3. Query product_changes using the SQL in Section 11.
4. Patch the product, wait for another polling interval, and query again.

Example update:

~~~bash
curl -s -X PATCH http://localhost:3000/inventory/products/<product-id> \
  -H 'Content-Type: application/json' \
  -d '{"quantity":8}'
~~~

The polling checkpoint is the composite (updated_at, product_id) cursor. It advances only after the complete page has been accepted by BullMQ, so a Redis enqueue failure does not silently advance the checkpoint past unaccepted work. Polling and webhook/import messages converge through the same PostgreSQL correctness rules.

## 7. Webhook scenario

Send a valid change. observedAt is optional but is included here for a reproducible example:

~~~bash
curl -i -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{
    "productId":"review-webhook-001",
    "version":1,
    "payload":{
      "sku":"REVIEW-WEBHOOK-SKU-001",
      "name":"Webhook product",
      "price":"10.00",
      "quantity":4
    },
    "observedAt":"2026-09-09T00:00:00.000Z"
  }'
~~~

Expected result: HTTP 202 and {"status":"ACCEPTED"}. The worker then applies the change asynchronously. The product ID in a webhook is the logical product key; the product does not need to exist in inventory_products first.

An invalid request is rejected before enqueue. For example, this has a missing payload.price and a non-integer quantity:

~~~bash
curl -i -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-invalid-001","version":1,"payload":{"sku":"BAD","name":"Invalid","quantity":"four"}}'
~~~

Expected result: HTTP 400. If Redis is unavailable, a structurally valid webhook cannot be enqueued and returns HTTP 503; see Section 13.

### Duplicate, stale, and same-version conflict proof

Use one new product ID and send version 5 once:

~~~bash
curl -s -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-version-001","version":5,"payload":{"sku":"REVIEW-VERSION-001","name":"Version five","price":"20.00","quantity":5}}'
~~~

Wait for the worker to drain, then send the exact same request again. The second delivery is accepted by HTTP but is classified by the worker as a duplicate and must not create another product_changes row or outbox event.

Send an older version:

~~~bash
curl -s -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-version-001","version":4,"payload":{"sku":"REVIEW-VERSION-001","name":"Older value","price":"19.00","quantity":4}}'
~~~

This is a stale delivery. It must not regress state. Finally, send version 5 with a different payload:

~~~bash
curl -s -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-version-001","version":5,"payload":{"sku":"REVIEW-VERSION-001","name":"Conflicting value","price":"99.00","quantity":99}}'
~~~

This is a same-version conflict. It must not overwrite the accepted version-5 state. The HTTP layer reports enqueue acceptance; the duplicate, stale, and conflict classifications are visible in worker logs and in the database proof queries.

## 8. Excel import

### Required workbook format

Upload an .xlsx workbook whose first worksheet has this exact header row and order:

~~~text
productId,version,sku,name,price,quantity,observedAt
~~~

Create a small workbook in a spreadsheet editor with rows like these, then save it as review-products.xlsx:

| productId | version | sku | name | price | quantity | observedAt |
| --- | ---: | --- | --- | ---: | ---: | --- |
| review-import-001 | 1 | REVIEW-IMPORT-001 | Imported one | 12.50 | 3 | 2026-09-09T00:00:00.000Z |
| review-import-002 | 1 | REVIEW-IMPORT-002 | Imported two | 15.00 | 8 | 2026-09-09T00:00:00.000Z |

The multipart field name is exactly file:

~~~bash
curl -i -X POST http://localhost:3000/imports/products \
  -F 'file=@review-products.xlsx;type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
~~~

Expected result: HTTP 202 with an importId and status PROCESSING:

~~~json
{"importId":"<import-id>","status":"PROCESSING"}
~~~

The upload is streamed through a controlled temporary file and bounded processing pipeline. The default maximum is 100 MB; the complete workbook is not buffered in RAM.

### Poll import status

~~~bash
curl -s http://localhost:3000/imports/<import-id>
~~~

The status response includes id, filename, status, rowsRead, rowsProcessed, rowsSucceeded, rowsFailed, totalRows, enqueueCompletedAt, createdAt, completedAt, and error. Terminal status is normally COMPLETED or FAILED.

### Watch progress with SSE

Open a second terminal before uploading, or reconnect after receiving the import ID:

~~~bash
curl -N http://localhost:3000/imports/<import-id>/progress
~~~

The stream sends progress, then completed or failed when terminal. The first event is rebuilt from the latest PostgreSQL snapshot; a reconnect is therefore safe for status observation. percent may be null when totalRows is not known yet. The terminal event closes the stream.

### Malformed row and file-level failure checks

For a row-level check, keep the exact valid header and add a row with an invalid decimal price, invalid integer quantity, or missing required value. For example:

| productId | version | sku | name | price | quantity | observedAt |
| --- | ---: | --- | --- | --- | ---: | --- |
| review-import-valid | 1 | REVIEW-VALID | Valid row | 12.50 | 3 | 2026-09-09T00:00:00.000Z |
| review-import-bad | 1 | REVIEW-BAD | Bad row | not-a-price | 3 | 2026-09-09T00:00:00.000Z |

Save as review-malformed-row.xlsx and upload it. The import can finish as COMPLETED with rowsFailed: 1; malformed rows are accounted for and do not silently disappear.

For a file-level parser failure, upload a non-XLSX file:

~~~bash
printf 'this is not an xlsx workbook\n' > corrupt.xlsx
curl -i -X POST http://localhost:3000/imports/products -F 'file=@corrupt.xlsx'
~~~

Expected behavior is a failed import or an immediate rejected request, depending on where parsing fails. A workbook with a missing or reordered required header is also a file-level validation failure. File-level failure does not roll back batches that were already acknowledged by Redis; inspect the import status and database rows to see the recorded boundary.

## 9. Import behavior to verify

- CREATED, UPLOADING, PROCESSING, COMPLETED, and FAILED are the import lifecycle states.
- A successful upload response means enqueue acceptance, not completed processing.
- rowsRead, rowsProcessed, rowsSucceeded, and rowsFailed are persisted counters.
- Batch accounting is idempotent by (import_id, batch_id) so a retried batch does not double-count rows.
- Redis enqueue uses bounded retry. If the timeout is reached, the import is failed rather than left indefinitely in an ambiguous state.
- Worker retries can redeliver messages; PostgreSQL version, fingerprint, locks, and unique constraints protect the business effect.

## 10. Review the outbox path

Each newly accepted logical change writes business state, change history, and a pending transactional outbox event in the same PostgreSQL transaction. The outbox publisher later sends a downstream BullMQ job. The downstream consumer is intentionally duplicate-tolerant and logs structured delivery; it does not mutate business state.

After a webhook or import has processed, use the SQL in Section 11 to verify that a logical accepted change has one state row, one history row for its version, and a corresponding outbox event. Downstream delivery duplication is allowed by this prototype, while business-state duplication is not.

## 11. Automated verification commands

Run the focused tests first when reviewing one subsystem:

~~~bash
pnpm test:integration -- polling
pnpm test:integration -- outbox
pnpm test:e2e -- imports
pnpm test:integration -- concurrency
~~~

The concurrency suite is the proof for concurrent identical deliveries, missing-row races, stale updates, same-version conflicts, and bounded worker effects. It includes the advisory-lock and database invariant coverage.

Run the complete verification set:

~~~bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
git diff --check
~~~

The integration and end-to-end suites use the configured local PostgreSQL database and reset their test data. Do not run them against a database containing data you need to preserve.

## 12. PostgreSQL verification

Connect through the Compose PostgreSQL container:

~~~bash
docker compose exec postgres psql -U cdms -d cdms
~~~

Useful queries:

~~~sql
SELECT product_id, version, fingerprint, payload, updated_at
FROM product_state
ORDER BY product_id;

SELECT product_id, version, source, payload, created_at
FROM product_changes
ORDER BY created_at, product_id, version;

SELECT product_id, version, COUNT(*)
FROM product_changes
GROUP BY product_id, version
HAVING COUNT(*) > 1;

SELECT id, aggregate_id, event_type, status, attempts, created_at, published_at, last_error
FROM outbox_events
ORDER BY created_at, id;

SELECT id, filename, status, rows_read, rows_processed, rows_succeeded, rows_failed, total_rows,
       enqueue_completed_at, created_at, completed_at, error
FROM import_jobs
ORDER BY created_at DESC;

SELECT import_id, batch_id, rows_processed, rows_succeeded, rows_failed, accounted_at
FROM import_batch_accounting
WHERE import_id = '<import-id>'
ORDER BY batch_id;

SELECT name, updated_at, product_id
FROM polling_checkpoints;
~~~

The duplicate-pair query should return no rows for a correctly processed logical version. For a successful accepted change, compare product_state, product_changes, and outbox_events by product ID and version. product_changes records the ingestion source as POLLING, WEBHOOK, or EXCEL.

## 13. Concurrency proof

The focused command is:

~~~bash
pnpm test:integration -- concurrency
~~~

The proof covers these expected outcomes:

- 100 identical first writes produce one ACCEPTED business effect and 99 duplicate classifications.
- Concurrent missing-row writes create one logical state/history effect rather than duplicate history.
- A later version is retained; an older version cannot regress it.
- Same-version different payloads are reported as conflicts and do not silently overwrite.
- Worker concurrency of eight still yields one logical effect for one logical change.

The HTTP responses in these tests represent ingress acceptance. The assertions that prove correctness are the committed PostgreSQL state, history, outbox, and unique constraints.

## 14. Failure scenarios

These checks are intended for a disposable local environment.

### Redis unavailable

~~~bash
docker compose stop redis
curl -i http://localhost:3000/health
curl -i -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-redis-down","version":1,"payload":{"sku":"REDIS-DOWN","name":"Redis down","price":"1.00","quantity":1}}'
docker compose start redis
~~~

Health should be 503, and a valid webhook should return 503 after the bounded enqueue retry behavior. Restore Redis before continuing.

### PostgreSQL unavailable

~~~bash
docker compose stop postgres
curl -i http://localhost:3000/health
docker compose start postgres
~~~

Health should be 503. Wait for the database health check and application reconnection before retrying API requests. PostgreSQL is the correctness boundary, so the service does not treat Redis acceptance as a substitute for a database commit.

### Worker restart with queued work

Submit a few valid webhook requests, then restart only the worker:

~~~bash
docker compose restart worker
~~~

Redis retains queued work during this restart. After the worker returns, query the database and confirm that each logical change has the expected single business effect. This demonstrates retry/restart handling; it is not an exactly-once delivery claim.

## 15. Local k6 spike proof

The preferred command is the repository wrapper:

~~~bash
pnpm load:spike
~~~

It requires a healthy API, worker, PostgreSQL, Redis, and an installed k6. The wrapper refuses to mix with an existing change-queue backlog, enqueues a namespaced version-2 baseline, runs duplicate-heavy and stale webhook deliveries, samples queue counts, waits for drain, and verifies database invariants. It writes reports to load-tests/results/.

Useful overrides:

~~~bash
BASE_URL=http://localhost:3000 \
UNIQUE_CHANGES=100 \
DUPLICATE_FACTOR=20 \
SPIKE_VUS=100 \
CHANGE_WORKER_CONCURRENCY=10 \
pnpm load:spike
~~~

The direct k6 script requires both BASE_URL and LOAD_RUN_ID; do not run it with bare defaults:

~~~bash
BASE_URL=http://localhost:3000 \
LOAD_RUN_ID=manual-review \
UNIQUE_CHANGES=10 \
DUPLICATE_FACTOR=5 \
SPIKE_VUS=10 \
k6 run --summary-export load-tests/results/manual-review.k6-summary.json load-tests/spike.js
~~~

Check the script without sending traffic:

~~~bash
k6 inspect \
  --env BASE_URL=http://localhost:3000 \
  --env LOAD_RUN_ID=inspect \
  --env UNIQUE_CHANGES=1 \
  --env SPIKE_VUS=1 \
  load-tests/spike.js
~~~

The spike measures HTTP-to-BullMQ acceptance latency. It is not end-to-end business-processing latency, an SLA, or a production capacity certification. The local evidence preserved for this prototype recorded 100 unique changes, duplicate factor 20, 100 VUs, worker concurrency 10, a drained queue, 100 state/history/outbox rows, no duplicate pairs, no stale regressions, and a passing proof report. Treat those numbers as developer-machine evidence only.

The preserved report is load-tests/results/run-1788887228601-1abb3b45.json. Its key values are:

| Check | Local result |
| --- | ---: |
| Baseline accepted | 100 |
| k6 webhook attempts | 4,000 |
| Total attempts including baseline | 4,100 |
| Duplicate deliveries | 2,000 |
| Stale deliveries | 2,000 |
| Accepted HTTP requests | 4,000 |
| Maximum waiting jobs | 261 |
| Maximum active jobs | 10 |
| Queue drained | true |
| p50 / p95 / p99 ingress latency | 15.9505 / 59.32085 / 473.94659 ms |
| PostgreSQL state / history / outbox rows | 100 / 100 / 100 |
| Duplicate pairs / stale regressions | 0 / 0 |
| Proof passed | true |

## 16. Expected reviewer checklist

- [ ] GET /health is HTTP 200 with PostgreSQL and Redis up.
- [ ] Inventory create, read, and patch work; patch increments version.
- [ ] Polling produces POLLING history after the configured interval.
- [ ] A valid webhook returns 202; invalid validation returns 400.
- [ ] Duplicate, stale, and same-version conflict deliveries do not corrupt state.
- [ ] XLSX upload uses field file and the exact seven-column header.
- [ ] Import status counters and SSE terminal events are observable.
- [ ] A malformed row is counted as failed; a malformed workbook fails at file level.
- [ ] PostgreSQL has one accepted business effect per logical product/version and a matching outbox event.
- [ ] Redis, PostgreSQL, and worker restart scenarios recover as documented.
- [ ] Focused tests, full tests, lint, typecheck, build, and git diff --check pass.
- [ ] The k6 wrapper, if run, reports a drained queue and passing database proof.

## 17. Cleanup and troubleshooting

Stop the Compose services without deleting local database volumes:

~~~bash
docker compose down
~~~

To remove the disposable PostgreSQL and Redis volumes as well:

~~~bash
docker compose down -v
~~~

Common checks:

- Port 3000, 5432, or 6379 is already in use: stop the conflicting process or set the corresponding host port configuration before starting Compose.
- API starts but requests fail: run curl -i http://localhost:3000/health, inspect docker compose logs cdms worker, and confirm migrations ran.
- Imports remain in PROCESSING: inspect worker logs, Redis health, GET /imports/<id>, and the import_batch_accounting rows.
- Polling appears idle: wait longer than POLL_INTERVAL_MS, confirm the API process is running, and query polling_checkpoints.
- k6 precheck refuses to run: drain unrelated queue work, confirm the worker is running, and verify k6 version.
- Database queries show no new state after HTTP 202: wait for worker processing; 202 is enqueue acceptance, not a completed transaction.

For the architectural rationale and failure boundaries, see the architecture, failure handling, Excel streaming, SSE progress, and testing documents.
