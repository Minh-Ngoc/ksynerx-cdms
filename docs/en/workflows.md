# CDMS Workflows

This document explains the finished CDMS prototype progressively, from system context to detailed ingestion, correctness, retry, import, outbox, SSE, and review workflows. It is a visual companion to the architecture, failure-handling, Excel-streaming, transactional-outbox, SSE, testing, and usage documents.

The system provides exactly-once effect at PostgreSQL/business level. Redis/BullMQ provides buffering, retry, and bounded concurrency; it does not provide exactly-once delivery.

## Navigation by depth

| Level | Diagram | Purpose |
| --- | --- | --- |
| L1 | System Context | What systems exist? |
| L2 | Deployment Topology | What processes and containers run? |
| L3 | Application Layers | Which modules own which responsibilities? |
| L4 | Unified Ingestion | How do polling, webhooks, and Excel converge? |
| L5 | Correctness and Concurrency | How is exactly-once effect enforced? |
| L6 | Detailed Workflows | How do import, progress, SSE, outbox, health, and failures work? |

## 1. System Context

~~~mermaid
flowchart LR
    Inventory[Inventory Emulator]
    WebhookClient[Webhook Client]
    ExcelClient[Excel Upload Client]
    CDMS[CDMS Prototype]
    DB[(PostgreSQL)]
    Redis[(Redis / BullMQ)]

    Inventory -->|Scheduled Polling| CDMS
    WebhookClient -->|Webhook| CDMS
    ExcelClient -->|Excel Upload| CDMS
    CDMS --> DB
    CDMS --> Redis
~~~

**What this shows:** External or emulated inventory data enters through scheduled polling, webhooks, or an Excel upload. CDMS uses PostgreSQL for durable business correctness and Redis/BullMQ for asynchronous buffering.

**Important invariant:** All three ingress mechanisms eventually use the same normalized change-processing and PostgreSQL correctness path.

**Failure behavior:** If Redis cannot accept an ingress job, the API must not claim asynchronous acceptance. PostgreSQL remains the source of truth.

**Why this design:** The prototype demonstrates multiple ingestion mechanisms without creating separate business-processing implementations.

**Relevant implementation:** `src/app.module.ts`, `src/modules/ingestion/`, `src/modules/imports/`, `src/modules/queue/`, `src/database/`.

## 2. Deployment / Runtime Topology

~~~mermaid
flowchart LR
    Client[User / Client] --> API[cdms API container]
    API -->|HTTP, polling, health| APIProcess[AppModule / API process]
    APIProcess --> DB[(postgres container)]
    APIProcess --> Redis[(redis container)]
    Redis -->|cdms-change| Worker[worker container]
    Redis -->|cdms-import-batch| Worker
    Redis -->|cdms-downstream| Worker
    Worker -->|ChangeProcessor / Outbox| DB

    Image[ksynerx-cdms:local<br/>one built image]
    Image -.-> API
    Image -.-> Worker
~~~

**What this shows:** Docker Compose runs `cdms`, `worker`, `postgres`, and `redis`. The API and worker use the same built image but different commands: `node dist/main.js` and `node dist/worker.js`.

**Important invariant:** The repository remains one NestJS source project. The worker is a separate runtime role, not a microservice source split.

**Failure behavior:** Compose waits for PostgreSQL and Redis health checks before starting the API and worker roles. A worker restart does not imply exactly-once delivery; replay remains safe because PostgreSQL decides the business effect.

**Why this design:** Separate process roles keep HTTP/polling/upload responsibilities away from asynchronous consumers while preserving one codebase and one image.

**Relevant implementation:** `docker-compose.yml`, `src/app.module.ts`, `src/worker.module.ts`, `src/main.ts`, `src/worker.ts`, `src/worker.bootstrap.ts`.

## 3. Application Layers

~~~mermaid
flowchart TB
    subgraph Presentation["Presentation / Ingress"]
        InventoryController[InventoryController]
        WebhookController[InventoryWebhookController]
        ImportsController[ImportsController]
        HealthController[HealthController]
        SSE[GET /imports/:id/progress]
    end

    subgraph Coordination["Application / Coordination"]
        PollingScheduler[PollingScheduler]
        PollingService[PollingService]
        WebhookService[WebhookIngestionService]
        ImportUpload[ImportUploadService]
        ImportRead[ImportProgressReadService]
        ImportProgress[ImportProgressService]
        Producers[ChangeQueueProducer<br/>ImportBatchQueueProducer<br/>OutboxDownstreamQueueProducer]
        OutboxScheduler[OutboxPublisherScheduler]
    end

    subgraph Async["Queue / Async"]
        ChangeQueue[cdms-change]
        ImportQueue[cdms-import-batch]
        DownstreamQueue[cdms-downstream]
        ChangeWorker[ChangeQueueProcessor]
        ImportWorker[ImportBatchQueueProcessor]
        DownstreamWorker[DownstreamOutboxProcessor]
    end

    subgraph Business["Business / Domain Processing"]
        Normalizers[Polling / Webhook / Excel normalizers]
        ChangeProcessor[ChangeProcessor]
        Lock[ProductLockService]
    end

    subgraph Persistence["Persistence"]
        Tables[(inventory_products<br/>product_state<br/>product_changes<br/>outbox_events<br/>import_jobs<br/>import_batch_accounting<br/>polling_checkpoints)]
    end

    subgraph Infrastructure["Infrastructure"]
        PostgreSQL[(PostgreSQL)]
        Redis[(Redis)]
        BullMQ[BullMQ]
        Docker[Docker Compose]
    end

    Presentation --> Coordination
    PollingService --> Normalizers
    WebhookService --> Normalizers
    ImportUpload --> Normalizers
    Normalizers --> ChangeProcessor
    Coordination --> Producers
    Producers --> BullMQ
    BullMQ --> Async
    Async --> Business
    ChangeWorker --> ChangeProcessor
    ImportWorker --> ChangeProcessor
    ChangeProcessor --> Lock
    Business --> Tables
    Tables --> PostgreSQL
    Coordination --> ImportProgress
    ImportProgress --> Redis
    Redis --> SSE
    BullMQ --> Redis
    Docker --> PostgreSQL
    Docker --> Redis
~~~

**What this shows:** HTTP controllers and SSE endpoints coordinate application services. Queue producers hand work to BullMQ processors, which invoke domain normalization or `ChangeProcessor`. PostgreSQL-backed tables hold durable state and accounting.

**Important invariant:** The queue layer does not replace the business layer. `ChangeProcessor` and PostgreSQL decide accepted, duplicate, stale, and version-conflict outcomes.

**Failure behavior:** Redis failures affect enqueue or live progress delivery, while committed PostgreSQL state remains authoritative.

**Why this design:** Feature modules keep ingress, asynchronous work, correctness, persistence, and infrastructure responsibilities explicit.

**Relevant implementation:** `src/app.module.ts`, `src/worker.module.ts`, `src/modules/changes/`, `src/modules/queue/`, `src/modules/imports/`, `src/modules/outbox/`.

## 4. Unified Ingestion Architecture

~~~mermaid
flowchart LR
    Polling[PollingService] --> PollNorm[normalizePollingProductChange]
    Webhook[WebhookIngestionService] --> WebhookNorm[normalizeWebhookProductChange]
    Excel[ImportUploadService / ImportStreamingService] --> ExcelNorm[normalizeExcelProductChange<br/>row transform]

    PollNorm --> ProductChangeInput[ProductChangeInput]
    WebhookNorm --> ProductChangeInput
    ExcelNorm --> ProductChangeInput

    ProductChangeInput --> ChangeQueue[Change Queue<br/>cdms-change]
    Excel --> ImportQueue[Import Batch Queue<br/>cdms-import-batch]
    ImportQueue --> ImportWorker[ImportBatchQueueProcessor]
    ImportWorker --> ProductChangeInput
    ChangeQueue --> ChangeWorker[ChangeQueueProcessor]
    ChangeWorker --> Processor[ChangeProcessor]
    ImportWorker --> Processor
    Processor --> Transaction[(PostgreSQL transaction)]
~~~

**What this shows:** Polling and webhooks normalize directly into `ProductChangeInput` and the change queue. Excel rows are normalized into the same change contract inside the import-batch worker before calling `ChangeProcessor`.

**Important invariant:** There is one shared business-processing path even though the ingress queues differ.

**Failure behavior:** An accepted queue job can be retried or delivered again. The semantic result is resolved by PostgreSQL, not by BullMQ job deduplication.

**Why this design:** A common contract prevents source-specific business rules from drifting.

**Relevant implementation:** `src/modules/changes/product-change-contract.ts`, `src/modules/ingestion/polling-normalizer.ts`, `src/modules/ingestion/webhook-normalizer.ts`, `src/modules/imports/excel-row-normalizer.ts`.

## 5. Webhook Workflow

~~~mermaid
sequenceDiagram
    participant Client
    participant Controller as InventoryWebhookController
    participant Service as WebhookIngestionService
    participant Normalizer as normalizeWebhookProductChange
    participant Producer as ChangeQueueProducer
    participant Redis as Redis / BullMQ
    participant Worker as ChangeQueueProcessor
    participant Processor as ChangeProcessor
    participant DB as PostgreSQL

    Client->>Controller: POST /webhooks/inventory
    Controller->>Controller: Validate InventoryWebhookDto
    Controller->>Service: accept(dto)
    Service->>Normalizer: Normalize source=WEBHOOK
    Normalizer-->>Service: ProductChangeInput
    Service->>Producer: enqueueChange(input)
    Producer->>Redis: queue.add(cdms-change)
    alt Redis enqueue fails
        Redis-->>Producer: Error
        Producer-->>Service: Reject
        Service-->>Controller: ServiceUnavailableException
        Controller-->>Client: 503, not accepted
    else Redis accepts
        Redis-->>Producer: Job accepted
        Controller-->>Client: 202 ACCEPTED
    end
    Note over Client,Redis: 202 is queue acceptance, not business completion.
    Redis->>Worker: Deliver job
    Worker->>Processor: process(input)
    Processor->>DB: PostgreSQL transaction
    DB-->>Processor: Commit semantic result
    Processor-->>Worker: ACCEPTED / DUPLICATE / STALE / VERSION_CONFLICT
    Worker-->>Redis: Complete job
~~~

**What this shows:** Validation and normalization happen before `queue.add`. The API returns `202` only after Redis accepts the job. The worker later invokes `ChangeProcessor`.

**Important invariant:** HTTP acceptance is asynchronous enqueue acceptance; it is not a completed business transaction.

**Failure behavior:** A Redis enqueue error becomes a retriable `503`, so the API does not emit a false `202`. Later duplicate, stale, or conflict results are normal worker outcomes.

**Why this design:** The API remains responsive while the database correctness boundary stays inside the worker transaction.

**Relevant implementation:** `src/modules/ingestion/webhook.controller.ts`, `src/modules/ingestion/webhook-ingestion.service.ts`, `src/modules/ingestion/webhook-normalizer.ts`, `src/modules/queue/change-queue.producer.ts`, `src/modules/queue/processors/change-queue.processor.ts`.

## 6. Polling Workflow

~~~mermaid
sequenceDiagram
    participant Scheduler as PollingScheduler
    participant Service as PollingService
    participant Checkpoint as PollingCheckpointRepository
    participant Inventory as InventoryService
    participant DB as PostgreSQL
    participant Producer as ChangeQueueProducer
    participant Redis as Redis / BullMQ

    Scheduler->>Service: pollOnce() on interval
    Service->>Checkpoint: read(inventory-products)
    Checkpoint->>DB: SELECT checkpoint
    DB-->>Checkpoint: (updatedAt, productId) or none
    Checkpoint-->>Service: Composite cursor
    Service->>Inventory: list(updatedAfter, afterProductId)
    Inventory->>DB: Read ordered inventory page
    DB-->>Inventory: Page ordered by cursor
    Inventory-->>Service: InventoryProductResponse[]
    loop Each row in page
        Service->>Service: normalize source=POLLING
        Service->>Producer: enqueueChange(row)
        Producer->>Redis: queue.add(cdms-change)
        Redis-->>Producer: Accepted
    end
    alt Every row was accepted
        Service->>Checkpoint: write(last updatedAt, productId)
        Checkpoint->>DB: Upsert polling_checkpoints
        DB-->>Checkpoint: Commit
    else Any enqueue or checkpoint write fails
        Producer-->>Service: Error
        Service->>Service: Stop page / keep checkpoint unchanged
    end
~~~

**What this shows:** The scheduler reads the checkpoint, queries inventory using `(updatedAt, productId)`, enqueues each ordered row sequentially, and writes the checkpoint only after the page is accepted.

**Important invariant:** The checkpoint never advances past a page whose queue acceptance is incomplete.

**Failure behavior:** A failed enqueue leaves the checkpoint unchanged, so the next poll can reread the page. Re-read duplicates are safe downstream; a checkpoint write failure can also leave already-enqueued jobs to be replayed.

**Why this design:** The composite cursor gives stable ordering for equal timestamps, while PostgreSQL correctness makes replay safe.

**Relevant implementation:** `src/modules/ingestion/polling/polling.scheduler.ts`, `src/modules/ingestion/polling/polling.service.ts`, `src/modules/ingestion/polling/polling-checkpoint.repository.ts`, `src/modules/inventory/inventory.service.ts`.

## 7. Excel Import Workflow

~~~mermaid
flowchart TD
    Created[CREATED] --> Uploading[UPLOADING]
    Uploading --> Multipart[Multipart HTTP upload]
    Multipart --> Busboy[Busboy]
    Busboy --> Temp[Controlled temporary workbook.xlsx]
    Temp --> Yauzl[yauzl ZIP reader]
    Yauzl --> Metadata[workbook.xml / relationships / sharedStrings]
    Metadata --> Sax[sax worksheet XML parser]
    Sax --> Normalize[Row normalize and validate]
    Normalize --> Batch[Batch Transform]
    Batch --> ImportQueue[Import Batch Queue]
    ImportQueue --> Processing[PROCESSING]
    Processing --> Worker[ImportBatchQueueProcessor]
    Worker --> Change[ChangeProcessor per valid row]
    Change --> DB[(PostgreSQL)]
    Worker --> Accounting[ImportProgressService / import_batch_accounting]
    Accounting --> Status[Import job counters]
    Status --> Complete[COMPLETED]
    Status --> Failed[FAILED]
    Uploading -->|size, parser, header, or Redis timeout| Failed
    Processing -->|terminal producer/worker failure| Failed
~~~

**What this shows:** The upload is first streamed to a controlled temporary file. The staged XLSX is read as ZIP/XML streams, rows are normalized and batched, and batches enter BullMQ before the import worker applies each row.

**Important invariant:** The complete upload and workbook are not buffered as one in-memory object. `total_rows` and `enqueue_completed_at` describe producer completion; worker accounting owns terminal completion.

**Failure behavior:** Upload size, parser/header, and bounded Redis enqueue failures mark the import `FAILED`. Already queued batches are not distributed-transactionally rolled back.

**Why this design:** Disk staging makes the XLSX seekable for ZIP metadata while the row stream and queue writer preserve bounded backpressure.

**Relevant implementation:** `src/modules/imports/import-upload.service.ts`, `src/modules/imports/import-streaming.service.ts`, `src/modules/imports/internal-xlsx-streaming-reader.ts`, `src/modules/imports/excel-row-normalizer.ts`.

## 8. Excel Backpressure

~~~mermaid
flowchart LR
    XLSX[XLSX bytes on disk] --> Zip[yauzl entry stream]
    Zip --> SAX[sax parser]
    SAX --> Rows[Object-mode row stream]
    Rows --> RowTransform[ImportRowTransform]
    RowTransform --> BatchTransform[ImportBatchTransform]
    BatchTransform --> Writable[ImportBatchWritable]
    Writable -->|await queue.add| Redis[Redis / BullMQ]

    Redis -.->|pending or unavailable| Writable
    Writable -.->|callback unresolved| BatchTransform
    BatchTransform -.->|stops pulling| RowTransform
    RowTransform -.->|stops requesting rows| Rows
    Rows -.->|generator pauses| SAX
    SAX -.->|ZIP read slows| Zip
~~~

**What this shows:** `ImportBatchWritable` waits for each batch enqueue. An unresolved write callback propagates pressure upstream through the transforms, SAX parser, and ZIP stream.

**Important invariant:** There is no all-rows array and no unbounded promise queue ahead of Redis. The configured pending-batch bound and one unresolved writable operation keep the pipeline bounded.

**Failure behavior:** Redis retry is bounded by `IMPORT_REDIS_RETRY_TIMEOUT_MS`. When the timeout expires, the stream fails and the import is marked `FAILED`; rows already accepted may still remain queued.

**Why this design:** Backpressure is carried by Node streams instead of simulated progress or memory buffering. Shared strings can still consume memory proportional to the workbook shared-string table.

**Relevant implementation:** `src/modules/imports/import-streaming.service.ts`, especially `ImportBatchWritable`, `ImportBatchTransform`, and `UploadByteLimitTransform`; `src/modules/imports/internal-xlsx-streaming-reader.ts`.

## 9. ChangeProcessor / Exactly-Once Workflow

~~~mermaid
flowchart TD
    Input["Normalized ProductChangeInput"] --> Begin["BEGIN PostgreSQL transaction"]
    Begin --> Lock["pg_advisory_xact_lock(productId)"]
    Lock --> Fingerprint["Compute canonical fingerprint"]
    Fingerprint --> Read["Read product_state"]
    Read --> Current{"Current state?"}

    Current -->|none| Accept["ACCEPTED"]
    Current -->|exists| Version{"Incoming version compared with current"}

    Version -->|"incoming < current"| Stale["STALE"]
    Version -->|"incoming > current"| Accept
    Version -->|"same version"| SameFingerprint{"Fingerprint same?"}

    SameFingerprint -->|yes| Duplicate["DUPLICATE"]
    SameFingerprint -->|no| Conflict["VERSION_CONFLICT"]

    Accept --> History["Insert product_changes"]
    History --> State["Upsert product_state"]
    State --> Outbox["Insert outbox_events"]
    Outbox --> Commit["COMMIT"]

    Stale --> Finish["Finish without business-state writes"]
    Duplicate --> Finish
    Conflict --> Finish

    Commit --> Result["Return ACCEPTED"]
    Finish --> Result2["Return semantic result"]

    Defensive["UNIQUE product_changes(product_id, version)"]
        -. "defensive invariant" .-> History
~~~

**What this shows:** Every `ChangeProcessor.process` call opens a transaction, acquires a transaction-scoped advisory lock, computes the canonical fingerprint, reads current state, and chooses one semantic result.

**Important invariant:** For `ACCEPTED`, history, latest state, and outbox are committed together. `UNIQUE (product_id, version)` is defensive; the normal decision path is lock plus state comparison.

**Failure behavior:** `DUPLICATE`, `STALE`, and `VERSION_CONFLICT` return without business-state writes. Any accepted-path database error rolls back the transaction.

**Why this design:** The lock covers both existing rows and the missing-row first-write race, while canonical fingerprints distinguish exact replay from same-version conflicting data.

**Relevant implementation:** `src/modules/changes/change-processor.ts`, `src/modules/changes/product-lock.service.ts`, `src/modules/changes/product-canonicalization.ts`, `src/database/migrations/1760000000000-InitialCdmsSchema.ts`.

### Version decision table

| Current | Incoming | Fingerprint | Result |
| --- | --- | --- | --- |
| none | any valid version | any | `ACCEPTED` |
| v5 | v4 | any | `STALE` |
| v5 | v5 | same | `DUPLICATE` |
| v5 | v5 | different | `VERSION_CONFLICT` |
| v5 | v6 | any | `ACCEPTED` |

## 10. Concurrent Same-Product Processing

~~~mermaid
sequenceDiagram
    participant A as Worker A
    participant B as Worker B
    participant DB as PostgreSQL

    A->>DB: BEGIN
    A->>DB: pg_advisory_xact_lock(productId)
    B->>DB: BEGIN
    B->>DB: pg_advisory_xact_lock(productId)
    DB-->>A: Lock obtained
    DB-->>B: Waiting for same product lock
    A->>DB: Read state, decide, write, outbox
    A->>DB: COMMIT
    DB-->>B: Lock obtained after A commit
    B->>DB: Read new state
    B->>DB: Resolve DUPLICATE / STALE / VERSION_CONFLICT
    B->>DB: COMMIT without business-state writes
~~~

**What this shows:** Two workers processing the same product serialize on the same PostgreSQL transaction advisory lock. Worker B reads after Worker A commits.

**Important invariant:** The lock is acquired before reading `product_state`, so a product with no existing state row is serialized too.

**Failure behavior:** A rollback releases the transaction lock. A replayed job can try again and resolve against the committed state.

**Why this design:** It prevents first-write races, duplicate history/state writes, and silent last-writer-wins version conflicts. Different product IDs derive different advisory-lock keys and can process concurrently.

**Relevant implementation:** `src/modules/changes/product-lock.service.ts`, `src/modules/changes/change-processor.ts`, `src/modules/queue/processors/change-queue.processor.ts`.

## 11. Import Batch Worker Workflow

~~~mermaid
sequenceDiagram
    participant Queue as Import Batch Queue
    participant Worker as ImportBatchQueueProcessor
    participant Processor as ChangeProcessor
    participant Progress as ImportProgressService
    participant DB as PostgreSQL
    participant BullMQ as BullMQ retry

    Queue->>Worker: process(importId, batchId, rows)
    Worker->>Progress: isBatchAccounted(importId, batchId)
    alt Batch marker already exists
        Progress-->>Worker: true
        Worker-->>Queue: Return without recounting
    else Not accounted
        Progress-->>Worker: false
        loop Each row
            Worker->>Processor: process(row.change)
            alt Semantic result
                Processor-->>Worker: ACCEPTED / DUPLICATE / STALE / VERSION_CONFLICT
                Worker->>Worker: Count as processed and succeeded
            else Unexpected processing error
                Processor-->>Worker: Throw
                alt Attempts remain
                    Worker->>BullMQ: Throw whole batch for retry
                else Final attempt
                    Worker->>Worker: Count row as failed
                    Worker->>Worker: Continue remaining rows
                end
            end
        end
        Worker->>Progress: accountTerminalBatch(succeeded, failed)
        Progress->>DB: Insert marker and update counters
    end
~~~

**What this shows:** A batch is skipped if its durable accounting marker already exists. Each semantic `ChangeProcessor` result is a completed row outcome and counts as succeeded for import accounting; unexpected exceptions trigger whole-job retry until the final attempt.

**Important invariant:** Progress is counted only after the whole batch reaches a terminal outcome. Malformed rows are counted earlier by the streaming producer as readable, processed, and failed.

**Failure behavior:** Before the final BullMQ attempt, an exception throws the whole batch without accounting. On the final attempt, the failed row is logged and the processor continues the rest of the batch.

**Why this design:** Retrying a whole batch is safe for business state because `ChangeProcessor` is replay-tolerant, while durable batch accounting prevents counter duplication.

**Relevant implementation:** `src/modules/queue/processors/import-batch-queue.processor.ts`, `src/modules/imports/import-progress.service.ts`, `src/modules/imports/import-job.repository.ts`.

## 12. Import Progress Idempotency

~~~mermaid
flowchart TD
    FinishBatch[Worker finishes logical batch] --> Begin[BEGIN DB transaction]
    Begin --> Marker["INSERT import_batch_accounting(importId, batchId)"]
    Marker --> Existing{Marker inserted?}
    Existing -->|no, conflict| Already[Progress already accounted]
    Already --> CommitExisting[COMMIT / return accounted=false]
    Existing -->|yes| Counters[Increment rowsProcessed, rowsSucceeded, rowsFailed]
    Counters --> Completion[Evaluate completion condition]
    Completion --> Commit[COMMIT marker, counters, and status together]
    Commit --> Ack[Worker can acknowledge BullMQ job]
    Crash[Crash after DB commit before BullMQ ACK] --> Replay[Batch replay]
    Replay --> Marker
~~~

**What this shows:** `import_batch_accounting` is inserted with `ON CONFLICT DO NOTHING`. Only the insert winner updates import counters and evaluates completion.

**Important invariant:** The marker, counters, and completion decision commit in one PostgreSQL transaction. The equations `rowsProcessed = rowsSucceeded + rowsFailed` and `rowsProcessed <= rowsRead` remain valid.

**Failure behavior:** If the worker crashes after the database commit but before BullMQ acknowledgement, the replay sees the marker and does not increment counters again.

**Why this design:** Aggregate counters cannot identify a post-commit/pre-ack replay by themselves. This is progress idempotency, not the PostgreSQL Inbox Pattern and not message exactly-once delivery.

**Relevant implementation:** `src/modules/imports/import-job.repository.ts`, `src/modules/imports/entities/import-batch-accounting.entity.ts`, `src/database/migrations/1760000000001-ImportBatchAccounting.ts`.

## 13. Import Completion Workflow

~~~mermaid
flowchart TD
    Batch[Terminal batch accounting] --> Status{Import status}
    Status -->|PROCESSING| Conditions{"enqueue_completed_at IS NOT NULL<br/>and rowsProcessed = rowsRead"}
    Conditions -->|yes| Complete[Set COMPLETED and completed_at]
    Conditions -->|no| Continue[Remain PROCESSING]
    Status -->|FAILED| TerminalFailed[Remain FAILED]
    Complete --> Done[Terminal]
    TerminalFailed --> Done
    FailedGuard[FAILED status predicate] -. prevents .-> Complete
    Partial[COMPLETED can have rowsFailed > 0] --> Done
~~~

**What this shows:** A worker can set `COMPLETED` only while the import is `PROCESSING`, producer enqueue has completed, and all readable rows have terminal accounting.

**Important invariant:** `FAILED` is terminal for the completion update and cannot be resurrected to `COMPLETED`. A completed import may legitimately contain `rowsFailed > 0` for malformed or terminally failed rows.

**Failure behavior:** If enqueue has not completed or rows remain unprocessed, the job remains `PROCESSING`. Producer/parser/size/Redis-timeout failures mark it `FAILED`.

**Why this design:** Completion means the producer is finished and every row has a durable terminal outcome, not that every row was accepted by business correctness.

**Relevant implementation:** `src/modules/imports/import-job.repository.ts`, `src/modules/imports/entities/import-job.entity.ts`, `src/modules/imports/import-progress-read.service.ts`.

## 14. SSE Import Progress Workflow

~~~mermaid
sequenceDiagram
    participant Client as SSE Client
    participant SSE as ImportProgressReadService
    participant DB as PostgreSQL
    participant Live as Redis Pub/Sub
    participant Worker as ImportBatchQueueProcessor
    participant Progress as ImportProgressService

    Client->>SSE: GET /imports/:id/progress
    SSE->>Live: Subscribe before durable read
    SSE->>DB: Read latest import_jobs snapshot
    DB-->>SSE: Durable progress snapshot
    SSE-->>Client: progress initial snapshot

    Worker->>Progress: accountTerminalBatch(...)
    Progress->>DB: Commit accounting and counters
    DB-->>Progress: Durable snapshot
    Progress->>Live: HSET live snapshot
    Progress->>Live: PUBLISH progress event
    Live-->>SSE: Live snapshot
    SSE-->>Client: progress event

    alt Status becomes COMPLETED
        SSE-->>Client: completed event
        SSE-->>Client: Close connection
    else Status becomes FAILED
        SSE-->>Client: failed event
        SSE-->>Client: Close connection
    end
~~~

Note over Client,SSE: 
Reconnect reads latest PostgreSQL state; 
no event-history replay is required.

**What this shows:** The SSE service subscribes to Redis before reading PostgreSQL, emits the durable snapshot first, then forwards non-regressing Redis live hints. Terminal status emits `completed` or `failed` and closes the stream.

**Important invariant:** PostgreSQL is authoritative. Redis HSET/PUBLISH is a best-effort live acceleration and cannot roll back committed progress.

**Failure behavior:** A broken live Redis subscription closes that live view; a reconnect reads the latest durable PostgreSQL state. Client disconnect cleanup unsubscribes and disconnects the Redis subscriber.

**Why this design:** Subscribe-before-snapshot closes the setup race without adding durable event replay or an Inbox Pattern.

**Relevant implementation:** `src/modules/imports/imports.controller.ts`, `src/modules/imports/import-progress-read.service.ts`, `src/modules/imports/import-progress.service.ts`, `docs/en/sse-progress.md`.

## 15. Transactional Outbox: Business Transaction

~~~mermaid
flowchart LR
    Processor[ChangeProcessor] --> Begin[BEGIN transaction]
    Begin --> State[product_state]
    State --> History[product_changes]
    History --> Outbox[outbox_events]
    Outbox --> Commit[COMMIT all three together]
    Commit --> Accepted[Accepted business effect]
~~~

**What this shows:** The accepted change writes latest state, immutable change history, and a pending outbox event in one PostgreSQL transaction.

**Important invariant:** The database commit cannot succeed with only business state or only the outbox row from this transaction.

**Failure behavior:** An error in any accepted-path write rolls back the whole transaction. The pending outbox row is not lost after a successful commit.

**Why this design:** The transactional outbox closes the PostgreSQL-to-asynchronous-publication dual-write gap.

**Relevant implementation:** `src/modules/changes/change-processor.ts`, `src/modules/outbox/entities/outbox-event.entity.ts`, `src/database/migrations/1760000000000-InitialCdmsSchema.ts`.

## 16. Transactional Outbox: Publisher

~~~mermaid
sequenceDiagram
    participant Scheduler as OutboxPublisherScheduler
    participant Publisher as OutboxPublisherService
    participant DB as PostgreSQL
    participant Downstream as Downstream Queue
    participant Consumer as DownstreamOutboxProcessor

    Scheduler->>Publisher: publishBatch()
    Publisher->>DB: BEGIN
    Publisher->>DB: SELECT PENDING FOR UPDATE SKIP LOCKED
    DB-->>Publisher: Claimed events
    loop Each event
        Publisher->>Downstream: queue.add(cdms-downstream)
        alt Publish succeeds
            Publisher->>DB: Mark PUBLISHED
        else Publish fails
            Publisher->>DB: attempts + 1, keep PENDING
        end
    end
    Publisher->>DB: COMMIT
    Downstream->>Consumer: Deliver downstream job
    Consumer->>Consumer: Structured duplicate-tolerant logging
~~~

**What this shows:** The publisher claims pending rows with `FOR UPDATE SKIP LOCKED`, sends them to the downstream queue, and marks successful publications `PUBLISHED` in the same bounded transaction.

**Important invariant:** `SKIP LOCKED` prevents concurrent publisher scans from claiming the same pending row at once. The downstream consumer does not mutate business tables.

**Failure behavior:** If queue publication fails, the row remains `PENDING` with an incremented attempt count. If publication succeeds but the worker crashes before the database mark commits, the row remains pending and can publish a duplicate later.

**Why this design:** The outbox protects the database-to-queue handoff without claiming exactly-once delivery. Duplicate downstream log entries are an accepted prototype outcome.

**Relevant implementation:** `src/modules/outbox/outbox-publisher.repository.ts`, `src/modules/outbox/outbox-publisher.service.ts`, `src/modules/outbox/outbox-publisher.scheduler.ts`, `src/modules/queue/processors/downstream-outbox.processor.ts`.

## 17. Failure and Retry Workflows

### 17.1 Redis unavailable during webhook enqueue

~~~mermaid
flowchart LR
    Client[Webhook Client] --> API[Webhook API]
    API --> Producer[ChangeQueueProducer]
    Producer --> Redis{Redis available?}
    Redis -->|no| Error[queue.add fails]
    Error --> Response[HTTP 503]
    Redis -->|yes| Accepted[HTTP 202 after queue acceptance]
~~~

**What this shows:** The webhook API has a visible acceptance boundary at Redis queue insertion.

**Important invariant:** No Redis acceptance means no false asynchronous `202`.

**Failure behavior:** The caller can retry the `503`; semantic duplicate handling remains in the worker.

**Why this design:** It distinguishes dependency failure from invalid input and from later business outcomes.

### 17.2 Polling enqueue failure

~~~mermaid
flowchart LR
    Page[Read ordered poll page] --> Enqueue[Enqueue rows sequentially]
    Enqueue -->|one fails| Stop[Stop page]
    Stop --> Checkpoint[Checkpoint unchanged]
    Checkpoint --> Next[Next poll rereads page]
    Enqueue -->|all succeed| Advance["Write last (updatedAt, productId)"]
~~~

**What this shows:** Polling does not advance its cursor after a partial page enqueue.

**Important invariant:** The checkpoint represents the last completely accepted page, not the last row observed.

**Failure behavior:** Rereading can create duplicate queue deliveries, which are safe because `ChangeProcessor` resolves the business effect in PostgreSQL.

**Why this design:** It avoids silently losing changes when the queue dependency fails mid-page.

### 17.3 Database unavailable in a worker

~~~mermaid
flowchart LR
    Job[BullMQ job] --> Worker[Worker]
    Worker --> Tx[ChangeProcessor transaction]
    Tx --> DB{PostgreSQL available?}
    DB -->|no| Rollback[Transaction fails / rolls back]
    Rollback --> Throw[Worker throws]
    Throw --> Retry[BullMQ retry]
    DB -->|yes| Commit[Commit state, history, outbox]
~~~

**What this shows:** PostgreSQL is the correctness boundary for worker processing.

**Important invariant:** A failed transaction does not leave a partial accepted business effect.

**Failure behavior:** The worker throws so BullMQ can retry the job. The queue is not treated as a substitute for a committed database result.

**Why this design:** Retryable infrastructure failure remains visible instead of being converted into a successful but incomplete result.

### 17.4 Worker crash after database commit before queue acknowledgement

~~~mermaid
flowchart LR
    Worker[Worker] --> Commit[PostgreSQL commit]
    Commit --> Crash[Worker crashes before BullMQ ACK]
    Crash --> Replay[BullMQ job replay]
    Replay --> Processor[ChangeProcessor]
    Processor --> Duplicate[DUPLICATE / STALE / CONFLICT]
    Duplicate --> NoWrite[No second business-state write]
~~~

**What this shows:** A post-commit replay is expected in at-least-once queue processing.

**Important invariant:** PostgreSQL state, history, and outbox are not duplicated by replaying the same logical change.

**Failure behavior:** The replay completes with a semantic result instead of creating another business effect.

**Why this design:** Correctness comes from PostgreSQL locking, fingerprints, versions, and constraints, not queue delivery semantics.

### 17.5 Excel Redis timeout

~~~mermaid
flowchart LR
    Stream[XLSX stream] --> Writable[ImportBatchWritable]
    Writable --> Retry[Bounded queue.add retry]
    Retry --> Redis{Redis recovers before timeout?}
    Redis -->|yes| Queue[Import Batch Queue]
    Redis -->|no| Timeout[ImportEnqueueRetryTimeoutError]
    Timeout --> Failed[Mark import FAILED]
    Failed --> HTTP[HTTP 503]
    Queue --> Worker[Import worker]
~~~

**What this shows:** Excel ingestion keeps the stream write unresolved while retrying Redis, so upstream parsing slows instead of accumulating rows.

**Important invariant:** The retry timeout is bounded and the import records failure rather than hanging indefinitely.

**Failure behavior:** Batches acknowledged before the timeout may remain queued and are not distributed-transactionally rolled back.

**Why this design:** Backpressure and explicit failure preserve bounded resource use and make the dependency boundary observable.

**Relevant implementation:** `src/modules/imports/import-streaming.service.ts`, `src/modules/imports/import-upload.service.ts`, `src/modules/queue/import-batch-queue.producer.ts`.

## 18. Health / Dependency Workflow

~~~mermaid
flowchart TD
    Request[GET /health] --> Checks[HealthService]
    Checks --> PG[PostgreSQL SELECT 1]
    Checks --> Redis[Redis PING]
    PG --> Results[Promise.allSettled results]
    Redis --> Results
    Results --> Both{Both dependencies up?}
    Both -->|yes| OK[HTTP 200<br/>status=ok]
    Both -->|no| Unhealthy[HTTP 503<br/>status=error]
~~~

**What this shows:** The health service probes PostgreSQL and Redis independently and reports both dependency statuses.

**Important invariant:** A failure in one probe does not hide the status of the other. Health is readiness/dependency status, not a business mutation.

**Failure behavior:** One or both failed or timed-out probes yield HTTP `503`; both successful probes yield HTTP `200`.

**Why this design:** Operators can distinguish which required dependency is unavailable while keeping the endpoint bounded by probe timeouts.

**Relevant implementation:** `src/modules/health/health.controller.ts`, `src/modules/health/health.service.ts`, `src/modules/health/redis-health.probe.ts`.

## 19. Local k6 Spike Workflow

~~~mermaid
flowchart LR
    K6[k6: 100 VUs] --> API[Webhook API]
    API --> Queue[Redis / BullMQ waiting backlog]
    Queue --> Workers[Bounded workers: 10]
    Workers --> Processor[ChangeProcessor]
    Processor --> DB[(PostgreSQL)]
    DB --> Proof[State / history / outbox proof]

    Evidence[Developer-machine evidence<br/>not production benchmark or SLA] -.-> Proof
~~~

**What this shows:** The repository wrapper drives duplicate-heavy and stale webhook ingress through the API, observes queue pressure, waits for drain, and verifies PostgreSQL invariants.

**Important invariant:** The proof checks business-state correctness after the queue drains, not only HTTP response latency.

**Failure behavior:** The wrapper refuses to mix with an existing queue backlog and fails if the queue does not drain or database proof fails.

**Why this design:** It demonstrates bounded worker concurrency and duplicate/stale tolerance without presenting local measurements as production capacity.

**Verified local evidence:** 4,000 k6 ingress attempts, 4,000 accepted `202` responses, maximum waiting jobs 261, maximum active jobs 10, 100 `product_state` rows, 100 `product_changes` rows, 100 outbox rows, zero duplicate-version violations, and zero stale regressions. The separate 100-request baseline is included in the runner's total 4,100 attempts.

**Relevant implementation:** `load-tests/run-spike.mjs`, `load-tests/spike.js`, `load-tests/results/run-1788887228601-1abb3b45.json`, `src/modules/queue/processors/change-queue.processor.ts`.

## 20. End-to-End Interviewer View

~~~mermaid
flowchart LR
    Sources[Polling / Webhook / Excel] --> API[CDMS API / Scheduler]
    API --> Normalize[Source normalization]
    Normalize --> Queues[Redis / BullMQ<br/>Change Queue + Import Batch Queue]
    Queues --> Worker[Worker]
    Worker --> Processor[ChangeProcessor]
    Processor --> PG[(PostgreSQL<br/>state + history + outbox)]
    PG --> Outbox[Outbox Publisher]
    Outbox --> Downstream[Downstream Queue]
    Downstream --> Logger[Duplicate-tolerant downstream logger]

    Excel --> ImportProgress[Import accounting]
    ImportProgress --> PubSub[Redis Pub/Sub]
    PubSub --> SSE[SSE Client]
    PG --> ImportProgress
~~~

**What this shows:** Every source reaches the worker and `ChangeProcessor`; accepted business state, history, and outbox are committed in PostgreSQL. Excel progress has separate durable accounting plus a Redis Pub/Sub live view delivered through SSE.

**Important invariant:** PostgreSQL is authoritative for business state and durable import progress. Redis/BullMQ is asynchronous infrastructure, not the correctness boundary.

**Failure behavior:** Queue, worker, Redis Pub/Sub, or dependency failures are handled by explicit retry, replay, terminal failure, or reconnect behavior described above; no queue is labeled exactly-once delivery.

**Why this design:** This is the compact interview view: multiple ingress mechanisms, one correctness path, transactional outbox, and observable Excel progress.

**Relevant implementation:** `src/app.module.ts`, `src/worker.module.ts`, `src/modules/changes/`, `src/modules/queue/`, `src/modules/imports/`, `src/modules/outbox/`, `src/modules/health/`.

## Cross-reference

- [Architecture](architecture.md)
- [Exactly-once effect](exactly-once.md)
- [Failure handling](failure-handling.md)
- [Excel streaming](excel-streaming.md)
- [Transactional outbox](transactional-outbox.md)
- [SSE progress](sse-progress.md)
- [Testing](testing.md)
- [End-user and reviewer usage guide](usage-guide.md)
