# Các workflow CDMS

Tài liệu này giải thích CDMS prototype đã hoàn thiện theo từng mức độ, từ system context đến các workflow ingestion, correctness, retry, import, outbox, SSE và review chi tiết. Đây là tài liệu trực quan bổ sung cho architecture, failure handling, Excel streaming, transactional outbox, SSE, testing và usage guide.

Hệ thống đảm bảo exactly-once effect ở PostgreSQL/business level. Redis/BullMQ cùng cấp buffering, retry và concurrency có giới hạn; không đảm bảo exactly-once delivery.

## Định hướng theo mức độ

| Level | Diagram | Mục đích |
| --- | --- | --- |
| L1 | System Context | Hệ thống gồm những thành phần nào? |
| L2 | Deployment Topology | Process và container nào đang chạy? |
| L3 | Application Layers | Module nào sở hữu trách nhiệm nào? |
| L4 | Unified Ingestion | Polling, webhook và Excel hội tụ ra sao? |
| L5 | Correctness và Concurrency | Exactly-once effect được enforce như thế nào? |
| L6 | Detailed Workflows | Import, progress, SSE, outbox, health và failure chạy ra sao? |

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

**Diagram này thể hiện:** Dữ liệu inventory bên ngoài hoặc được emulated vào hệ thống qua scheduled polling, webhook hoặc Excel upload. CDMS dùng PostgreSQL cho business correctness bền vững và Redis/BullMQ cho asynchronous buffering.

**Invariant quan trọng:** Cả ba cơ chế ingress cuối cùng đều dùng cùng normalized change-processing path và PostgreSQL correctness path.

**Failure behavior:** Nếu Redis không nhận ingress job, API không được tuyên bố asynchronous acceptance. PostgreSQL vẫn là source of truth.

**Lý do thiết kế:** Prototype cần minh họa nhiều cơ chế ingestion mà không tạo nhiều business-processing implementation riêng.

**Implementation liên quan:** `src/app.module.ts`, `src/modules/ingestion/`, `src/modules/imports/`, `src/modules/queue/`, `src/database/`.

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

**Diagram này thể hiện:** Docker Compose chạy `cdms`, `worker`, `postgres` và `redis`. API và worker dùng cùng built image nhưng command khác nhau: `node dist/main.js` và `node dist/worker.js`.

**Invariant quan trọng:** Repository vẫn là một NestJS source project. Worker là runtime role riêng, không phải source split thành microservice.

**Failure behavior:** Compose đợi PostgreSQL và Redis health check trước khi khởi động API và worker. Worker restart không đồng nghĩa exactly-once delivery; replay vẫn an toàn vì PostgreSQL quyết định business effect.

**Lý do thiết kế:** Tách process role giúp HTTP/polling/upload không bị lẫn với asynchronous consumer trong khi vẫn giữ một codebase và một image.

**Implementation liên quan:** `docker-compose.yml`, `src/app.module.ts`, `src/worker.module.ts`, `src/main.ts`, `src/worker.ts`, `src/worker.bootstrap.ts`.

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

**Diagram này thể hiện:** HTTP controller và SSE endpoint điều phối application service. Queue producer giao work cho BullMQ processor, sau đó processor gọi domain normalization hoặc `ChangeProcessor`. Các table có PostgreSQL làm persistence cho state và accounting.

**Invariant quan trọng:** Queue layer không thay thế business layer. `ChangeProcessor` và PostgreSQL quyết định accepted, duplicate, stale và version-conflict.

**Failure behavior:** Redis failure ảnh hưởng enqueue hoặc live progress delivery, trong khi PostgreSQL state đã commit vẫn là authoritative.

**Lý do thiết kế:** Feature module giữ rõ ranh giới giữa ingress, async work, correctness, persistence và infrastructure.

**Implementation liên quan:** `src/app.module.ts`, `src/worker.module.ts`, `src/modules/changes/`, `src/modules/queue/`, `src/modules/imports/`, `src/modules/outbox/`.

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

**Diagram này thể hiện:** Polling và webhook normalize trực tiếp vào `ProductChangeInput` và change queue. Excel row được normalize về cùng change contract bên trong import-batch worker trước khi gọi `ChangeProcessor`.

**Invariant quan trọng:** Chỉ có một business-processing path chung cho các ingress queue khác nhau.

**Failure behavior:** Queue job đã chấp nhận có thể bị retry hoặc giao lại. Semantic result do PostgreSQL quyết định, không phải BullMQ job deduplication.

**Lý do thiết kế:** Common contract ngăn business rule theo từng source bị lệch nhau.

**Implementation liên quan:** `src/modules/changes/product-change-contract.ts`, `src/modules/ingestion/polling-normalizer.ts`, `src/modules/ingestion/webhook-normalizer.ts`, `src/modules/imports/excel-row-normalizer.ts`.

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

**Diagram này thể hiện:** Validation và normalization xảy ra trước `queue.add`. API trả `202` chỉ sau khi Redis chấp nhận job. Worker sau đó gọi `ChangeProcessor`.

**Invariant quan trọng:** HTTP acceptance là asynchronous enqueue acceptance, không phải business transaction đã hoàn tất.

**Failure behavior:** Redis enqueue error trở thành `503` có thể retry, vì vậy API không phát ra `202` giả. Duplicate, stale và conflict về sau là worker outcome hợp lệ.

**Lý do thiết kế:** API vẫn responsive trong khi database correctness boundary nằm trong worker transaction.

**Implementation liên quan:** `src/modules/ingestion/webhook.controller.ts`, `src/modules/ingestion/webhook-ingestion.service.ts`, `src/modules/ingestion/webhook-normalizer.ts`, `src/modules/queue/change-queue.producer.ts`, `src/modules/queue/processors/change-queue.processor.ts`.

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

**Diagram này thể hiện:** Scheduler đọc checkpoint, query inventory bằng `(updatedAt, productId)`, enqueue từng row theo thứ tự và chỉ ghi checkpoint sau khi cả page đã được chấp nhận.

**Invariant quan trọng:** Checkpoint không bao giờ advance qua một page có queue acceptance chưa hoàn tất.

**Failure behavior:** Enqueue failure giữ checkpoint cũ, vì vậy poll tiếp theo có thể đọc lại page. Duplicate do đọc lại an toàn ở downstream; checkpoint write failure cũng có thể để lại job đã enqueue để replay.

**Lý do thiết kế:** Composite cursor tạo thứ tự ổn định khi timestamp bằng nhau, còn PostgreSQL correctness làm cho replay an toàn.

**Implementation liên quan:** `src/modules/ingestion/polling/polling.scheduler.ts`, `src/modules/ingestion/polling/polling.service.ts`, `src/modules/ingestion/polling/polling-checkpoint.repository.ts`, `src/modules/inventory/inventory.service.ts`.

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

**Diagram này thể hiện:** Upload đầu tiên được streaming vào temporary file có kiểm soát. XLSX staged được đọc bằng ZIP/XML stream, row được normalize và batch, sau đó batch vào BullMQ trước khi import worker áp dụng từng row.

**Invariant quan trọng:** Toàn bộ upload và workbook không được buffer thành một object trong memory. `total_rows` và `enqueue_completed_at` mô tả producer completion; worker accounting sở hữu terminal completion.

**Failure behavior:** Upload size, parser/header và bounded Redis enqueue failure đánh dấu import `FAILED`. Batch đã queue không được rollback bằng distributed transaction.

**Lý do thiết kế:** Disk staging làm XLSX seekable cho ZIP metadata, trong khi row stream và queue writer giữ bounded backpressure.

**Implementation liên quan:** `src/modules/imports/import-upload.service.ts`, `src/modules/imports/import-streaming.service.ts`, `src/modules/imports/internal-xlsx-streaming-reader.ts`, `src/modules/imports/excel-row-normalizer.ts`.

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

**Diagram này thể hiện:** `ImportBatchWritable` chờ từng batch enqueue xong. Unresolved write callback đẩy backpressure ngược qua transform, SAX parser và ZIP stream.

**Invariant quan trọng:** Không có all-rows array và không có promise queue vô hạn trước Redis. Pending-batch bound và một unresolved writable operation giữ pipeline có giới hạn.

**Failure behavior:** Redis retry bị giới hạn bởi `IMPORT_REDIS_RETRY_TIMEOUT_MS`. Khi timeout, stream fail và import bị đánh dấu `FAILED`; batch đã chấp nhận vẫn có thể còn trong queue.

**Lý do thiết kế:** Backpressure được truyền bằng Node stream thay vì progress giả hoặc memory buffering. Shared strings vẫn có thể dùng memory tỷ lệ với shared-string table.

**Implementation liên quan:** `src/modules/imports/import-streaming.service.ts`, đặc biệt `ImportBatchWritable`, `ImportBatchTransform` và `UploadByteLimitTransform`; `src/modules/imports/internal-xlsx-streaming-reader.ts`.

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

**Diagram này thể hiện:** Mỗi lần `ChangeProcessor.process` mở transaction, lấy transaction-scoped advisory lock, tính canonical fingerprint, đọc current state và chọn semantic result.

**Invariant quan trọng:** Với `ACCEPTED`, history, latest state và outbox được commit cùng nhau. `UNIQUE (product_id, version)` là defensive invariant; decision path thông thường là lock kết hợp state comparison.

**Failure behavior:** `DUPLICATE`, `STALE` và `VERSION_CONFLICT` return mà không ghi business state. Database error trên accepted path rollback transaction.

**Lý do thiết kế:** Lock bao phủ cả existing row và missing-row first-write race; canonical fingerprint phân biệt replay giống hệt với conflict cùng version.

**Implementation liên quan:** `src/modules/changes/change-processor.ts`, `src/modules/changes/product-lock.service.ts`, `src/modules/changes/product-canonicalization.ts`, `src/database/migrations/1760000000000-InitialCdmsSchema.ts`.

### Bảng quyết định version

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

**Diagram này thể hiện:** Hai worker process cùng product sẽ serialize trên cùng PostgreSQL transaction advisory lock. Worker B chỉ đọc sau khi Worker A commit.

**Invariant quan trọng:** Lock được lấy trước khi đọc `product_state`, vì vậy product chưa có state row cũng được serialize.

**Failure behavior:** Rollback giải phóng transaction lock. Job replay có thể được xử lý lại và resolve theo committed state.

**Lý do thiết kế:** Cách này ngăn first-write race, duplicate history/state write và silent last-writer-wins version conflict. Product ID khác nhau tạo advisory-lock key khác nhau và có thể process đồng thời.

**Implementation liên quan:** `src/modules/changes/product-lock.service.ts`, `src/modules/changes/change-processor.ts`, `src/modules/queue/processors/change-queue.processor.ts`.

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

**Diagram này thể hiện:** Batch bị skip nếu accounting marker đã tồn tại. Mỗi semantic `ChangeProcessor` result là row outcome đã hoàn tất và được tính là succeeded cho import accounting; exception không mong đợi trigger whole-job retry cho đến attempt cuối.

**Invariant quan trọng:** Progress chỉ được count sau khi cả batch có terminal outcome. Malformed row được producer tính sớm là readable, processed và failed.

**Failure behavior:** Trước BullMQ final attempt, exception throw cả batch mà không account. Ở final attempt, row lỗi được log và processor tiếp tục các row còn lại.

**Lý do thiết kế:** Retry cả batch vẫn an toàn cho business state vì `ChangeProcessor` chịu được replay; durable batch accounting ngăn counter bị đếm trùng.

**Implementation liên quan:** `src/modules/queue/processors/import-batch-queue.processor.ts`, `src/modules/imports/import-progress.service.ts`, `src/modules/imports/import-job.repository.ts`.

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

**Diagram này thể hiện:** `import_batch_accounting` được insert bằng `ON CONFLICT DO NOTHING`. Chỉ transaction thắng insert mới update counter và đánh giá completion.

**Invariant quan trọng:** Marker, counter và completion decision commit trong cùng transaction PostgreSQL. Các equation `rowsProcessed = rowsSucceeded + rowsFailed` và `rowsProcessed <= rowsRead` vẫn hợp lệ.

**Failure behavior:** Nếu worker crash sau database commit nhưng trước BullMQ acknowledgement, replay thấy marker và không tăng counter lần nữa.

**Lý do thiết kế:** Aggregate counter không nhận ra được replay sau commit/trước ack. Đây là progress idempotency, không phải PostgreSQL Inbox Pattern và không phải exactly-once delivery.

**Implementation liên quan:** `src/modules/imports/import-job.repository.ts`, `src/modules/imports/entities/import-batch-accounting.entity.ts`, `src/database/migrations/1760000000001-ImportBatchAccounting.ts`.

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

**Diagram này thể hiện:** Worker chỉ set `COMPLETED` khi import đang `PROCESSING`, producer đã enqueue xong và mỗi readable row đều có terminal accounting.

**Invariant quan trọng:** `FAILED` là terminal trong completion update và không thể resurrect thành `COMPLETED`. Import completed vẫn có thể có `rowsFailed > 0` do malformed hoặc terminally failed row.

**Failure behavior:** Nếu enqueue chưa xong hoặc còn row chưa process, job vẫn ở `PROCESSING`. Producer/parser/size/Redis-timeout failure đánh dấu `FAILED`.

**Lý do thiết kế:** Completion có nghĩa producer đã xong và mỗi row có terminal outcome bền vững, không có nghĩa mỗi row đều accepted về business correctness.

**Implementation liên quan:** `src/modules/imports/import-job.repository.ts`, `src/modules/imports/entities/import-job.entity.ts`, `src/modules/imports/import-progress-read.service.ts`.

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

**Diagram này thể hiện:** SSE service subscribe Redis trước khi đọc PostgreSQL, emit durable snapshot trước, sau đó forward Redis live hint không regression. Terminal status emit `completed` hoặc `failed` và đóng stream.

**Invariant quan trọng:** PostgreSQL là authoritative. Redis HSET/PUBLISH chỉ là best-effort live acceleration và không thể rollback progress đã commit.

**Failure behavior:** Redis live subscription lỗi sẽ làm gián đoạn live view; reconnect đọc durable state mới nhất từ PostgreSQL. Client disconnect cleanup unsubscribe và disconnect Redis subscriber.

**Lý do thiết kế:** Subscribe-before-snapshot đồng thời xử lý setup race mà không cần durable event replay hoặc Inbox Pattern.

**Implementation liên quan:** `src/modules/imports/imports.controller.ts`, `src/modules/imports/import-progress-read.service.ts`, `src/modules/imports/import-progress.service.ts`, `docs/vi/sse-progress.md`.

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

**Diagram này thể hiện:** Accepted change ghi latest state, immutable change history và pending outbox event trong một PostgreSQL transaction.

**Invariant quan trọng:** Database commit không thể thành công với chỉ business state hoặc chỉ outbox row từ transaction này.

**Failure behavior:** Lỗi ở bất kỳ accepted-path write nào đều rollback cả transaction. Pending outbox row không mất sau commit thành công.

**Lý do thiết kế:** Transactional outbox đồng thời xử lý dual-write gap giữa PostgreSQL và asynchronous publication.

**Implementation liên quan:** `src/modules/changes/change-processor.ts`, `src/modules/outbox/entities/outbox-event.entity.ts`, `src/database/migrations/1760000000000-InitialCdmsSchema.ts`.

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

**Diagram này thể hiện:** Publisher claim pending row bằng `FOR UPDATE SKIP LOCKED`, gửi vào downstream queue và mark thành `PUBLISHED` trong bounded transaction.

**Invariant quan trọng:** `SKIP LOCKED` ngăn concurrent publisher scan claim cùng pending row cùng lúc. Downstream consumer không mutate business table.

**Failure behavior:** Queue publication fail thì row vẫn `PENDING` và tăng attempt. Nếu publication thành công nhưng worker crash trước khi database mark commit, row vẫn pending và có thể publish duplicate sau đó.

**Lý do thiết kế:** Outbox bảo vệ database-to-queue handoff mà không tuyên bố exactly-once delivery. Duplicate downstream log là kết quả được chấp nhận trong prototype.

**Implementation liên quan:** `src/modules/outbox/outbox-publisher.repository.ts`, `src/modules/outbox/outbox-publisher.service.ts`, `src/modules/outbox/outbox-publisher.scheduler.ts`, `src/modules/queue/processors/downstream-outbox.processor.ts`.

## 17. Failure và Retry Workflows

### 17.1 Redis không sẵn sàng khi webhook enqueue

~~~mermaid
flowchart LR
    Client[Webhook Client] --> API[Webhook API]
    API --> Producer[ChangeQueueProducer]
    Producer --> Redis{Redis available?}
    Redis -->|no| Error[queue.add fails]
    Error --> Response[HTTP 503]
    Redis -->|yes| Accepted[HTTP 202 after queue acceptance]
~~~

**Diagram này thể hiện:** Webhook API có acceptance boundary rõ ràng tại bước insert queue vào Redis.

**Invariant quan trọng:** Không có Redis acceptance thì không có asynchronous `202` giả.

**Failure behavior:** Caller có thể retry `503`; worker vẫn xử lý duplicate theo semantic rules.

**Lý do thiết kế:** Tách dependency failure khỏi invalid input và khỏi business outcome xảy ra về sau.

### 17.2 Polling enqueue failure

~~~mermaid
flowchart LR
    Page[Read ordered poll page] --> Enqueue[Enqueue rows sequentially]
    Enqueue -->|one fails| Stop[Stop page]
    Stop --> Checkpoint[Checkpoint unchanged]
    Checkpoint --> Next[Next poll rereads page]
    Enqueue -->|all succeed| Advance["Write last (updatedAt, productId)"]
~~~

**Diagram này thể hiện:** Polling không advance cursor sau partial page enqueue.

**Invariant quan trọng:** Checkpoint đại diện cho page cuối cùng được chấp nhận đầy đủ, không phải row cuối cùng đã quan sát.

**Failure behavior:** Đọc lại có thể tạo duplicate queue delivery, nhưng an toàn vì `ChangeProcessor` resolve business effect tại PostgreSQL.

**Lý do thiết kế:** Tránh mất change im lặng khi queue dependency lỗi giữa page.

### 17.3 Database không sẵn sàng trong worker

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

**Diagram này thể hiện:** PostgreSQL là correctness boundary chờ worker processing.

**Invariant quan trọng:** Transaction fail không để lại business effect accepted bị ghi một phần.

**Failure behavior:** Worker throw để BullMQ retry job. Queue không được xem là thay thế cho database result đã commit.

**Lý do thiết kế:** Infrastructure failure có thể retry vẫn được nhìn thấy, thay vì bị biến thành successful nhưng incomplete result.

### 17.4 Worker crash sau database commit và trước queue acknowledgement

~~~mermaid
flowchart LR
    Worker[Worker] --> Commit[PostgreSQL commit]
    Commit --> Crash[Worker crashes before BullMQ ACK]
    Crash --> Replay[BullMQ job replay]
    Replay --> Processor[ChangeProcessor]
    Processor --> Duplicate[DUPLICATE / STALE / CONFLICT]
    Duplicate --> NoWrite[No second business-state write]
~~~

**Diagram này thể hiện:** Post-commit replay là trường hợp dự kiến trong at-least-once queue processing.

**Invariant quan trọng:** PostgreSQL state, history và outbox không bị nhân đôi khi cùng logical change được replay.

**Failure behavior:** Replay kết thúc với semantic result thay vì tạo business effect thứ hai.

**Lý do thiết kế:** Correctness đến từ PostgreSQL lock, fingerprint, version và constraint, không đến từ queue delivery semantics.

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

**Diagram này thể hiện:** Excel ingestion giữ stream write chưa hoàn tất trong lúc retry Redis, vì vậy parser phía trước chậm lại thay vì tích lũy row.

**Invariant quan trọng:** Retry timeout có giới hạn và import ghi nhận failure thay vì treo vô hạn.

**Failure behavior:** Batch đã acknowledge trước timeout có thể vẫn còn trong queue và không được rollback bằng distributed transaction.

**Lý do thiết kế:** Backpressure và explicit failure giữ resource có giới hạn và làm dependency boundary quan sát được.

**Implementation liên quan:** `src/modules/imports/import-streaming.service.ts`, `src/modules/imports/import-upload.service.ts`, `src/modules/queue/import-batch-queue.producer.ts`.

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

**Diagram này thể hiện:** Health service probe PostgreSQL và Redis độc lập và báo cáo cả hai dependency status.

**Invariant quan trọng:** Probe một dependency lỗi không che status của dependency kia. Health là readiness/dependency status, không mutate business.

**Failure behavior:** Một hoặc cả hai probe fail/timeout trả HTTP `503`; cả hai probe thành công trả HTTP `200`.

**Lý do thiết kế:** Operator phân biệt được dependency nào không sẵn sàng trong khi endpoint vẫn có timeout giới hạn.

**Implementation liên quan:** `src/modules/health/health.controller.ts`, `src/modules/health/health.service.ts`, `src/modules/health/redis-health.probe.ts`.

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

**Diagram này thể hiện:** Repository wrapper đẩy duplicate-heavy và stale webhook ingress qua API, quan sát queue pressure, đợi queue drain và verify PostgreSQL invariants.

**Invariant quan trọng:** Proof kiểm tra business-state correctness sau khi queue drain, không chỉ do HTTP response latency.

**Failure behavior:** Wrapper từ chối chạy chung với queue backlog có sẵn và fail nếu queue không drain hoặc database proof fail.

**Lý do thiết kế:** Minh họa bounded worker concurrency và duplicate/stale tolerance mà không coi local measurement là production capacity.

**Local evidence đã verify:** 4,000 k6 ingress attempts, 4,000 response `202` accepted, maximum waiting jobs 261, maximum active jobs 10, 100 `product_state` row, 100 `product_changes` row, 100 outbox row, zero duplicate-version violation và zero stale regression. Baseline riêng 100 request được tính trong tổng 4,100 attempts của runner.

**Implementation liên quan:** `load-tests/run-spike.mjs`, `load-tests/spike.js`, `load-tests/results/run-1788887228601-1abb3b45.json`, `src/modules/queue/processors/change-queue.processor.ts`.

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

**Diagram này thể hiện:** Mỗi source đến worker và `ChangeProcessor`; business state, history và outbox được commit trong PostgreSQL. Excel progress có durable accounting riêng và Redis Pub/Sub live view được gửi qua SSE.

**Invariant quan trọng:** PostgreSQL authoritative cho business state và durable import progress. Redis/BullMQ là asynchronous infrastructure, không phải correctness boundary.

**Failure behavior:** Queue, worker, Redis Pub/Sub hoặc dependency failure được xử lý bằng retry, replay, terminal failure hoặc reconnect rõ ràng; không queue nào được gọi là exactly-once delivery.

**Lý do thiết kế:** Đây là interview view ngắn gọn: nhiều ingress mechanism, một correctness path, transactional outbox và Excel progress có thể quan sát.

**Implementation liên quan:** `src/app.module.ts`, `src/worker.module.ts`, `src/modules/changes/`, `src/modules/queue/`, `src/modules/imports/`, `src/modules/outbox/`, `src/modules/health/`.

## Cross-reference

- [Architecture](architecture.md)
- [Exactly-once effect](exactly-once.md)
- [Failure handling](failure-handling.md)
- [Excel streaming](excel-streaming.md)
- [Transactional outbox](transactional-outbox.md)
- [SSE progress](sse-progress.md)
- [Testing](testing.md)
- [Hướng dẫn sử dụng cho người dùng và reviewer](usage-guide.md)
