# ADR-007: Excel Streaming với Temporary Staging và yauzl/sax

## Status
Accepted

## Context

Upload phải enforce size limit và backpressure mà không buffer workbook hay toàn bộ row trong memory.

## Decision

Stage multipart bytes vào temporary file riêng có kiểm soát, sau đó parse worksheet đầu tiên bằng `yauzl` ZIP streams và `sax`, expose row qua Node stream dùng async generator.

## Consequences

Stream có thể pause khi BullMQ enqueue bị block. Local disk và shared-string memory vẫn là limitation prototype. Qualification failure của ExcelJS, xlsx-extract và xlsx-stream-reader được ghi trong tài liệu Excel.

## Alternatives Considered

Multer memory buffering và parser EventEmitter không có producer backpressure bị reject.
