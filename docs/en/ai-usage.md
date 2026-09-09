# AI Usage Disclosure

## Scope of AI Assistance

AI assistance was used throughout this prototype as an engineering collaborator. It contributed to architecture discussion, implementation planning, TypeScript/NestJS code generation and revision, test design and generation, debugging, qualification-spike analysis, and bilingual documentation drafting. The code and documents were not presented as entirely manual authorship.

AI assistance did not replace engineering responsibility. Decisions were checked against the repository, runtime behavior, database state, queue behavior, tests, and documented acceptance criteria. Suggestions were revised or rejected when evidence disagreed with them.

## How AI Was Used

- Architecture and task planning covered one NestJS project with API/worker roles, PostgreSQL as the correctness boundary, BullMQ buffering, advisory-lock serialization, transactional outbox, streaming XLSX ingestion, and SSE progress.
- Implementation proceeded iteratively with AI assistance and human review across feature modules, migrations, queue processors, import lifecycle, progress accounting, health checks, and load-test tooling.
- Tests were generated and refined for canonicalization, version decisions, advisory-lock races, missing-row first writes, polling checkpoints, outbox publication, Excel parsing/backpressure, import batch replay, SSE setup races, and health failures.
- Documentation and ADRs were drafted bilingually from the implementation and then reviewed for matching identifiers, commands, guarantees, limitations, and measured results.

## Human Review and Verification

Human review included source inspection, manual architecture decisions, and review of non-obvious transaction and concurrency logic. Verification included:

- PostgreSQL integration tests for advisory locks, atomic state/history/outbox writes, import accounting, and concurrent terminal transitions;
- Redis/BullMQ integration tests for queue processing, retry behavior, worker concurrency, and outbox publication;
- runtime qualification of XLSX libraries and the final internal parser;
- e2e checks for webhook, inventory, import status/progress, SSE, and health behavior;
- the Task 23 concurrency proof;
- the Task 24 k6 spike and post-run PostgreSQL invariant queries;
- bilingual manual review of the final documentation.

AI output was not accepted blindly. Real tests and runtime evidence took precedence over generated reasoning or library documentation assumptions.

## Examples of AI-Assisted Decisions

The advisory-lock design and its deterministic key derivation were reviewed against the missing-row race and tested with PostgreSQL concurrency. The import progress design was amended around the post-commit/pre-ack replay window: aggregate counters were insufficient, so `import_batch_accounting` was introduced as progress idempotency accounting, explicitly not an Inbox Pattern.

Excel ingestion required multiple qualification attempts. ExcelJS `WorkbookReader` was rejected after a verified runtime failure. `xlsx-extract` and `xlsx-stream-reader` were rejected because their EventEmitter APIs could not propagate producer-side backpressure. The implemented path is Busboy, controlled temporary-file staging, `yauzl`, `sax`, Node streams, bounded batches, and BullMQ enqueue retry.

Other reviewed areas included the SSE subscribe-before-snapshot setup race, polling checkpoint advancement after enqueue, transactional outbox duplicate publication, and the distinction between exactly-once business effect and message delivery. BullMQ retry/concurrency behavior and relevant framework/library APIs were source-verified before being reflected in the design.

## Commands and Verification Evidence

The repository's verified command forms include:

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

The final regression run completed with 32 unit suites and 169 tests, 13 integration suites and 58 tests, and 5 e2e suites and 16 tests. The local Task 24 evidence used 100 unique logical changes, duplicate factor 20, 100 VUs, worker concurrency 10, and 4,000 k6 attempts. All attempts returned `202`; the queue reached 261 waiting and 10 active, drained, and PostgreSQL verified 100 `product_state`, 100 `product_changes`, 100 outbox rows, no duplicate version pairs, and no stale regressions. These are developer-machine results, not a production benchmark or SLA.

## Rejected or Corrected AI Suggestions

Some initial directions were incomplete or incorrect. In particular, early Excel library paths were superseded by runtime qualification; EventEmitter-based readers were not treated as streaming-safe merely because they exposed row events. Architecture descriptions were corrected when implementation evidence showed that Redis was only a live progress mirror, BullMQ was not the correctness boundary, and outbox publication could duplicate after a crash between queue publish and the `PUBLISHED` update.

The final documentation also corrects ambiguous “exactly once” wording to “exactly-once effect” for PostgreSQL/business persistence and explicitly states that global exactly-once delivery is not implemented.

## Remaining Limitations and Unfinished Work

- Task 27 final review and code simplification are complete; further production hardening remains outside this prototype task scope.
- Catastrophic Redis data loss after acknowledged enqueue can lose work not yet persisted to PostgreSQL.
- SSE live updates are non-durable; PostgreSQL is authoritative after reconnect.
- Transactional outbox publication can duplicate downstream delivery; the consumer is duplicate-tolerant logging only.
- The XLSX parser supports the required subset, not every Excel feature.
- Shared strings can grow memory, and temporary-file staging uses local disk.
- The health timeout bounds the HTTP readiness response but does not cancel an already-running PostgreSQL query.
- Load results are local developer-machine evidence, not capacity certification.

## Responsibility

The project owner remains responsible for the final code, architecture, tests, documentation, and claims. AI assistance accelerated exploration and drafting, but acceptance depended on human review and executable evidence. No secrets, credentials, private tokens, or local absolute filesystem paths are disclosed here.
