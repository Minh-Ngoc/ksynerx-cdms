# Huong dan su dung cho nguoi dung va reviewer CDMS

Tai lieu nay la runbook thuc hanh de chay va danh gia CDMS prototype da hoan thien. Tai lieu bao gom setup local sach, ba luong ingestion, theo doi progress, kich ban failure, kiem tra database, test tu dong, concurrency proof va k6 spike proof local.

Vi du su dung http://localhost:3000, demo credential PostgreSQL trong .env.example va shell co curl. HTTP 202 ACCEPTED chi co nghia request da duoc chap nhan de enqueue bat dong bo. No khong co nghia worker da commit business change vao PostgreSQL.

## 1. Yeu cau moi truong

Cai dat hoac chuan bi:

- Node.js 24 hoac Node runtime hien tai tuong thich.
- pnpm 12.3.4.
- Docker Desktop hoac Docker Compose tuong thich.
- curl cho cac vi du HTTP.
- k6 chi can cho spike proof tuy chon.

Kiem tra tool:

~~~bash
node --version
pnpm --version
docker compose version
curl --version
k6 version
~~~

Mong doi pnpm --version in ra 12.3.4. Corepack chi la bootstrap tuy chon khi pnpm khong co tren PATH:

~~~bash
corepack enable
corepack prepare pnpm@12.3.4 --activate
pnpm --version
~~~

Sau bootstrap nay, tiep tuc dung cac lenh pnpm truc tiep.

Lenh k6 khong can cho review API va integration thong thuong. Repository dung mot NestJS project va hai runtime role: API process va worker process.

## 2. Khoi dong project

### Lua chon A: Docker Compose

Chay tu repository root:

~~~bash
pnpm install
docker compose up --build -d
pnpm migration:run
~~~

Compose khoi dong:

- cdms: HTTP API, polling scheduler, upload ingestion, SSE va health checks.
- worker: change consumer, import-batch consumer, outbox publication va downstream logging.
- postgres: PostgreSQL 16, mac dinh mo host port 5432.
- redis: Redis 7, mac dinh mo host port 6379.

API tai http://localhost:3000. Migration duoc chay bang lenh rieng; docker compose up --build khong tu dong thay doi database schema.

Theo doi log ung dung:

~~~bash
docker compose logs -f cdms worker
~~~

### Lua chon B: API va worker process chay local

Dung cach nay khi can thay TypeScript application process trong hai terminal rieng:

~~~bash
pnpm install
cp .env.example .env
docker compose up -d postgres redis
pnpm build
pnpm migration:run
~~~

Sau do mo hai terminal tai repository root:

~~~bash
pnpm start:prod
~~~

~~~bash
pnpm start:worker
~~~

Khi can tu dong build lai trong development, API terminal co the dung pnpm start:dev; worker van phai chay rieng. Gia tri trong .env.example nham toi PostgreSQL va Redis tren localhost.

### Cau hinh anh huong walkthrough

Default da validate:

| Bien | Mac dinh | Muc dich |
| --- | ---: | --- |
| PORT | 3000 | HTTP port |
| POLL_INTERVAL_MS | 5000 | Khoang polling inventory |
| INVENTORY_SEED_COUNT | 1000 | So luong seed khi inventory rong |
| IMPORT_BATCH_SIZE | 500 | So row moi import batch |
| IMPORT_MAX_PENDING_BATCHES | 100 | Gioi han backpressure cua import |
| IMPORT_MAX_FILE_SIZE_MB | 100 | Gioi han kich thuoc upload streaming |
| IMPORT_REDIS_RETRY_TIMEOUT_MS | 30000 | Timeout retry enqueue Redis co gioi han |
| CHANGE_WORKER_CONCURRENCY | 10 | Concurrency cua change worker |
| OUTBOX_BATCH_SIZE | 100 | Kich thuoc batch cua outbox publisher |
| OUTBOX_POLL_INTERVAL_MS | 1000 | Khoang polling outbox |

Dung product ID rieng nhu review-20260909-001 khi review thu cong. API chi seed inventory khi bang inventory rong, vi vay database moi co the co them seed products theo cau hinh.

## 3. Health check

~~~bash
curl -i http://localhost:3000/health
~~~

Khi PostgreSQL va Redis san sang, ket qua mong doi la HTTP 200 va response tuong tu:

~~~json
{"status":"ok","dependencies":{"postgres":"up","redis":"up"}}
~~~

Khi mot dependency khong san sang, mong doi HTTP 503, status la "error", va dependency bi loi duoc bao la "down". Day la check dau tien sau startup va sau moi failure test ha tang.

## 4. Inventory API smoke test

Tao product. Luu id trong response de dung cho cac lenh doc va update:

~~~bash
curl -i -X POST http://localhost:3000/inventory/products \
  -H 'Content-Type: application/json' \
  -d '{"sku":"REVIEW-SKU-001","name":"Reviewer product","price":"10.50","quantity":4}'
~~~

Response co id, sku, name, price, quantity, version, createdAt va updatedAt. Product moi tao bat dau o version 1.

Doc collection va mot product:

~~~bash
curl -s http://localhost:3000/inventory/products
curl -s http://localhost:3000/inventory/products/<product-id>
~~~

Update mot hoac nhieu mutable field. Patch phai co it nhat mot field:

~~~bash
curl -i -X PATCH http://localhost:3000/inventory/products/<product-id> \
  -H 'Content-Type: application/json' \
  -d '{"price":"11.25","quantity":7}'
~~~

Update lam tang version cua product. Product khong ton tai tra 404; price khong hop le, quantity am, hoac patch rong tra 400.

## 5. Kich ban scheduled polling

Polling doc inventory table theo interval va submit change da normalize voi source POLLING.

1. Tao product bang inventory API va ghi lai id.
2. Cho lau hon POLL_INTERVAL_MS; default it nhat nam giay.
3. Query product_changes bang SQL o Section 11.
4. Patch product, cho them mot polling interval, sau do query lai.

Vi du update:

~~~bash
curl -s -X PATCH http://localhost:3000/inventory/products/<product-id> \
  -H 'Content-Type: application/json' \
  -d '{"quantity":8}'
~~~

Polling checkpoint la composite cursor (updated_at, product_id). Checkpoint chi advance sau khi ca page da duoc BullMQ chap nhan, vi vay Redis enqueue failure khong am tham day checkpoint qua phan work chua duoc chap nhan. Polling, webhook va import deu di qua cung mot bo quy tac correctness cua PostgreSQL.

## 6. Kich ban webhook

Gui mot change hop le. observedAt la tuy chon nhung duoc dung trong vi du de co ket qua lap lai duoc:

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

Ket qua mong doi: HTTP 202 va {"status":"ACCEPTED"}. Worker sau do xu ly change bat dong bo. Product ID trong webhook la logical product key; product khong can ton tai truoc trong inventory_products.

Request khong hop le bi reject truoc khi enqueue. Vi du nay thieu payload.price va quantity khong phai so nguyen:

~~~bash
curl -i -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-invalid-001","version":1,"payload":{"sku":"BAD","name":"Invalid","quantity":"four"}}'
~~~

Ket qua mong doi: HTTP 400. Neu Redis khong san sang, webhook dung cau truc nhung khong enqueue duoc se tra HTTP 503; xem Section 13.

### Proof duplicate, stale va conflict cung version

Dung mot product ID moi va gui version 5 mot lan:

~~~bash
curl -s -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-version-001","version":5,"payload":{"sku":"REVIEW-VERSION-001","name":"Version five","price":"20.00","quantity":5}}'
~~~

Cho worker drain, sau do gui lai dung request do. Delivery thu hai van duoc HTTP chap nhan nhung worker phan loai la duplicate va khong duoc tao them product_changes row hoac outbox event.

Gui version cu hon:

~~~bash
curl -s -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-version-001","version":4,"payload":{"sku":"REVIEW-VERSION-001","name":"Older value","price":"19.00","quantity":4}}'
~~~

Day la stale delivery. No khong duoc lam state lui. Cuoi cung gui version 5 voi payload khac:

~~~bash
curl -s -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-version-001","version":5,"payload":{"sku":"REVIEW-VERSION-001","name":"Conflicting value","price":"99.00","quantity":99}}'
~~~

Day la same-version conflict. No khong duoc ghi de state version 5 da duoc chap nhan. HTTP layer chi bao enqueue acceptance; cac phan loai duplicate, stale va conflict xuat hien trong worker logs va cac query proof database.

## 7. Excel import

### Dinh dang workbook bat buoc

Upload workbook .xlsx co worksheet dau tien voi header row va thu tu chinh xac:

~~~text
productId,version,sku,name,price,quantity,observedAt
~~~

Tao workbook nho trong spreadsheet editor voi cac row nhu sau, sau do luu thanh review-products.xlsx:

| productId | version | sku | name | price | quantity | observedAt |
| --- | ---: | --- | --- | ---: | ---: | --- |
| review-import-001 | 1 | REVIEW-IMPORT-001 | Imported one | 12.50 | 3 | 2026-09-09T00:00:00.000Z |
| review-import-002 | 1 | REVIEW-IMPORT-002 | Imported two | 15.00 | 8 | 2026-09-09T00:00:00.000Z |

Ten multipart field chinh xac la file:

~~~bash
curl -i -X POST http://localhost:3000/imports/products \
  -F 'file=@review-products.xlsx;type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
~~~

Ket qua mong doi: HTTP 202 voi importId va status PROCESSING:

~~~json
{"importId":"<import-id>","status":"PROCESSING"}
~~~

Upload duoc streaming qua controlled temporary file va bounded processing pipeline. Gioi han mac dinh la 100 MB; toan bo workbook khong duoc buffer trong RAM.

### Poll import status

~~~bash
curl -s http://localhost:3000/imports/<import-id>
~~~

Status response co id, filename, status, rowsRead, rowsProcessed, rowsSucceeded, rowsFailed, totalRows, enqueueCompletedAt, createdAt, completedAt va error. Terminal status thuong la COMPLETED hoac FAILED.

### Theo doi progress bang SSE

Mo terminal thu hai truoc khi upload, hoac reconnect sau khi nhan import ID:

~~~bash
curl -N http://localhost:3000/imports/<import-id>/progress
~~~

Stream gui progress, sau do completed hoac failed khi terminal. Event dau tien duoc dung lai tu PostgreSQL snapshot moi nhat; reconnect vi vay an toan cho viec quan sat status. percent co the la null khi chua biet totalRows. Terminal event se dong stream.

### Kiem tra malformed row va file-level failure

De kiem tra row-level, giu header hop le chinh xac va them row co decimal price khong hop le, integer quantity khong hop le, hoac required value bi thieu. Vi du:

| productId | version | sku | name | price | quantity | observedAt |
| --- | ---: | --- | --- | --- | ---: | --- |
| review-import-valid | 1 | REVIEW-VALID | Valid row | 12.50 | 3 | 2026-09-09T00:00:00.000Z |
| review-import-bad | 1 | REVIEW-BAD | Bad row | not-a-price | 3 | 2026-09-09T00:00:00.000Z |

Luu thanh review-malformed-row.xlsx va upload. Import co the ket thuc o COMPLETED voi rowsFailed: 1; malformed row duoc account va khong bien mat am tham.

De kiem tra parser failure cap file, upload file khong phai XLSX:

~~~bash
printf 'this is not an xlsx workbook\n' > corrupt.xlsx
curl -i -X POST http://localhost:3000/imports/products -F 'file=@corrupt.xlsx'
~~~

Hanh vi mong doi la import bi failed hoac request bi reject ngay, tuy parser loi o buoc nao. Workbook thieu hoac sap xep lai required header cung la file-level validation failure. File-level failure khong rollback cac batch da duoc Redis acknowledge; kiem tra import status va database rows de thay boundary da ghi nhan.

## 8. Hanh vi import can verify

- CREATED, UPLOADING, PROCESSING, COMPLETED va FAILED la cac trang thai trong lifecycle import.
- Upload response thanh cong chi la enqueue acceptance, khong phai processing da hoan tat.
- rowsRead, rowsProcessed, rowsSucceeded va rowsFailed la cac counter duoc persist.
- Batch accounting idempotent theo (import_id, batch_id), vi vay retry batch khong dem row hai lan.
- Redis enqueue dung retry co gioi han. Neu het timeout, import bi failed thay vi bi treo o trang thai mo ho.
- Worker retry co the redeliver message; version, fingerprint, lock va unique constraint PostgreSQL bao ve business effect.

## 9. Review outbox path

Moi logical change moi duoc chap nhan se ghi business state, change history va pending transactional outbox event trong cung mot PostgreSQL transaction. Outbox publisher sau do gui BullMQ job downstream. Downstream consumer duoc thiet ke duplicate-tolerant va chi ghi structured log; no khong mutate business state.

Sau khi webhook hoac import da process, dung SQL o Section 11 de verify logical change duoc chap nhan co mot state row, mot history row cho version do va outbox event tuong ung. Downstream delivery bi lap duoc chap nhan trong prototype nay, nhung business state khong duoc lap.

## 10. Lenh verification tu dong

Chay focused test truoc khi review mot subsystem:

~~~bash
pnpm test:integration -- polling
pnpm test:integration -- outbox
pnpm test:e2e -- imports
pnpm test:integration -- concurrency
~~~

Concurrency suite la proof cho identical delivery dong thoi, missing-row race, stale update, same-version conflict va bounded worker effect. Suite cung bao gom advisory-lock va database invariant coverage.

Chay day du bo verification:

~~~bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
git diff --check
~~~

Integration va end-to-end suite dung PostgreSQL local theo cau hinh va reset test data cua chung. Khong chay tren database co data can bao toan.

## 11. Kiem tra PostgreSQL

Ket noi qua PostgreSQL container cua Compose:

~~~bash
docker compose exec postgres psql -U cdms -d cdms
~~~

Cac query huu ich:

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

Query duplicate pair phai tra ve khong co row neu logical version duoc process dung. Voi accepted change thanh cong, doi chieu product_state, product_changes va outbox_events theo product ID va version. product_changes ghi source ingestion la POLLING, WEBHOOK hoac IMPORT.

## 12. Concurrency proof

Lenh focused:

~~~bash
pnpm test:integration -- concurrency
~~~

Proof bao gom cac ket qua mong doi:

- 100 first write giong nhau tao mot business effect ACCEPTED va 99 duplicate classifications.
- Concurrent missing-row write tao mot logical state/history effect thay vi history bi nhan doi.
- Version moi hon duoc giu; version cu hon khong the lam state lui.
- Payload khac nhau cung version duoc bao la conflict va khong am tham ghi de.
- Worker concurrency 8 van chi tao mot logical effect cho mot logical change.

HTTP response trong cac test nay the hien ingress acceptance. Assertion de chung minh correctness la PostgreSQL state, history, outbox da commit va unique constraint.

## 13. Failure scenarios

Cac check nay danh cho local environment co the xoa.

### Redis khong san sang

~~~bash
docker compose stop redis
curl -i http://localhost:3000/health
curl -i -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-redis-down","version":1,"payload":{"sku":"REDIS-DOWN","name":"Redis down","price":"1.00","quantity":1}}'
docker compose start redis
~~~

Health phai la 503 va webhook hop le phai tra 503 sau bounded enqueue retry. Khoi phuc Redis truoc khi tiep tuc.

### PostgreSQL khong san sang

~~~bash
docker compose stop postgres
curl -i http://localhost:3000/health
docker compose start postgres
~~~

Health phai la 503. Cho database health check va application reconnect truoc khi retry API. PostgreSQL la correctness boundary, vi vay service khong xem Redis acceptance la thay the cho database commit.

### Restart worker khi co queued work

Gui vai webhook hop le, sau do restart chi worker:

~~~bash
docker compose restart worker
~~~

Redis giu queued work trong luc worker restart. Sau khi worker tro lai, query database va xac nhan moi logical change co dung mot business effect. Day la minh chung cho retry/restart handling; khong phai tuyen bo exactly-once delivery.

## 14. Local k6 spike proof

Lenh uu tien la repository wrapper:

~~~bash
pnpm load:spike
~~~

Lenh nay can API, worker, PostgreSQL, Redis healthy va k6 da cai. Wrapper tu choi chay chung voi change-queue backlog san co, enqueue baseline version 2 co namespace, chay webhook duplicate-heavy va stale, sample queue counts, cho queue drain, sau do verify database invariants. Report duoc ghi vao load-tests/results/.

Cac override huu ich:

~~~bash
BASE_URL=http://localhost:3000 \
UNIQUE_CHANGES=100 \
DUPLICATE_FACTOR=20 \
SPIKE_VUS=100 \
CHANGE_WORKER_CONCURRENCY=10 \
pnpm load:spike
~~~

Direct k6 script bat buoc co ca BASE_URL va LOAD_RUN_ID; khong chay voi default rong:

~~~bash
BASE_URL=http://localhost:3000 \
LOAD_RUN_ID=manual-review \
UNIQUE_CHANGES=10 \
DUPLICATE_FACTOR=5 \
SPIKE_VUS=10 \
k6 run --summary-export load-tests/results/manual-review.k6-summary.json load-tests/spike.js
~~~

Kiem tra script ma khong gui traffic:

~~~bash
k6 inspect \
  --env BASE_URL=http://localhost:3000 \
  --env LOAD_RUN_ID=inspect \
  --env UNIQUE_CHANGES=1 \
  --env SPIKE_VUS=1 \
  load-tests/spike.js
~~~

Spike do HTTP-to-BullMQ acceptance latency. No khong phai end-to-end business-processing latency, SLA, hoac chung nhan capacity production. Local evidence duoc luu cho prototype nay ghi nhan 100 unique changes, duplicate factor 20, 100 VUs, worker concurrency 10, queue da drain, 100 state/history/outbox rows, khong co duplicate pair, khong co stale regression va proof report pass. Chi xem cac con so nay la developer-machine evidence.

Report duoc luu la load-tests/results/run-1788887228601-1abb3b45.json. Cac gia tri chinh:

| Kiem tra | Ket qua local |
| --- | ---: |
| Baseline accepted | 100 |
| k6 webhook attempts | 4,000 |
| Tong attempts gom baseline | 4,100 |
| Duplicate deliveries | 2,000 |
| Stale deliveries | 2,000 |
| HTTP requests duoc chap nhan | 4,000 |
| Maximum waiting jobs | 261 |
| Maximum active jobs | 10 |
| Queue da drain | true |
| p50 / p95 / p99 ingress latency | 15.9505 / 59.32085 / 473.94659 ms |
| PostgreSQL state / history / outbox rows | 100 / 100 / 100 |
| Duplicate pairs / stale regressions | 0 / 0 |
| Proof passed | true |

## 15. Checklist cho reviewer

- [ ] GET /health tra HTTP 200 voi PostgreSQL va Redis up.
- [ ] Inventory create, read va patch hoat dong; patch lam tang version.
- [ ] Polling tao history source POLLING sau configured interval.
- [ ] Webhook hop le tra 202; validation khong hop le tra 400.
- [ ] Duplicate, stale va same-version conflict khong lam hong state.
- [ ] XLSX upload dung field file va exact seven-column header.
- [ ] Import status counters va SSE terminal events quan sat duoc.
- [ ] Malformed row duoc dem la failed; malformed workbook failed o cap file.
- [ ] PostgreSQL co mot business effect cho moi logical product/version va outbox event tuong ung.
- [ ] Redis, PostgreSQL va worker restart scenario recover dung nhu tai lieu.
- [ ] Focused test, full test, lint, typecheck, build va git diff --check pass.
- [ ] Neu chay k6 wrapper, report cho thay queue da drain va database proof pass.

## 16. Cleanup va troubleshooting

Dung Compose ma khong xoa local database volume:

~~~bash
docker compose down
~~~

De xoa ca PostgreSQL va Redis volume disposable:

~~~bash
docker compose down -v
~~~

Cac check thuong gap:

- Port 3000, 5432 hoac 6379 da duoc dung: dung process trung port hoac dat host port tuong ung truoc khi start Compose.
- API start nhung request loi: chay curl -i http://localhost:3000/health, xem docker compose logs cdms worker va xac nhan migration da chay.
- Import van o PROCESSING: xem worker logs, Redis health, GET /imports/<id> va cac row trong import_batch_accounting.
- Polling co ve khong chay: cho lau hon POLL_INTERVAL_MS, xac nhan API process dang chay va query polling_checkpoints.
- k6 precheck tu choi chay: drain queue khong lien quan, xac nhan worker dang chay va kiem tra k6 version.
- Database chua co state moi sau HTTP 202: cho worker process; 202 la enqueue acceptance, khong phai transaction da hoan tat.

Xem them [architecture](architecture.md), [failure handling](failure-handling.md), [Excel streaming](excel-streaming.md), [SSE progress](sse-progress.md) va [testing](testing.md) de doc ly do kien truc va failure boundary.
