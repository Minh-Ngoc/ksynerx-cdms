# Hướng dẫn sử dụng cho người dùng và reviewer CDMS

Tài liệu này là runbook thực hành để chạy và đánh giá CDMS prototype đã hoàn thiện. Tài liệu bao gồm setup local sạch, ba luồng ingestion, theo dõi progress, kịch bản failure, kiểm tra database, test tự động, concurrency proof và k6 spike proof local.

Ví dụ sử dụng http://localhost:3000, demo credential PostgreSQL trong .env.example và shell có curl. HTTP 202 ACCEPTED chỉ có nghĩa request đã được chấp nhận để enqueue bất đồng bộ. Nó không có nghĩa worker đã commit business change vào PostgreSQL.

## 1. Yêu cầu môi trường

Cài đặt hoặc chuẩn bị:

- Node.js 24 hoặc Node runtime hiện tại tương thích.
- pnpm 12.3.4.
- Docker Desktop hoặc Docker Compose tương thích.
- curl cho các ví dụ HTTP.
- k6 chỉ cần cho spike proof tùy chọn.

Kiểm tra tool:

~~~bash
node --version
pnpm --version
docker compose version
curl --version
k6 version
~~~

Mong đợi `pnpm --version` in ra `12.3.4`. Corepack chỉ là bootstrap tùy chọn khi pnpm không có trên `PATH`:

~~~bash
corepack enable
corepack prepare pnpm@12.3.4 --activate
pnpm --version
~~~

Sau bootstrap này, tiếp tục dùng các lệnh pnpm trực tiếp.

Lệnh k6 không cần cho review API và integration thông thường. Repository dùng một NestJS project và hai runtime role: API process và worker process.

## 2. Khởi động project

### Lựa chọn A: Docker Compose

Chạy từ repository root:

~~~bash
pnpm install
docker compose up --build -d
pnpm migration:run
~~~

Compose khởi động:

- cdms: HTTP API, polling scheduler, upload ingestion, SSE và health checks.
- worker: change consumer, import-batch consumer, outbox publication và downstream logging.
- postgres: PostgreSQL 16, mặc định mở host port 5432.
- redis: Redis 7, mặc định mở host port 6379.

API tại http://localhost:3000. Migration được chạy bằng lệnh riêng; docker compose up --build không tự động thay đổi database schema.

Theo dõi log ứng dụng:

~~~bash
docker compose logs -f cdms worker
~~~

### Lựa chọn B: API và worker process chạy local

Dùng cách này khi cần thấy TypeScript application process trong hai terminal riêng:

~~~bash
pnpm install
cp .env.example .env
docker compose up -d postgres redis
pnpm build
pnpm migration:run
~~~

Sau đó mở hai terminal tại repository root:

~~~bash
pnpm start:prod
~~~

~~~bash
pnpm start:worker
~~~

Khi cần tự động build lại trong development, API terminal có thể dùng `pnpm start:dev`; worker vẫn phải chạy riêng. Giá trị trong `.env.example` nhằm tới PostgreSQL và Redis trên localhost.

### Cấu hình cho walkthrough

Default đã validate:

| Biến | Mặc định | Mục đích |
| --- | ---: | --- |
| PORT | 3000 | HTTP port |
| POLL_INTERVAL_MS | 5000 | Khoảng polling inventory |
| INVENTORY_SEED_COUNT | 1000 | Số lượng seed khi inventory rỗng |
| IMPORT_BATCH_SIZE | 500 | Số row mỗi import batch |
| IMPORT_MAX_PENDING_BATCHES | 100 | Giới hạn backpressure của import |
| IMPORT_MAX_FILE_SIZE_MB | 100 | Giới hạn kích thước upload streaming |
| IMPORT_REDIS_RETRY_TIMEOUT_MS | 30000 | Timeout retry enqueue Redis có giới hạn |
| CHANGE_WORKER_CONCURRENCY | 10 | Concurrency của change worker |
| OUTBOX_BATCH_SIZE | 100 | Kích thước batch của outbox publisher |
| OUTBOX_POLL_INTERVAL_MS | 1000 | Khoảng polling outbox |

Dùng product ID riêng như `review-20260909-001` khi review thủ công. API chỉ seed inventory khi bảng inventory rỗng, vì vậy database mới có thể có thêm seed products theo cấu hình.

## 3. Dữ liệu demo

Repository có một scenario demo deterministic trong domain product/inventory để reviewer sử dụng. Scenario dùng `@faker-js/faker` với seed mặc định `20260910` và giới hạn identifier sinh ra trong namespace `demo-`/`DEMO-`.

Chạy sau khi PostgreSQL và Redis healthy, đồng thời migration đã được apply:

```bash
pnpm demo:seed
pnpm demo:verify
pnpm demo:clean
```

`demo:seed` khởi động tạm thời API và worker context, giữ startup seed thông thường ở mức zero, tạo 50 source inventory row, đưa 15 row qua polling ở version 1 đến 3 bằng checkpoint và BullMQ path thật, gửi 10 webhook product với version có thứ tự cùng delivery duplicate, stale và conflict cùng version, rồi upload hai workbook XLSX qua production streaming import endpoint. Một workbook có 11 row hợp lệ; workbook còn lại có 8 row hợp lệ và 2 row malformed. Runner chờ queue và outbox drain bằng durable queue state trước khi in count.

Scenario replay `demo-poll-015` qua Polling, Webhook và Excel với cùng canonical `productId`/`version`/payload. Vì `source` là delivery metadata và bị loại khỏi canonical fingerprint, cross-source replay là duplicate và không tạo history row thứ hai.

Kết quả local mặc định xấp xỉ 50 source inventory row, 38 product state, 54 history row được accept, 54 outbox row và 2 import hoàn tất. Dùng `DEMO_SEED=<integer>` để tạo dataset Faker deterministic khác. `demo:clean` chỉ xóa source/business/import row và demo queue job có namespace `demo-`; không truncate table dùng chung hoặc chạm dữ liệu không liên quan.

SQL cho reviewer:

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

Khi PostgreSQL và Redis sẵn sàng, kết quả mong đợi là HTTP 200 và response tương tự:

~~~json
{"status":"ok","dependencies":{"postgres":"up","redis":"up"}}
~~~

Khi một dependency không sẵn sàng, mong đợi HTTP 503, status là "error", và dependency bị lỗi được báo là "down". Đây là check đầu tiên sau startup và sau mỗi failure test hạ tầng.

## 5. Inventory API smoke test

Tạo product. Lưu id trong response để dùng cho các lệnh đọc và update:

~~~bash
curl -i -X POST http://localhost:3000/inventory/products \
  -H 'Content-Type: application/json' \
  -d '{"sku":"REVIEW-SKU-001","name":"Reviewer product","price":"10.50","quantity":4}'
~~~

Response có id, sku, name, price, quantity, version, createdAt và updatedAt. Product mới tạo bắt đầu ở version 1.

Đọc collection và một product:

~~~bash
curl -s http://localhost:3000/inventory/products
curl -s http://localhost:3000/inventory/products/<product-id>
~~~

Update một hoặc nhiều mutable field. Patch phải có ít nhất một field:

~~~bash
curl -i -X PATCH http://localhost:3000/inventory/products/<product-id> \
  -H 'Content-Type: application/json' \
  -d '{"price":"11.25","quantity":7}'
~~~

Update làm tăng version của product. Product không tồn tại trả 404; price không hợp lệ, quantity âm, hoặc patch rỗng trả 400.

## 6. Kịch bản scheduled polling

Polling đọc inventory table theo interval và submit change đã normalize với source POLLING.

1. Tạo product bằng inventory API và ghi lại id.
2. Chờ lâu hơn `POLL_INTERVAL_MS`; default ít nhất năm giây.
3. Query product_changes bằng SQL ở Section 11.
4. Patch product, cho thêm một polling interval, sau đó query lại.

Ví dụ update:

~~~bash
curl -s -X PATCH http://localhost:3000/inventory/products/<product-id> \
  -H 'Content-Type: application/json' \
  -d '{"quantity":8}'
~~~

Polling checkpoint là composite cursor (updated_at, product_id). Checkpoint chỉ advance sau khi cả page đã được BullMQ chấp nhận, vì vậy Redis enqueue failure không âm thầm đẩy checkpoint qua phần work chưa được chấp nhận. Polling, webhook và import đều đi qua cùng một bộ quy tắc correctness của PostgreSQL.

## 7. Kịch bản webhook

Gửi một change hợp lệ. `observedAt` là tùy chọn nhưng được dùng trong ví dụ để có kết quả lặp lại được:

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

Kết quả mong đợi: HTTP 202 và {"status":"ACCEPTED"}. Worker sau đó xử lý change bất đồng bộ. Product ID trong webhook là logical product key; product không cần tồn tại trước trong inventory_products.

Request không hợp lệ bị reject trước khi enqueue. Ví dụ này thiếu payload.price và quantity không phải số nguyên:

~~~bash
curl -i -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-invalid-001","version":1,"payload":{"sku":"BAD","name":"Invalid","quantity":"four"}}'
~~~

Kết quả mong đợi: HTTP 400. Nếu Redis không sẵn sàng, webhook đúng cấu trúc nhưng không enqueue được sẽ trả HTTP 503; xem Section 13.

### Proof duplicate, stale và conflict cùng version

Dùng một product ID duy nhất và gửi version 5 một lần:

~~~bash
curl -s -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-version-001","version":5,"payload":{"sku":"REVIEW-VERSION-001","name":"Version five","price":"20.00","quantity":5}}'
~~~

Chờ worker drain, sau đó gửi lại đúng request đó. Delivery thứ hai vẫn được HTTP chấp nhận nhưng worker phân loại là duplicate và không được tạo thêm product_changes row hoặc outbox event.

Gửi version cũ hơn:

~~~bash
curl -s -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-version-001","version":4,"payload":{"sku":"REVIEW-VERSION-001","name":"Older value","price":"19.00","quantity":4}}'
~~~

Đây là stale delivery. Nó không được làm state lùi. Cuối cùng gửi version 5 với payload khác:

~~~bash
curl -s -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-version-001","version":5,"payload":{"sku":"REVIEW-VERSION-001","name":"Conflicting value","price":"99.00","quantity":99}}'
~~~

Đây là same-version conflict. Nó không được ghi đè state version 5 đã được chấp nhận. HTTP layer chỉ báo enqueue acceptance; các phân loại duplicate, stale và conflict xuất hiện trong worker logs và các query proof database.

## 8. Excel import

### Định dạng workbook bắt buộc

Upload workbook `.xlsx` có worksheet đầu tiên với header row và thứ tự chính xác:

~~~text
productId,version,sku,name,price,quantity,observedAt
~~~

Tạo workbook nhỏ trong spreadsheet editor với các row như sau, sau đó lưu thành review-products.xlsx:

| productId | version | sku | name | price | quantity | observedAt |
| --- | ---: | --- | --- | ---: | ---: | --- |
| review-import-001 | 1 | REVIEW-IMPORT-001 | Imported one | 12.50 | 3 | 2026-09-09T00:00:00.000Z |
| review-import-002 | 1 | REVIEW-IMPORT-002 | Imported two | 15.00 | 8 | 2026-09-09T00:00:00.000Z |

Tên multipart field chính xác là `file`:

~~~bash
curl -i -X POST http://localhost:3000/imports/products \
  -F 'file=@review-products.xlsx;type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
~~~

Kết quả mong đợi: HTTP 202 với importId và status PROCESSING:

~~~json
{"importId":"<import-id>","status":"PROCESSING"}
~~~

Upload được streaming qua controlled temporary file và bounded processing pipeline. Giới hạn mặc định là 100 MB; toàn bộ workbook không được buffer trong RAM.

### Poll import status

~~~bash
curl -s http://localhost:3000/imports/<import-id>
~~~

Status response có id, filename, status, rowsRead, rowsProcessed, rowsSucceeded, rowsFailed, totalRows, enqueueCompletedAt, createdAt, completedAt và error. Terminal status thường là COMPLETED hoặc FAILED.

### Theo dõi progress bằng SSE

Mở terminal thứ hai trước khi upload, hoặc reconnect sau khi nhận import ID:

~~~bash
curl -N http://localhost:3000/imports/<import-id>/progress
~~~

Stream gửi progress, sau đó completed hoặc failed khi terminal. Event đầu tiên được dùng lại từ PostgreSQL snapshot mới nhất; reconnect vì vậy an toàn cho việc quan sát status. percent có thể là null khi chưa biết totalRows. Terminal event sẽ đóng stream.

### Kiểm tra malformed row và file-level failure

Để kiểm tra row-level, giữ header hợp lệ chính xác và thêm row có decimal price không hợp lệ, integer quantity không hợp lệ, hoặc required value bị thiếu. Ví dụ:

| productId | version | sku | name | price | quantity | observedAt |
| --- | ---: | --- | --- | --- | ---: | --- |
| review-import-valid | 1 | REVIEW-VALID | Valid row | 12.50 | 3 | 2026-09-09T00:00:00.000Z |
| review-import-bad | 1 | REVIEW-BAD | Bad row | not-a-price | 3 | 2026-09-09T00:00:00.000Z |

Lưu thành `review-malformed-row.xlsx` và upload. Import có thể kết thúc ở COMPLETED với `rowsFailed: 1`; malformed row được account và không biến mất âm thầm.

Để kiểm tra parser failure cấp file, upload file không phải XLSX:

~~~bash
printf 'this is not an xlsx workbook\n' > corrupt.xlsx
curl -i -X POST http://localhost:3000/imports/products -F 'file=@corrupt.xlsx'
~~~

Hành vi mong đợi là import bị failed hoặc request bị reject ngay, dù parser lỗi ở bước nào. Workbook thiếu hoặc sắp xếp lại required header cũng là file-level validation failure. File-level failure không rollback các batch đã được Redis acknowledge; kiểm tra import status và database rows để thấy boundary đã ghi nhận.

## 9. Hành vi import cần verify

- CREATED, UPLOADING, PROCESSING, COMPLETED và FAILED là các trạng thái trong lifecycle import.
- Upload response thành công chỉ là enqueue acceptance, không phải processing đã hoàn tất.
- rowsRead, rowsProcessed, rowsSucceeded và rowsFailed là các counter được persist.
- Batch accounting idempotent theo `(import_id, batch_id)`, vì vậy retry batch không đếm row hai lần.
- Redis enqueue dùng retry có giới hạn. Nếu hết timeout, import bị failed thay vì bị treo ở trạng thái mơ hồ.
- Worker retry có thể redeliver message; version, fingerprint, lock và unique constraint PostgreSQL bảo vệ business effect.

## 10. Review outbox path

Mỗi logical change được chấp nhận sẽ ghi business state, change history và pending transactional outbox event trong cùng một PostgreSQL transaction. Outbox publisher sau đó gửi BullMQ job downstream. Downstream consumer được thiết kế duplicate-tolerant và chỉ ghi structured log; nó không mutate business state.

Sau khi webhook hoặc import đã process, dùng SQL ở Section 11 để verify logical change được chấp nhận có một state row, một history row cho version đó và outbox event tương ứng. Downstream delivery bị lặp được chấp nhận trong prototype này, nhưng business state không được lặp.

## 11. Lệnh verification tự động

Chạy focused test trước khi review một subsystem:

~~~bash
pnpm test:integration -- polling
pnpm test:integration -- outbox
pnpm test:e2e -- imports
pnpm test:integration -- concurrency
~~~

Concurrency suite là proof cho identical delivery đồng thời, missing-row race, stale update, same-version conflict và bounded worker effect. Suite cùng bao gồm advisory-lock và database invariant coverage.

Chạy đầy đủ bộ verification:

~~~bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
git diff --check
~~~

Integration và end-to-end suite dùng PostgreSQL local theo cấu hình và reset test data dùng chung. Không chạy trên database có data cần bảo toàn.

## 12. Kiểm tra PostgreSQL

Kết nối qua PostgreSQL container của Compose:

~~~bash
docker compose exec postgres psql -U cdms -d cdms
~~~

Các query huu ich:

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

Query duplicate pair phải trả về không có row nếu logical version được process dùng. Với accepted change thành công, đối chiếu product_state, product_changes và outbox_events theo product ID và version. product_changes ghi source ingestion là POLLING, WEBHOOK hoặc EXCEL.

## 13. Concurrency proof

Lệnh focused:

~~~bash
pnpm test:integration -- concurrency
~~~

Proof bao gồm các kết quả mong đợi:

- 100 first write giống nhau tạo một business effect ACCEPTED và 99 duplicate classifications.
- Concurrent missing-row write tạo một logical state/history effect thay vì history bị nhân đôi.
- Version mới hơn được giữ; version cũ hơn không thể làm state lùi.
- Payload khác nhau cùng version được báo là conflict và không âm thầm ghi đè.
- Worker concurrency 8 vẫn chỉ tạo một logical effect cho một logical change.

HTTP response trong các test này thể hiện ingress acceptance. Assertion để chứng minh correctness là PostgreSQL state, history, outbox đã commit và unique constraint.

## 14. Failure scenarios

Các check này dành cho local environment có thể xóa.

### Redis không sẵn sàng

~~~bash
docker compose stop redis
curl -i http://localhost:3000/health
curl -i -X POST http://localhost:3000/webhooks/inventory \
  -H 'Content-Type: application/json' \
  -d '{"productId":"review-redis-down","version":1,"payload":{"sku":"REDIS-DOWN","name":"Redis down","price":"1.00","quantity":1}}'
docker compose start redis
~~~

Health phải là 503 và webhook hợp lệ phải trả 503 sau bounded enqueue retry. Khôi phục Redis trước khi tiếp tục.

### PostgreSQL không sẵn sàng

~~~bash
docker compose stop postgres
curl -i http://localhost:3000/health
docker compose start postgres
~~~

Health phải là 503. Cho database health check và application reconnect trước khi retry API. PostgreSQL là correctness boundary, vì vậy service không xem Redis acceptance là thay thế cho database commit.

### Restart worker khi có queued work

Gửi vai webhook hợp lệ, sau đó restart chỉ worker:

~~~bash
docker compose restart worker
~~~

Redis giữ queued work trong lúc worker restart. Sau khi worker trở lại, query database và xác nhận mỗi logical change có đúng một business effect. Đây là minh chứng cho retry/restart handling; không phải tuyên bố exactly-once delivery.

## 15. Local k6 spike proof

Lệnh ưu tiên là repository wrapper:

~~~bash
pnpm load:spike
~~~

Lệnh này cần API, worker, PostgreSQL, Redis healthy và k6 đã cài. Wrapper từ chối chạy chung với change-queue backlog sẵn có, enqueue baseline version 2 có namespace, chạy webhook duplicate-heavy và stale, sample queue counts, chờ queue drain, sau đó verify database invariants. Report được ghi vào `load-tests/results/`.

Các override huu ich:

~~~bash
BASE_URL=http://localhost:3000 \
UNIQUE_CHANGES=100 \
DUPLICATE_FACTOR=20 \
SPIKE_VUS=100 \
CHANGE_WORKER_CONCURRENCY=10 \
pnpm load:spike
~~~

Direct k6 script bắt buộc có cả BASE_URL và LOAD_RUN_ID; không chạy với default rỗng:

~~~bash
BASE_URL=http://localhost:3000 \
LOAD_RUN_ID=manual-review \
UNIQUE_CHANGES=10 \
DUPLICATE_FACTOR=5 \
SPIKE_VUS=10 \
k6 run --summary-export load-tests/results/manual-review.k6-summary.json load-tests/spike.js
~~~

Kiểm trả script mà không gửi traffic:

~~~bash
k6 inspect \
  --env BASE_URL=http://localhost:3000 \
  --env LOAD_RUN_ID=inspect \
  --env UNIQUE_CHANGES=1 \
  --env SPIKE_VUS=1 \
  load-tests/spike.js
~~~

Spike đo HTTP-to-BullMQ acceptance latency. Nó không phải end-to-end business-processing latency, SLA, hoặc chứng nhận capacity production. Local evidence được lưu cho prototype này ghi nhận 100 unique changes, duplicate factor 20, 100 VUs, worker concurrency 10, queue đã drain, 100 state/history/outbox rows, không có duplicate pair, không có stale regression và proof report pass. Chỉ xem các con số này là developer-machine evidence.

Report được lưu là load-tests/results/run-1788887228601-1abb3b45.json. Các giá trị chính:

| Kiểm trả | Kết quả local |
| --- | ---: |
| Baseline accepted | 100 |
| k6 webhook attempts | 4,000 |
| Tổng attempts gồm baseline | 4,100 |
| Duplicate deliveries | 2,000 |
| Stale deliveries | 2,000 |
| HTTP requests được chấp nhận | 4,000 |
| Maximum waiting jobs | 261 |
| Maximum active jobs | 10 |
| Queue đã drain | true |
| p50 / p95 / p99 ingress latency | 15.9505 / 59.32085 / 473.94659 ms |
| PostgreSQL state / history / outbox rows | 100 / 100 / 100 |
| Duplicate pairs / stale regressions | 0 / 0 |
| Proof passed | true |

## 16. Checklist cho reviewer

- [ ] GET /health trả HTTP 200 với PostgreSQL và Redis up.
- [ ] Inventory create, read và patch hoạt động; patch làm tăng version.
- [ ] Polling tạo history source POLLING sau configured interval.
- [ ] Webhook hợp lệ trả 202; validation không hợp lệ trả 400.
- [ ] Duplicate, stale và same-version conflict không làm hỏng state.
- [ ] XLSX upload dùng field file và exact seven-column header.
- [ ] Import status counters và SSE terminal events quan sát được.
- [ ] Malformed row được dem là failed; malformed workbook failed ở cấp file.
- [ ] PostgreSQL có một business effect cho mỗi logical product/version và outbox event tương ứng.
- [ ] Redis, PostgreSQL và worker restart scenario recover dùng như tài liệu.
- [ ] Focused test, full test, lint, typecheck, build và git diff --check pass.
- [ ] Nếu chạy k6 wrapper, report cho thấy queue đã drain và database proof pass.

## 17. Cleanup và troubleshooting

Dùng Compose mà không xóa local database volume:

~~~bash
docker compose down
~~~

Để xóa cả PostgreSQL và Redis volume disposable:

~~~bash
docker compose down -v
~~~

Các check thường gặp:

- Port 3000, 5432 hoặc 6379 đã được dùng: dùng process trên port khác hoặc đặt host port tương ứng trước khi start Compose.
- API start nhưng request lỗi: chạy `curl -i http://localhost:3000/health`, xem `docker compose logs cdms worker` và xác nhận migration đã chạy.
- Import vẫn ở PROCESSING: xem worker logs, Redis health, `GET /imports/<id>` và các row trong `import_batch_accounting`.
- Polling có vẻ không chạy: chờ lâu hơn `POLL_INTERVAL_MS`, xác nhận API process đang chạy và query `polling_checkpoints`.
- k6 precheck từ chối chạy: drain queue không liên quan, xác nhận worker đang chạy và kiểm tra k6 version.
- Database chưa có state mới sau HTTP 202: chờ worker process; 202 là enqueue acceptance, không phải transaction đã hoàn tất.

Xem thêm [architecture](architecture.md), [failure handling](failure-handling.md), [Excel streaming](excel-streaming.md), [SSE progress](sse-progress.md) và [testing](testing.md) để đọc lý do kiến trúc và failure boundary.
