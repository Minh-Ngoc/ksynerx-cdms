# Exactly-Once Effect

Prototype nay cung cap exactly-once effect o PostgreSQL/business level. He thong khong cung cap exactly-once message delivery. BullMQ retry va duplicate delivery la input du kien.

## Decision table

| Input | State hien tai | Result | Database effect |
|---|---|---|---|
| version thap hon | version moi hon da ton tai | `STALE` | khong ghi |
| cung version, fingerprint canonical giong | cung state | `DUPLICATE` | khong ghi |
| cung version, fingerprint khac | cung state | `VERSION_CONFLICT` | khong overwrite |
| version moi hon hoac chua co state | absent/older | `ACCEPTED` | ghi history, state va outbox |

Fingerprint chi dung canonical payload. Price la decimal string da normalize tuong thich PostgreSQL `NUMERIC(18,2)` va thu tu key JSON duoc co dinh. Delivery metadata nhu source va observed time khong tao same-version conflict gia.

## Serialization va transaction

Moi product duoc serialize bang `pg_advisory_xact_lock`, acquire qua TypeORM manager gan voi transaction truoc khi doc `product_state`. Key la 8 bytes dau cua SHA-256 tren product ID UTF-8 da trim, dien giai thanh signed PostgreSQL `bigint`. Key deterministic giua process va restart. Collision 64-bit co the serialize product khong lien quan, nhung khong lam hong data vi lock chi them ordering.

Lock bao phu missing-row va existing-row race. Unique `(product_id, version)` van la database invariant phong ve. Accepted change insert `product_changes`, upsert `product_state`, va insert `outbox_events` trong mot PostgreSQL transaction.

## Progress la mot van de rieng

Business idempotency dung product/version/fingerprint trong `ChangeProcessor`. Import progress idempotency dung `importId + batchId` trong `import_batch_accounting`. Chi dung aggregate counters khong the nhan dien replay sau khi PostgreSQL commit nhung truoc khi BullMQ acknowledge job. Accounting table chi luu terminal progress delta; day khong phai PostgreSQL Inbox Pattern va khong luu message payload hay business state.

Uploader so huu `rowsRead`. Batch worker so huu terminal `rowsProcessed`, `rowsSucceeded`, `rowsFailed`. PostgreSQL giu `rowsProcessed = rowsSucceeded + rowsFailed` va `rowsProcessed <= rowsRead`. Completion can `enqueue_completed_at IS NOT NULL` va `rowsProcessed = rowsRead`.

## Evidence

Task 23 verify 100 identical first writes tao mot accepted effect va 99 duplicate outcomes, gom missing-row race. Concurrent version 5 va 6 de lai final state version 6. Same-version competing payload tao `VERSION_CONFLICT`, khong last-writer-wins. Worker concurrency 8 van cho mot logical database effect trong integration proof. Cac test nay xac nhan invariant o concurrency da test, khong chung nhan infinite-scale correctness.
