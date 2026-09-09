# Disclosure Su Dung AI

## Pham Vi AI Ho Tro

AI duoc su dung trong suot prototype nhu mot engineering collaborator. AI ho tro thao luan kien truc, lap ke hoach implementation, tao va chinh sua code TypeScript/NestJS, thiet ke va tao test, debugging, phan tich qualification spike, va draft tai lieu song ngu. Code va tai lieu khong duoc xem la hoan toan do con nguoi tu viet.

AI khong thay the engineering responsibility. Cac de xuat duoc doi chieu voi repository, runtime behavior, database state, queue behavior, test va acceptance criteria. De xuat bi sua hoac reject khi evidence khong phu hop.

## AI Da Duoc Su Dung Nhu The Nao

- Architecture va task planning bao gom mot NestJS project voi API/worker role, PostgreSQL la correctness boundary, BullMQ buffering, advisory-lock serialization, transactional outbox, streaming XLSX ingestion va SSE progress.
- Implementation duoc lam theo tung buoc voi AI assistance va human review qua feature modules, migrations, queue processors, import lifecycle, progress accounting, health checks va load-test tooling.
- Test duoc tao va tinh chinh cho canonicalization, version decisions, advisory-lock race, missing-row first write, polling checkpoint, outbox publication, Excel parsing/backpressure, import batch replay, SSE setup race va health failure.
- Documentation va ADR duoc draft song ngu tu implementation, sau do review de doi chieu identifiers, commands, guarantees, limitations va measured results.

## Human Review va Verification

Human review bao gom source inspection, manual architecture decisions va review transaction/concurrency logic khong obvious. Verification bao gom:

- PostgreSQL integration tests cho advisory lock, atomic state/history/outbox writes, import accounting va concurrent terminal transitions;
- Redis/BullMQ integration tests cho queue processing, retry behavior, worker concurrency va outbox publication;
- runtime qualification cua cac XLSX library va internal parser cuoi cung;
- e2e checks cho webhook, inventory, import status/progress, SSE va health;
- concurrency proof cua Task 23;
- k6 spike va post-run PostgreSQL invariant queries cua Task 24;
- manual review song ngu cua documentation cuoi cung.

AI output khong duoc chap nhan mu quang. Test that va runtime evidence duoc uu tien hon reasoning do AI tao ra hay gia dinh tu library documentation.

## Vi Du Ve Quyet Dinh Co AI Ho Tro

Thiet ke advisory-lock va deterministic key derivation duoc review theo missing-row race va test voi PostgreSQL concurrency. Thiet ke import progress duoc sua quanh post-commit/pre-ack replay window: aggregate counters khong du, nen them `import_batch_accounting` lam progress idempotency accounting, va ghi ro no khong phai Inbox Pattern.

Excel ingestion can nhieu lan qualification. ExcelJS `WorkbookReader` bi reject sau runtime failure da verify. `xlsx-extract` va `xlsx-stream-reader` bi reject vi EventEmitter API khong propagate duoc producer-side backpressure. Pipeline duoc implement la Busboy, controlled temporary-file staging, `yauzl`, `sax`, Node streams, bounded batches va BullMQ enqueue retry.

Cac khu vuc khac duoc review gom SSE subscribe-before-snapshot setup race, polling checkpoint sau enqueue, duplicate publication cua transactional outbox, va phan biet exactly-once business effect voi message delivery. BullMQ retry/concurrency behavior va framework/library API lien quan duoc source-verify truoc khi ghi vao design.

## Commands va Verification Evidence

Cac command form da verify trong repository gom:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
docker compose config
k6 run load-tests/spike.js
pnpm load:spike
git diff --check
```

Regression cuoi cung co 32 unit suites va 169 tests, 13 integration suites va 58 tests, 5 e2e suites va 16 tests. Evidence local Task 24 dung 100 unique logical changes, duplicate factor 20, 100 VUs, worker concurrency 10 va 4.000 k6 attempts. Tat ca attempts tra `202`; queue dat 261 waiting va 10 active, sau do drain; PostgreSQL verify 100 `product_state`, 100 `product_changes`, 100 outbox rows, khong co duplicate version pair va stale regression. Day la ket qua tren may developer, khong phai production benchmark hay SLA.

## De Xuat AI Bi Reject Hoac Sua

Mot so huong dan ban dau khong day du hoac khong dung. Cu the, huong Excel library ban dau bi thay the sau runtime qualification; EventEmitter reader khong duoc coi la streaming-safe chi vi no expose row events. Mo ta kien truc duoc sua khi evidence cho thay Redis chi la live progress mirror, BullMQ khong phai correctness boundary, va outbox publication co the duplicate sau crash giua queue publish va update `PUBLISHED`.

Documentation cuoi cung cung sua cach dung “exactly once” mo ho thanh “exactly-once effect” cho PostgreSQL/business persistence va ghi ro global exactly-once delivery chua duoc implement.

## Limitations Con Lai va Phan Viec Chua Hoan Tat

- Task 27 final review va code simplification da hoan tat; production hardening tiep theo van nam ngoai scope prototype nay.
- Catastrophic Redis data loss sau acknowledged enqueue co the lam mat work chua persist vao PostgreSQL.
- SSE live updates khong durable; PostgreSQL la authority sau reconnect.
- Transactional outbox publication co the duplicate downstream delivery; consumer chi duplicate-tolerant logging.
- XLSX parser chi ho tro subset can thiet, khong phai moi tinh nang Excel.
- Shared strings co the lam tang memory, va temporary-file staging dung local disk.
- Health timeout gioi han HTTP readiness response nhung khong cancel PostgreSQL query dang chay.
- Load results la evidence tren may developer, khong phai capacity certification.

## Trach Nhiem

Project owner van chiu trach nhiem cho code, kien truc, test, documentation va cac claim cuoi cung. AI ho tro day nhanh viec explore va draft, nhung acceptance dua tren human review va executable evidence. Tai lieu nay khong tiet lo secrets, credentials, private tokens hay local absolute filesystem paths.
