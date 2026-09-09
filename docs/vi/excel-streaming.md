# Excel Streaming

## Pipeline đã implement

Upload có hai phase:

```text
Phase A: multipart Busboy -> byte-limited controlled temporary file
Phase B: temp XLSX -> yauzl ZIP streams -> sax XML parser -> Node row stream
         -> row normalization -> bounded batches -> BullMQ Writable
```

Busboy nhận dùng một `file` field. Client filename được sanitize và không bao giờ được dùng làm filesystem path. Server tạo directory riêng dưới OS temp directory và stage bytes qua transform enforce `IMPORT_MAX_FILE_SIZE_MB` (default 100) trong lúc ghi. Directory bị xóa trong `finally` khi thành công hoặc failure.

Internal reader resolve worksheet đầu tiên qua workbook relationships, đọc shared strings nếu có, và parse worksheet rows incrementally. Reader hỗ trợ XLSX subset của import: required header, các cột `productId`, `version`, `sku`, `name`, `price`, `quantity`, `observedAt`, shared strings, inline strings, numeric values, sparse cell coordinates và worksheet đầu tiên đọc được. Đây không phải general Excel implementation.

## Backpressure và lifecycle

`Readable.from(asyncGenerator)` expose rows với object-mode high-water mark thấp. Batch Transform emit batch tại `IMPORT_BATCH_SIZE` (default 500), và emit partial batch cuối khi parser kết thúc. BullMQ Writable giữ callback chưa resolve trong lúc `queue.add()` retry. Enqueue bị block sẽ pause upstream thay vì đọc bỏ rows hoặc tạo unbounded promise queue.

`IMPORT_MAX_PENDING_BATCHES` là configuration contract cho bounded production; implementation dùng một unresolved-write chain nghiêm hơn upper bound này. Redis enqueue retry đến `IMPORT_REDIS_RETRY_TIMEOUT_MS` (default 30000 ms), sau đó import `FAILED`.

Upload parse và enqueue production thành công chỉ kết thúc ở `PROCESSING` và set `enqueue_completed_at`. Điều này không có nghĩa mỗi row succeeded và không set `COMPLETED`. Batch worker sở hữu row terminal outcomes và transition `PROCESSING -> COMPLETED`.

## Memory và security trade-off

Upload và worksheet rows không bị buffer toàn bộ trong RAM. Shared strings được giữ vì cell tham chiếu bằng index; memory có thể tăng theo shared-string table. Temporary staging dùng local disk và không phải durable storage. Worksheet relationship có absolute path hoặc `..` bị reject.

## Qualification

- ExcelJS `WorkbookReader` bị reject sau runtime failure đã verify trên XLSX hợp lệ.
- `xlsx-extract` bị reject vì EventEmitter row API có thể chạy trước async consumer và không propagate producer-side backpressure.
- `xlsx-stream-reader` bị reject vì cùng limitation về backpressure.
- Internal `yauzl` + `sax` được chọn vì async-generator row boundary tham gia được vào Node stream backpressure.
