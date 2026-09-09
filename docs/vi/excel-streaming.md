# Excel Streaming

## Pipeline da implement

Upload co hai phase:

```text
Phase A: multipart Busboy -> byte-limited controlled temporary file
Phase B: temp XLSX -> yauzl ZIP streams -> sax XML parser -> Node row stream
         -> row normalization -> bounded batches -> BullMQ Writable
```

Busboy nhan dung mot `file` field. Client filename duoc sanitize va khong bao gio duoc dung lam filesystem path. Server tao directory rieng duoi OS temp directory va stage bytes qua transform enforce `IMPORT_MAX_FILE_SIZE_MB` (default 100) trong luc ghi. Directory bi xoa trong `finally` khi thanh cong hoac failure.

Internal reader resolve worksheet dau tien qua workbook relationships, doc shared strings neu co, va parse worksheet rows incrementally. Reader ho tro XLSX subset cua import: required header, cac cot `productId`, `version`, `sku`, `name`, `price`, `quantity`, `observedAt`, shared strings, inline strings, numeric values, sparse cell coordinates va worksheet dau tien doc duoc. Day khong phai general Excel implementation.

## Backpressure va lifecycle

`Readable.from(asyncGenerator)` expose rows voi object-mode high-water mark thap. Batch Transform emit batch tai `IMPORT_BATCH_SIZE` (default 500), va emit partial batch cuoi khi parser ket thuc. BullMQ Writable giu callback chua resolve trong luc `queue.add()` retry. Enqueue bi block se pause upstream thay vi doc bo rows hoac tao unbounded promise queue.

`IMPORT_MAX_PENDING_BATCHES` la configuration contract cho bounded production; implementation dung mot unresolved-write chain nghiem hon upper bound nay. Redis enqueue retry den `IMPORT_REDIS_RETRY_TIMEOUT_MS` (default 30000 ms), sau do import `FAILED`.

Upload parse va enqueue production thanh cong chi ket thuc o `PROCESSING` va set `enqueue_completed_at`. Dieu nay khong co nghia moi row succeeded va khong set `COMPLETED`. Batch worker so huu row terminal outcomes va transition `PROCESSING -> COMPLETED`.

## Memory va security trade-off

Upload va worksheet rows khong bi buffer toan bo trong RAM. Shared strings duoc giu vi cell tham chieu bang index; memory co the tang theo shared-string table. Temporary staging dung local disk va khong phai durable storage. Worksheet relationship co absolute path hoac `..` bi reject.

## Qualification

- ExcelJS `WorkbookReader` bi reject sau runtime failure da verify tren XLSX hop le.
- `xlsx-extract` bi reject vi EventEmitter row API co the chay truoc async consumer va khong propagate producer-side backpressure.
- `xlsx-stream-reader` bi reject vi cung limitation ve backpressure.
- Internal `yauzl` + `sax` duoc chon vi async-generator row boundary tham gia duoc vao Node stream backpressure.
