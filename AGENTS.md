# Project Overview

This repository is a prototype Change Data Management Service (CDMS) for product and inventory data. It demonstrates multiple ingestion mechanisms, duplicate handling, stale update prevention, concurrent processing correctness, failure handling, asynchronous workload buffering, streaming Excel ingestion, SSE progress updates, and single-machine containerized deployment.

Future AI coding agents must treat this file as repository-specific guidance. Do not copy rules from `.agents/agent-skills/AGENTS.md`; use the vendored addyosmani agent skills as workflow references only.

# Architecture Rules

- This is one NestJS project, not a monorepo.
- Keep the code feature-module oriented.
- Use TypeORM with PostgreSQL.
- Use Redis and BullMQ for asynchronous workload buffering, retry, and load smoothing.
- PostgreSQL is the source-of-truth and correctness boundary.
- BullMQ does not provide exactly-once correctness and must not be described as solving race conditions.
- Excel uploads must be streamed. Never buffer a complete workbook or upload in RAM.
- SSE is used only for import progress and status updates from server to client.
- A transactional outbox protects PostgreSQL commit to asynchronous publication.
- Use a separate worker process/container role for the prototype while keeping the same repository, same NestJS source project, and preferably the same Docker image.
- Use a dedicated BullMQ downstream queue with a minimal duplicate-tolerant downstream consumer for outbox publication. The consumer may perform structured logging only.
- Duplicate downstream delivery must not mutate business state or violate database invariants. Duplicate structured log entries are acceptable for this prototype.
- Store inventory product price as PostgreSQL `NUMERIC(18,2)`. Use a normalized decimal string in canonical product-change payloads and fingerprints.
- Use `INVENTORY_SEED_COUNT=1000` by default, configurable by environment.
- Use `IMPORT_MAX_FILE_SIZE_MB=100` by default and enforce it without buffering the full upload.
- Use a bounded Redis enqueue retry timeout for imports, default `IMPORT_REDIS_RETRY_TIMEOUT_MS=30000`.
- Do not introduce `apps/`, `packages/`, microservices, or a monorepo unless explicitly approved.

# Skill Workflow

Use the vendored agent skills under `.agents/agent-skills/skills` when they match the task.

- New feature: `spec-driven-development` -> `planning-and-task-breakdown` -> `incremental-implementation` -> `test-driven-development`
- API changes: `api-and-interface-design`
- Framework or library uncertainty: `source-driven-development`
- Bug: `debugging-and-error-recovery` -> `test-driven-development`
- Review: `code-review-and-quality`
- Simplification: `code-simplification`
- Documentation and ADRs: `documentation-and-adrs`
- Version control work: `git-workflow-and-versioning`
- Observability changes: `observability-and-instrumentation`

# Engineering Rules

ALWAYS:

- Use strict TypeScript.
- Use NestJS dependency injection.
- Use TypeORM migrations; do not rely on `synchronize: true`.
- Add or update tests for behavior changes.
- Preserve idempotency.
- Preserve database invariants.
- Verify framework APIs against official documentation when uncertain.
- Run lint, typecheck, and tests after meaningful changes.
- Update documentation when architecture or behavior changes.
- Keep English and Vietnamese documentation synchronized in the same task.

ASK FIRST:

- Adding Kafka.
- Adding Temporal.
- Adding Airflow.
- Adding Kubernetes.
- Introducing a monorepo.
- Introducing microservices.
- Introducing event sourcing.
- Adding the PostgreSQL Inbox Pattern.
- Changing PostgreSQL.
- Changing TypeORM.
- Removing Redis or BullMQ.
- Changing exactly-once effect semantics.
- Changing persistence guarantees.
- Adding another infrastructure dependency.

NEVER:

- Buffer complete Excel files in RAM.
- Rely on BullMQ deduplication as database correctness.
- Call BullMQ delivery exactly-once.
- Silently overwrite same-version conflicting data.
- Regress product state to an older version.
- Use `synchronize: true` as the production schema strategy.
- Swallow failures.
- Generate fake progress percentages.
- Add speculative abstractions.
- Change unrelated code while implementing a task.

# Code Comment Policy

Comments are mandatory for all complex or non-obvious logic.

A complex block without an explanatory comment is considered incomplete.

Comments are mandatory for:

- complex business logic;
- multi-step algorithms or transformations;
- non-obvious branching;
- concurrency;
- transaction and locking logic;
- idempotency and deduplication;
- stale/duplicate/version-conflict handling;
- retry and error-recovery behavior;
- BullMQ/Redis failure semantics;
- polling checkpoint logic;
- Excel streaming, batching, and backpressure;
- canonicalization and fingerprint generation;
- transactional outbox behavior;
- SSE lifecycle edge cases;
- important performance optimizations;
- unusual TypeORM/PostgreSQL behavior;
- intentional implementation trade-offs.

Comments should explain primarily:

- WHY the logic exists;
- which invariant it protects;
- which edge case it handles;
- which failure or race condition it prevents;
- which trade-off is being made;
- WHY a simpler implementation would be unsafe.

Do not:

- comment trivial syntax;
- restate method/variable names;
- comment obvious NestJS boilerplate;
- use comments as a substitute for readable code;
- leave stale comments after refactoring.

When complex logic changes, its comments must be reviewed and updated in the same task.

# Verification Commands

Canonical local commands:

```bash
pnpm lint
pnpm build
pnpm test
pnpm test:e2e
pnpm test:integration
```

`pnpm typecheck` should be added during implementation as a dedicated TypeScript verification command if it is not already present.

Docker commands once Docker Compose is available:

```bash
docker compose up --build
docker compose down -v
```

# Documentation Rule

All persistent project documentation must exist in both English and Vietnamese.

- English is the canonical technical wording.
- Vietnamese must accurately preserve the same semantics.
- When one language version changes, update the other in the same task.
- No documentation change is complete until both versions are synchronized.

# Huong Dan Bang Tieng Viet

## Tong Quan Du An

Repository nay la prototype Change Data Management Service (CDMS) cho du lieu product va inventory. He thong can the hien nhieu co che ingestion, xu ly duplicate, chan stale update, dam bao dung duoi concurrent processing, xu ly failure, buffer workload bat dong bo, streaming Excel ingestion, SSE progress updates, va trien khai mot may bang container.

## Quy Tac Kien Truc

- Day la mot project NestJS duy nhat, khong phai monorepo.
- To chuc code theo feature module.
- Su dung TypeORM voi PostgreSQL.
- Su dung Redis va BullMQ de buffer workload bat dong bo, retry, va lam muot tai.
- PostgreSQL la source-of-truth va ranh gioi correctness.
- BullMQ khong dam bao exactly-once correctness va khong duoc mo ta la co che giai quyet race condition.
- Excel upload phai duoc streaming; khong buffer toan bo workbook hoac upload trong RAM.
- SSE chi dung cho progress/status cua import tu server den client.
- Transactional outbox bao ve qua trinh tu PostgreSQL commit den asynchronous publication.
- Dung separate worker process/container role cho prototype trong khi van giu cung repository, cung NestJS source project, va tot nhat la cung Docker image.
- Dung dedicated BullMQ downstream queue voi minimal duplicate-tolerant downstream consumer cho outbox publication. Consumer co the chi structured logging.
- Duplicate downstream delivery khong duoc mutate business state hoac violate database invariants. Duplicate structured log entries duoc chap nhan cho prototype nay.
- Luu inventory product price bang PostgreSQL `NUMERIC(18,2)`. Dung normalized decimal string trong canonical product-change payloads va fingerprints.
- Dung `INVENTORY_SEED_COUNT=1000` mac dinh va co the cau hinh bang environment.
- Dung `IMPORT_MAX_FILE_SIZE_MB=100` mac dinh va enforce ma khong buffer full upload.
- Dung bounded Redis enqueue retry timeout cho imports, mac dinh `IMPORT_REDIS_RETRY_TIMEOUT_MS=30000`.
- Khong them `apps/`, `packages/`, microservices, hoac monorepo neu chua duoc chap thuan ro rang.

## Workflow Skill

Dung cac agent skills trong `.agents/agent-skills/skills` khi phu hop voi task.

- Feature moi: `spec-driven-development` -> `planning-and-task-breakdown` -> `incremental-implementation` -> `test-driven-development`
- Thay doi API: `api-and-interface-design`
- Chua chac framework/library: `source-driven-development`
- Bug: `debugging-and-error-recovery` -> `test-driven-development`
- Review: `code-review-and-quality`
- Don gian hoa code: `code-simplification`
- Tai lieu va ADR: `documentation-and-adrs`
- Git/version control: `git-workflow-and-versioning`
- Observability: `observability-and-instrumentation`

## Quy Tac Ky Thuat

LUON:

- Su dung strict TypeScript.
- Su dung NestJS dependency injection.
- Su dung TypeORM migrations; khong dua vao `synchronize: true`.
- Them hoac cap nhat test cho thay doi hanh vi.
- Giu idempotency.
- Giu database invariants.
- Kiem tra official docs khi chua chac API framework/library.
- Chay lint, typecheck, va tests sau cac thay doi co y nghia.
- Cap nhat tai lieu khi kien truc hoac hanh vi thay doi.
- Dong bo tai lieu tieng Anh va tieng Viet trong cung task.

HOI TRUOC:

- Them Kafka, Temporal, Airflow, Kubernetes.
- Gioi thieu monorepo, microservices, event sourcing.
- Them PostgreSQL Inbox Pattern.
- Doi PostgreSQL hoac TypeORM.
- Bo Redis hoac BullMQ.
- Doi exactly-once effect semantics hoac persistence guarantees.
- Them infrastructure dependency khac.

KHONG BAO GIO:

- Buffer toan bo file Excel trong RAM.
- Dua vao BullMQ deduplication lam database correctness.
- Goi BullMQ delivery la exactly-once.
- Am tham ghi de du lieu conflict cung version.
- Lam product state lui ve version cu hon.
- Dung `synchronize: true` lam chien luoc schema production.
- Nuot loi.
- Tao progress percentage gia.
- Them abstraction suy doan.
- Doi code khong lien quan khi implement task.

## Chinh Sach Comment Code

Comment la bat buoc cho moi logic phuc tap hoac khong obvious.

Mot block phuc tap ma khong co comment giai thich duoc xem la chua hoan thanh.

Comment bat buoc cho:

- business logic phuc tap;
- algorithm hoac transformation nhieu buoc;
- branching khong obvious;
- concurrency;
- transaction va locking;
- idempotency va deduplication;
- xu ly stale/duplicate/version-conflict;
- retry va error recovery;
- BullMQ/Redis failure semantics;
- polling checkpoint;
- Excel streaming, batching, va backpressure;
- canonicalization va fingerprinting;
- Outbox behavior;
- SSE edge cases;
- performance optimization quan trong;
- hanh vi TypeORM/PostgreSQL bat thuong;
- trade-off co chu y trong implementation.

Comment nen giai thich:

- WHY logic ton tai;
- invariant nao duoc bao ve;
- edge case nao duoc xu ly;
- failure hoac race condition nao duoc ngan chan;
- trade-off nao dang duoc chap nhan;
- vi sao cach don gian hon khong an toan.

Khong:

- comment syntax tam thuong;
- lap lai ten method/variable;
- comment NestJS boilerplate obvious;
- dung comment thay cho code de doc;
- de comment cu sau khi refactor.

Khi logic phuc tap thay doi, comment lien quan phai duoc review va cap nhat trong cung task.
