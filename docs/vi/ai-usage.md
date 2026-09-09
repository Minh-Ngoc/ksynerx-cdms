# Công bố việc sử dụng AI

## Phạm vi AI hỗ trợ

AI được sử dụng trong suốt prototype như một engineering collaborator. AI hỗ trợ thảo luận kiến trúc, lặp kế hoạch implementation, tạo và chỉnh sửa code TypeScript/NestJS, thiết kế và tạo test, debugging, phân tích qualification spike, và draft tài liệu song ngữ. Code và tài liệu không được xem là hoàn toàn do con người tự viết.

AI không thay thế engineering responsibility. Các đề xuất được đối chiếu với repository, runtime behavior, database state, queue behavior, test và acceptance criteria. Đề xuất bị sửa hoặc reject khi evidence không phù hợp.

## AI Đã Được Sử dụng Như thế nào

- Architecture và task planning bao gồm một NestJS project với API/worker role, PostgreSQL là correctness boundary, BullMQ buffering, advisory-lock serialization, transactional outbox, streaming XLSX ingestion và SSE progress.
- Implementation được làm theo từng bước với AI assistance và human review qua feature modules, migrations, queue processors, import lifecycle, progress accounting, health checks và load-test tooling.
- Test được tạo và tính chính cho canonicalization, version decisions, advisory-lock race, missing-row first write, polling checkpoint, outbox publication, Excel parsing/backpressure, import batch replay, SSE setup race và health failure.
- Documentation và ADR được draft song ngữ từ implementation, sau đó review để đối chiếu identifiers, commands, guarantees, limitations và measured results.

## Human Review và Verification

Human review bao gồm source inspection, manual architecture decisions và review transaction/concurrency logic không obvious. Verification bao gồm:

- PostgreSQL integration tests cho advisory lock, atomic state/history/outbox writes, import accounting và concurrent terminal transitions;
- Redis/BullMQ integration tests chờ queue processing, retry behavior, worker concurrency và outbox publication;
- runtime qualification của các XLSX library và internal parser cuối cùng;
- e2e checks cho webhook, inventory, import status/progress, SSE và health;
- concurrency proof của Task 23;
- k6 spike và post-run PostgreSQL invariant queries của Task 24;
- manual review song ngữ của documentation cuối cùng.

AI output không được chấp nhận mù quáng. Test và runtime evidence được ưu tiên hơn reasoning do AI tạo ra hay giả định từ library documentation.

## Ví dụ Về Quyết định Có AI Hỗ trợ

Thiết kế advisory-lock và deterministic key derivation được review theo missing-row race và test với PostgreSQL concurrency. Thiết kế import progress được sửa quanh post-commit/pre-ack replay window: aggregate counters không đủ, nên thêm `import_batch_accounting` làm progress idempotency accounting, và ghi rõ nó không phải Inbox Pattern.

Excel ingestion cần nhiều lần qualification. ExcelJS `WorkbookReader` bị reject sau runtime failure đã verify. `xlsx-extract` và `xlsx-stream-reader` bị reject vì EventEmitter API không propagate được producer-side backpressure. Pipeline được implement là Busboy, controlled temporary-file staging, `yauzl`, `sax`, Node streams, bounded batches và BullMQ enqueue retry.

Các khu vực khác được review gồm SSE subscribe-before-snapshot setup race, polling checkpoint sau enqueue, duplicate publication của transactional outbox, và phân biệt exactly-once business effect với message delivery. BullMQ retry/concurrency behavior và framework/library API liên quan được source-verify trước khi ghi vào design.

## Commands và Verification Evidence

Các command form đã verify trong repository gồm:

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

Regression cuối cùng có 32 unit suites và 169 tests, 13 integration suites và 58 tests, 5 e2e suites và 16 tests. Evidence local Task 24 dùng 100 unique logical changes, duplicate factor 20, 100 VUs, worker concurrency 10 và 4.000 k6 attempts. Tất cả attempts trả `202`; queue đạt 261 waiting và 10 active, sau đó drain; PostgreSQL verify 100 `product_state`, 100 `product_changes`, 100 outbox rows, không có duplicate version pair và stale regression. Đây là kết quả trên máy developer, không phải production benchmark hay SLA.

## Đề xuất AI Bị Reject Hoặc Sửa

Một số hướng dẫn ban đầu không đầy đủ hoặc không dùng. Cụ thể, hướng Excel library ban đầu bị thay thế sau runtime qualification; EventEmitter reader không được coi là streaming-safe chỉ vì nó expose row events. Mô tả kiến trúc được sửa khi evidence cho thấy Redis chỉ là live progress mirror, BullMQ không phải correctness boundary, và outbox publication có thể duplicate sau crash giữa queue publish và update `PUBLISHED`.

Documentation cuối cùng cùng sửa cách dùng “exactly once” mơ hồ thành “exactly-once effect” cho PostgreSQL/business persistence và ghi rõ global exactly-once delivery chưa được implement.

## Limitations Còn lại và Phần Việc Chưa Hoàn tất

- Task 27 final review và code simplification đã hoàn tất; production hardening tiếp theo vẫn nằm ngoài scope prototype này.
- Catastrophic Redis data loss sau acknowledged enqueue có thể làm mất work chưa persist vào PostgreSQL.
- SSE live updates không durable; PostgreSQL là authority sau reconnect.
- Transactional outbox publication có thể duplicate downstream delivery; consumer chỉ duplicate-tolerant logging.
- XLSX parser chỉ hỗ trợ subset cần thiết, không phải mỗi tính năng Excel.
- Shared strings có thể làm tăng memory, và temporary-file staging dùng local disk.
- Health timeout giới hạn HTTP readiness response nhưng không cancel PostgreSQL query đang chạy.
- Load results là evidence trên máy developer, không phải capacity certification.

## Trách nhiệm

Project owner vẫn chịu trách nhiệm cho code, kiến trúc, test, documentation và các claim cuối cùng. AI hỗ trợ đẩy nhanh việc explore và draft, nhưng acceptance dựa trên human review và executable evidence. Tài liệu này không tiết lộ secrets, credentials, private tokens hay local absolute filesystem paths.
