# Cac workflow CDMS

Tai lieu nay giai thich CDMS prototype da hoan thien theo tung muc do, tu system context den cac workflow ingestion, correctness, retry, import, outbox, SSE va review chi tiet. Day la tai lieu truc quan bo sung cho architecture, failure handling, Excel streaming, transactional outbox, SSE, testing va usage guide.

He thong dam bao exactly-once effect o PostgreSQL/business level. Redis/BullMQ cung cap buffering, retry va concurrency co gioi han; khong dam bao exactly-once delivery.

## Dinh huong theo muc do

| Level | Diagram | Muc dich |
| --- | --- | --- |
| L1 | System Context | He thong gom nhung thanh phan nao? |
| L2 | Deployment Topology | Process va container nao dang chay? |
| L3 | Application Layers | Module nao so huu trach nhiem nao? |
| L4 | Unified Ingestion | Polling, webhook va Excel hoi tu ra sao? |
| L5 | Correctness va Concurrency | Exactly-once effect duoc enforce nhu the nao? |
| L6 | Detailed Workflows | Import, progress, SSE, outbox, health va failure chay ra sao? |

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

**Diagram nay the hien:** Du lieu inventory ben ngoai hoac duoc emulated vao he thong qua scheduled polling, webhook hoac Excel upload. CDMS dung PostgreSQL cho business correctness ben vung va Redis/BullMQ cho asynchronous buffering.

**Invariant quan trong:** Ca ba co che ingress cuoi cung deu dung cung normalized change-processing path va PostgreSQL correctness path.

**Failure behavior:** Neu Redis khong nhan ingress job, API khong duoc tuyen bo asynchronous acceptance. PostgreSQL van la source of truth.

**Ly do thiet ke:** Prototype can minh hoa nhieu co che ingestion ma khong tao nhieu business-processing implementation rieng.

**Implementation lien quan:** `src/app.module.ts`, `src/modules/ingestion/`, `src/modules/imports/`, `src/modules/queue/`, `src/database/`.

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

**Diagram nay the hien:** Docker Compose chay `cdms`, `worker`, `postgres` va `redis`. API va worker dung cung built image nhung command khac nhau: `node dist/main.js` va `node dist/worker.js`.

**Invariant quan trong:** Repository van la mot NestJS source project. Worker la runtime role rieng, khong phai source split thanh microservice.

**Failure behavior:** Compose doi PostgreSQL va Redis health check truoc khi khoi dong API va worker. Worker restart khong dong nghia exactly-once delivery; replay van an toan vi PostgreSQL quyet dinh business effect.

**Ly do thiet ke:** Tach process role giup HTTP/polling/upload khong bi lan voi asynchronous consumer trong khi van giu mot codebase va mot image.

**Implementation lien quan:** `docker-compose.yml`, `src/app.module.ts`, `src/worker.module.ts`, `src/main.ts`, `src/worker.ts`, `src/worker.bootstrap.ts`.

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

**Diagram nay the hien:** HTTP controller va SSE endpoint dieu phoi application service. Queue producer giao work cho BullMQ processor, sau do processor goi domain normalization hoac `ChangeProcessor`. Cac table co PostgreSQL lam persistence cho state va accounting.

**Invariant quan trong:** Queue layer khong thay the business layer. `ChangeProcessor` va PostgreSQL quyet dinh accepted, duplicate, stale va version-conflict.

**Failure behavior:** Redis failure anh huong enqueue hoac live progress delivery, trong khi PostgreSQL state da commit van la authoritative.

**Ly do thiet ke:** Feature module giu ro ranh gioi giua ingress, async work, correctness, persistence va infrastructure.

**Implementation lien quan:** `src/app.module.ts`, `src/worker.module.ts`, `src/modules/changes/`, `src/modules/queue/`, `src/modules/imports/`, `src/modules/outbox/`.

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

**Diagram nay the hien:** Polling va webhook normalize truc tiep vao `ProductChangeInput` va change queue. Excel row duoc normalize ve cung change contract ben trong import-batch worker truoc khi goi `ChangeProcessor`.

**Invariant quan trong:** Chi co mot business-processing path chung du cac ingress queue khac nhau.

**Failure behavior:** Queue job da chap nhan co the bi retry hoac giao lai. Semantic result do PostgreSQL quyet dinh, khong phai BullMQ job deduplication.

**Ly do thiet ke:** Common contract ngan business rule theo tung source bi lech nhau.

**Implementation lien quan:** `src/modules/changes/product-change-contract.ts`, `src/modules/ingestion/polling-normalizer.ts`, `src/modules/ingestion/webhook-normalizer.ts`, `src/modules/imports/excel-row-normalizer.ts`.

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

**Diagram nay the hien:** Validation va normalization xay ra truoc `queue.add`. API tra `202` chi sau khi Redis chap nhan job. Worker sau do goi `ChangeProcessor`.

**Invariant quan trong:** HTTP acceptance la asynchronous enqueue acceptance, khong phai business transaction da hoan tat.

**Failure behavior:** Redis enqueue error tro thanh `503` co the retry, vi vay API khong phat ra `202` gia. Duplicate, stale va conflict ve sau la worker outcome hop le.

**Ly do thiet ke:** API van responsive trong khi database correctness boundary nam trong worker transaction.

**Implementation lien quan:** `src/modules/ingestion/webhook.controller.ts`, `src/modules/ingestion/webhook-ingestion.service.ts`, `src/modules/ingestion/webhook-normalizer.ts`, `src/modules/queue/change-queue.producer.ts`, `src/modules/queue/processors/change-queue.processor.ts`.

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

**Diagram nay the hien:** Scheduler doc checkpoint, query inventory bang `(updatedAt, productId)`, enqueue tung row theo thu tu va chi ghi checkpoint sau khi ca page da duoc chap nhan.

**Invariant quan trong:** Checkpoint khong bao gio advance qua mot page co queue acceptance chua hoan tat.

**Failure behavior:** Enqueue failure giu checkpoint cu, vi vay poll tiep theo co the doc lai page. Duplicate do doc lai an toan o downstream; checkpoint write failure cung co the de lai job da enqueue de replay.

**Ly do thiet ke:** Composite cursor tao thu tu on dinh khi timestamp bang nhau, con PostgreSQL correctness lam cho replay an toan.

**Implementation lien quan:** `src/modules/ingestion/polling/polling.scheduler.ts`, `src/modules/ingestion/polling/polling.service.ts`, `src/modules/ingestion/polling/polling-checkpoint.repository.ts`, `src/modules/inventory/inventory.service.ts`.

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

**Diagram nay the hien:** Upload dau tien duoc streaming vao temporary file co kiem soat. XLSX staged duoc doc bang ZIP/XML stream, row duoc normalize va batch, sau do batch vao BullMQ truoc khi import worker ap dung tung row.

**Invariant quan trong:** Toan bo upload va workbook khong duoc buffer thanh mot object trong memory. `total_rows` va `enqueue_completed_at` mo ta producer completion; worker accounting so huu terminal completion.

**Failure behavior:** Upload size, parser/header va bounded Redis enqueue failure danh dau import `FAILED`. Batch da queue khong duoc rollback bang distributed transaction.

**Ly do thiet ke:** Disk staging lam XLSX seekable cho ZIP metadata, trong khi row stream va queue writer giu bounded backpressure.

**Implementation lien quan:** `src/modules/imports/import-upload.service.ts`, `src/modules/imports/import-streaming.service.ts`, `src/modules/imports/internal-xlsx-streaming-reader.ts`, `src/modules/imports/excel-row-normalizer.ts`.

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

**Diagram nay the hien:** `ImportBatchWritable` cho tung batch enqueue xong. Unresolved write callback day backpressure nguoc qua transform, SAX parser va ZIP stream.

**Invariant quan trong:** Khong co all-rows array va khong co promise queue vo han truoc Redis. Pending-batch bound va mot unresolved writable operation giu pipeline co gioi han.

**Failure behavior:** Redis retry bi gioi han boi `IMPORT_REDIS_RETRY_TIMEOUT_MS`. Khi timeout, stream fail va import bi danh dau `FAILED`; batch da chap nhan van co the con trong queue.

**Ly do thiet ke:** Backpressure duoc truyen bang Node stream thay vi progress gia hoac memory buffering. Shared strings van co the dung memory ty le voi shared-string table.

**Implementation lien quan:** `src/modules/imports/import-streaming.service.ts`, dac biet `ImportBatchWritable`, `ImportBatchTransform` va `UploadByteLimitTransform`; `src/modules/imports/internal-xlsx-streaming-reader.ts`.

## 9. ChangeProcessor / Exactly-Once Workflow

~~~mermaid
flowchart TD
    Input[Normalized ProductChangeInput] --> Begin[BEGIN PostgreSQL transaction]
    Begin --> Lock[pg_advisory_xact_lock(productId)]
    Lock --> Fingerprint[Compute canonical fingerprint]
    Fingerprint --> Read[Read product_state]
    Read --> Current{Current state?}

    Current -->|none| Accept[ACCEPTED]
    Current -->|exists| Version{Incoming version compared with current}

    Version -->|incoming < current| Stale[STALE]
    Version -->|incoming > current| Accept
    Version -->|same version| SameFingerprint{Fingerprint same?}
    SameFingerprint -->|yes| Duplicate[DUPLICATE]
    SameFingerprint -->|no| Conflict[VERSION_CONFLICT]

    Accept --> History[Insert product_changes]
    History --> State[Upsert product_state]
    State --> Outbox[Insert outbox_events]
    Outbox --> Commit[COMMIT]
    Stale --> Finish[Finish without business-state writes]
    Duplicate --> Finish
    Conflict --> Finish
    Commit --> Result[Return ACCEPTED]
    Finish --> Result2[Return semantic result]
    Defensive[UNIQUE product_changes(product_id, version)] -. defensive invariant .-> History
~~~

**Diagram nay the hien:** Moi lan `ChangeProcessor.process` mo transaction, lay transaction-scoped advisory lock, tinh canonical fingerprint, doc current state va chon semantic result.

**Invariant quan trong:** Voi `ACCEPTED`, history, latest state va outbox duoc commit cung nhau. `UNIQUE (product_id, version)` la defensive invariant; decision path thong thuong la lock ket hop state comparison.

**Failure behavior:** `DUPLICATE`, `STALE` va `VERSION_CONFLICT` return ma khong ghi business state. Database error tren accepted path rollback transaction.

**Ly do thiet ke:** Lock bao phu ca existing row va missing-row first-write race; canonical fingerprint phan biet replay giong het voi conflict cung version.

**Implementation lien quan:** `src/modules/changes/change-processor.ts`, `src/modules/changes/product-lock.service.ts`, `src/modules/changes/product-canonicalization.ts`, `src/database/migrations/1760000000000-InitialCdmsSchema.ts`.

### Bang quyet dinh version

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

**Diagram nay the hien:** Hai worker process cung product se serialize tren cung PostgreSQL transaction advisory lock. Worker B chi doc sau khi Worker A commit.

**Invariant quan trong:** Lock duoc lay truoc khi doc `product_state`, vi vay product chua co state row cung duoc serialize.

**Failure behavior:** Rollback release transaction lock. Job replay co the thu lai va resolve theo committed state.

**Ly do thiet ke:** Cach nay ngan first-write race, duplicate history/state write va silent last-writer-wins version conflict. Product ID khac nhau tao advisory-lock key khac nhau va co the process dong thoi.

**Implementation lien quan:** `src/modules/changes/product-lock.service.ts`, `src/modules/changes/change-processor.ts`, `src/modules/queue/processors/change-queue.processor.ts`.

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

**Diagram nay the hien:** Batch bi skip neu accounting marker da ton tai. Moi semantic `ChangeProcessor` result la row outcome da hoan tat va duoc tinh la succeeded cho import accounting; exception khong mong doi trigger whole-job retry cho den attempt cuoi.

**Invariant quan trong:** Progress chi duoc count sau khi ca batch co terminal outcome. Malformed row duoc producer tinh som la readable, processed va failed.

**Failure behavior:** Truoc BullMQ final attempt, exception throw ca batch ma khong account. O final attempt, row loi duoc log va processor tiep tuc cac row con lai.

**Ly do thiet ke:** Retry ca batch van an toan cho business state vi `ChangeProcessor` chiu duoc replay; durable batch accounting ngan counter bi dem trung.

**Implementation lien quan:** `src/modules/queue/processors/import-batch-queue.processor.ts`, `src/modules/imports/import-progress.service.ts`, `src/modules/imports/import-job.repository.ts`.

## 12. Import Progress Idempotency

~~~mermaid
flowchart TD
    FinishBatch[Worker finishes logical batch] --> Begin[BEGIN DB transaction]
    Begin --> Marker[INSERT import_batch_accounting(importId, batchId)]
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

**Diagram nay the hien:** `import_batch_accounting` duoc insert bang `ON CONFLICT DO NOTHING`. Chi transaction thang insert moi update counter va danh gia completion.

**Invariant quan trong:** Marker, counter va completion decision commit trong cung transaction PostgreSQL. Cac equation `rowsProcessed = rowsSucceeded + rowsFailed` va `rowsProcessed <= rowsRead` van hop le.

**Failure behavior:** Neu worker crash sau database commit nhung truoc BullMQ acknowledgement, replay thay marker va khong tang counter lan nua.

**Ly do thiet ke:** Aggregate counter khong nhan ra duoc replay sau commit/truoc ack. Day la progress idempotency, khong phai PostgreSQL Inbox Pattern va khong phai exactly-once delivery.

**Implementation lien quan:** `src/modules/imports/import-job.repository.ts`, `src/modules/imports/entities/import-batch-accounting.entity.ts`, `src/database/migrations/1760000000001-ImportBatchAccounting.ts`.

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

**Diagram nay the hien:** Worker chi set `COMPLETED` khi import dang `PROCESSING`, producer da enqueue xong va moi readable row deu co terminal accounting.

**Invariant quan trong:** `FAILED` la terminal trong completion update va khong the resurrect thanh `COMPLETED`. Import completed van co the co `rowsFailed > 0` do malformed hoac terminally failed row.

**Failure behavior:** Neu enqueue chua xong hoac con row chua process, job van o `PROCESSING`. Producer/parser/size/Redis-timeout failure danh dau `FAILED`.

**Ly do thiet ke:** Completion co nghia producer da xong va moi row co terminal outcome ben vung, khong co nghia moi row deu accepted ve business correctness.

**Implementation lien quan:** `src/modules/imports/import-job.repository.ts`, `src/modules/imports/entities/import-job.entity.ts`, `src/modules/imports/import-progress-read.service.ts`.

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

    Note over Client,SSE: Reconnect reads latest PostgreSQL state; no event-history replay is required.
~~~

**Diagram nay the hien:** SSE service subscribe Redis truoc khi doc PostgreSQL, emit durable snapshot truoc, sau do forward Redis live hint khong regression. Terminal status emit `completed` hoac `failed` va dong stream.

**Invariant quan trong:** PostgreSQL la authoritative. Redis HSET/PUBLISH chi la best-effort live acceleration va khong the rollback progress da commit.

**Failure behavior:** Redis live subscription loi se dong live view; reconnect doc durable state moi nhat tu PostgreSQL. Client disconnect cleanup unsubscribe va disconnect Redis subscriber.

**Ly do thiet ke:** Subscribe-before-snapshot dong setup race ma khong can durable event replay hoac Inbox Pattern.

**Implementation lien quan:** `src/modules/imports/imports.controller.ts`, `src/modules/imports/import-progress-read.service.ts`, `src/modules/imports/import-progress.service.ts`, `docs/vi/sse-progress.md`.

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

**Diagram nay the hien:** Accepted change ghi latest state, immutable change history va pending outbox event trong mot PostgreSQL transaction.

**Invariant quan trong:** Database commit khong the thanh cong voi chi business state hoac chi outbox row tu transaction nay.

**Failure behavior:** Loi o bat ky accepted-path write nao deu rollback ca transaction. Pending outbox row khong mat sau commit thanh cong.

**Ly do thiet ke:** Transactional outbox dong dual-write gap giua PostgreSQL va asynchronous publication.

**Implementation lien quan:** `src/modules/changes/change-processor.ts`, `src/modules/outbox/entities/outbox-event.entity.ts`, `src/database/migrations/1760000000000-InitialCdmsSchema.ts`.

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

**Diagram nay the hien:** Publisher claim pending row bang `FOR UPDATE SKIP LOCKED`, gui vao downstream queue va mark thanh `PUBLISHED` trong bounded transaction.

**Invariant quan trong:** `SKIP LOCKED` ngan concurrent publisher scan claim cung pending row cung luc. Downstream consumer khong mutate business table.

**Failure behavior:** Queue publication fail thi row van `PENDING` va tang attempt. Neu publication thanh cong nhung worker crash truoc khi database mark commit, row van pending va co the publish duplicate sau do.

**Ly do thiet ke:** Outbox bao ve database-to-queue handoff ma khong tuyen bo exactly-once delivery. Duplicate downstream log la ket qua duoc chap nhan trong prototype.

**Implementation lien quan:** `src/modules/outbox/outbox-publisher.repository.ts`, `src/modules/outbox/outbox-publisher.service.ts`, `src/modules/outbox/outbox-publisher.scheduler.ts`, `src/modules/queue/processors/downstream-outbox.processor.ts`.

## 17. Failure va Retry Workflows

### 17.1 Redis khong san sang khi webhook enqueue

~~~mermaid
flowchart LR
    Client[Webhook Client] --> API[Webhook API]
    API --> Producer[ChangeQueueProducer]
    Producer --> Redis{Redis available?}
    Redis -->|no| Error[queue.add fails]
    Error --> Response[HTTP 503]
    Redis -->|yes| Accepted[HTTP 202 after queue acceptance]
~~~

**Diagram nay the hien:** Webhook API co acceptance boundary ro rang tai buoc insert queue vao Redis.

**Invariant quan trong:** Khong co Redis acceptance thi khong co asynchronous `202` gia.

**Failure behavior:** Caller co the retry `503`; worker van xu ly duplicate theo semantic rules.

**Ly do thiet ke:** Tach dependency failure khoi invalid input va khoi business outcome xay ra ve sau.

### 17.2 Polling enqueue failure

~~~mermaid
flowchart LR
    Page[Read ordered poll page] --> Enqueue[Enqueue rows sequentially]
    Enqueue -->|one fails| Stop[Stop page]
    Stop --> Checkpoint[Checkpoint unchanged]
    Checkpoint --> Next[Next poll rereads page]
    Enqueue -->|all succeed| Advance[Write last (updatedAt, productId)]
~~~

**Diagram nay the hien:** Polling khong advance cursor sau partial page enqueue.

**Invariant quan trong:** Checkpoint dai dien cho page cuoi cung duoc chap nhan day du, khong phai row cuoi cung da quan sat.

**Failure behavior:** Doc lai co the tao duplicate queue delivery, nhung an toan vi `ChangeProcessor` resolve business effect tai PostgreSQL.

**Ly do thiet ke:** Tranh mat change im lang khi queue dependency loi giua page.

### 17.3 Database khong san sang trong worker

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

**Diagram nay the hien:** PostgreSQL la correctness boundary cho worker processing.

**Invariant quan trong:** Transaction fail khong de lai business effect accepted bi ghi mot phan.

**Failure behavior:** Worker throw de BullMQ retry job. Queue khong duoc xem la thay the cho database result da commit.

**Ly do thiet ke:** Infrastructure failure co the retry van duoc nhin thay, thay vi bi bien thanh successful nhung incomplete result.

### 17.4 Worker crash sau database commit va truoc queue acknowledgement

~~~mermaid
flowchart LR
    Worker[Worker] --> Commit[PostgreSQL commit]
    Commit --> Crash[Worker crashes before BullMQ ACK]
    Crash --> Replay[BullMQ job replay]
    Replay --> Processor[ChangeProcessor]
    Processor --> Duplicate[DUPLICATE / STALE / CONFLICT]
    Duplicate --> NoWrite[No second business-state write]
~~~

**Diagram nay the hien:** Post-commit replay la truong hop du kien trong at-least-once queue processing.

**Invariant quan trong:** PostgreSQL state, history va outbox khong bi nhan doi khi cung logical change duoc replay.

**Failure behavior:** Replay ket thuc voi semantic result thay vi tao business effect thu hai.

**Ly do thiet ke:** Correctness den tu PostgreSQL lock, fingerprint, version va constraint, khong den tu queue delivery semantics.

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

**Diagram nay the hien:** Excel ingestion giu stream write chua hoan tat trong luc retry Redis, vi vay parser phia truoc cham lai thay vi tich luy row.

**Invariant quan trong:** Retry timeout co gioi han va import ghi nhan failure thay vi treo vo han.

**Failure behavior:** Batch da acknowledge truoc timeout co the van con trong queue va khong duoc rollback bang distributed transaction.

**Ly do thiet ke:** Backpressure va explicit failure giu resource co gioi han va lam dependency boundary quan sat duoc.

**Implementation lien quan:** `src/modules/imports/import-streaming.service.ts`, `src/modules/imports/import-upload.service.ts`, `src/modules/queue/import-batch-queue.producer.ts`.

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

**Diagram nay the hien:** Health service probe PostgreSQL va Redis doc lap va bao cao ca hai dependency status.

**Invariant quan trong:** Probe mot dependency loi khong che status cua dependency kia. Health la readiness/dependency status, khong mutate business.

**Failure behavior:** Mot hoac ca hai probe fail/timeout tra HTTP `503`; ca hai probe thanh cong tra HTTP `200`.

**Ly do thiet ke:** Operator phan biet duoc dependency nao khong san sang trong khi endpoint van co timeout gioi han.

**Implementation lien quan:** `src/modules/health/health.controller.ts`, `src/modules/health/health.service.ts`, `src/modules/health/redis-health.probe.ts`.

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

**Diagram nay the hien:** Repository wrapper day duplicate-heavy va stale webhook ingress qua API, quan sat queue pressure, doi queue drain va verify PostgreSQL invariants.

**Invariant quan trong:** Proof kiem tra business-state correctness sau khi queue drain, khong chi do HTTP response latency.

**Failure behavior:** Wrapper tu choi chay chung voi queue backlog co san va fail neu queue khong drain hoac database proof fail.

**Ly do thiet ke:** Minh hoa bounded worker concurrency va duplicate/stale tolerance ma khong coi local measurement la production capacity.

**Local evidence da verify:** 4,000 k6 ingress attempts, 4,000 response `202` accepted, maximum waiting jobs 261, maximum active jobs 10, 100 `product_state` row, 100 `product_changes` row, 100 outbox row, zero duplicate-version violation va zero stale regression. Baseline rieng 100 request duoc tinh trong tong 4,100 attempts cua runner.

**Implementation lien quan:** `load-tests/run-spike.mjs`, `load-tests/spike.js`, `load-tests/results/run-1788887228601-1abb3b45.json`, `src/modules/queue/processors/change-queue.processor.ts`.

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

**Diagram nay the hien:** Moi source den worker va `ChangeProcessor`; business state, history va outbox duoc commit trong PostgreSQL. Excel progress co durable accounting rieng va Redis Pub/Sub live view duoc gui qua SSE.

**Invariant quan trong:** PostgreSQL authoritative cho business state va durable import progress. Redis/BullMQ la asynchronous infrastructure, khong phai correctness boundary.

**Failure behavior:** Queue, worker, Redis Pub/Sub hoac dependency failure duoc xu ly bang retry, replay, terminal failure hoac reconnect ro rang; khong queue nao duoc goi la exactly-once delivery.

**Ly do thiet ke:** Day la interview view ngan gon: nhieu ingress mechanism, mot correctness path, transactional outbox va Excel progress co the quan sat.

**Implementation lien quan:** `src/app.module.ts`, `src/worker.module.ts`, `src/modules/changes/`, `src/modules/queue/`, `src/modules/imports/`, `src/modules/outbox/`, `src/modules/health/`.

## Cross-reference

- [Architecture](architecture.md)
- [Exactly-once effect](exactly-once.md)
- [Failure handling](failure-handling.md)
- [Excel streaming](excel-streaming.md)
- [Transactional outbox](transactional-outbox.md)
- [SSE progress](sse-progress.md)
- [Testing](testing.md)
- [Huong dan su dung cho nguoi dung va reviewer](usage-guide.md)
