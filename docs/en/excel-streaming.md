# Excel Streaming

## Implemented pipeline

The upload is intentionally two-phase:

```text
Phase A: multipart Busboy -> byte-limited controlled temporary file
Phase B: temp XLSX -> yauzl ZIP streams -> sax XML parser -> Node row stream
         -> row normalization -> bounded batches -> BullMQ Writable
```

Busboy accepts exactly one `file` field. The client filename is sanitized and is never used as a filesystem path. The server creates a unique directory under the OS temporary directory and stages bytes through a transform that enforces `IMPORT_MAX_FILE_SIZE_MB` (default 100) while writing. The directory is removed in `finally` on success and failure.

The internal reader resolves the first worksheet through workbook relationships, reads shared strings when present, and parses worksheet rows incrementally. It supports the import XLSX subset: the required header row, product columns `productId`, `version`, `sku`, `name`, `price`, `quantity`, `observedAt`, shared strings, inline strings, numeric values, sparse cell coordinates, and the first readable worksheet. It is not a general Excel feature implementation.

## Backpressure and lifecycle

`Readable.from(asyncGenerator)` exposes rows with a low object-mode high-water mark. The batch Transform emits a batch at `IMPORT_BATCH_SIZE` (default 500). The final partial batch is emitted at parser completion. The BullMQ Writable leaves its callback unresolved while `queue.add()` is retrying. A blocked enqueue therefore pauses the upstream pipeline instead of reading and discarding rows or building an unbounded promise queue.

`IMPORT_MAX_PENDING_BATCHES` is a configuration contract for bounded production; the implementation's one-unresolved-write chain is stricter than that upper bound. Redis enqueue retries until `IMPORT_REDIS_RETRY_TIMEOUT_MS` (default 30000 ms), then the import enters `FAILED`.

Successful upload parsing and enqueue production ends at `PROCESSING` and sets `enqueue_completed_at`. It does not mean all rows succeeded and it does not set `COMPLETED`. Batch workers own terminal row outcomes and the `PROCESSING -> COMPLETED` transition.

## Memory and security trade-offs

The upload and worksheet rows are not fully buffered in RAM. Shared strings are retained because cells refer to them by index; memory can grow with the shared-string table. Temporary-file staging uses local disk and is not durable storage. Unsafe worksheet relationships containing an absolute path or `..` are rejected.

## Qualification notes

- ExcelJS `WorkbookReader` was rejected after a verified runtime failure on a valid generated XLSX.
- `xlsx-extract` was rejected because its EventEmitter row API can run ahead of an asynchronous consumer and cannot propagate producer-side backpressure.
- `xlsx-stream-reader` was rejected for the same backpressure limitation.
- The internal `yauzl` plus `sax` reader was selected because its async-generator row boundary can participate in Node stream backpressure.
