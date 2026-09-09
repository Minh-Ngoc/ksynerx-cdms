# ADR-007: Excel Streaming voi Temporary Staging va yauzl/sax

## Status
Accepted

## Context

Upload phai enforce size limit va backpressure ma khong buffer workbook hay toan bo row trong memory.

## Decision

Stage multipart bytes vao temporary file rieng co kiem soat, sau do parse worksheet dau tien bang `yauzl` ZIP streams va `sax`, expose row qua Node stream dung async generator.

## Consequences

Stream co the pause khi BullMQ enqueue bi block. Local disk va shared-string memory van la limitation prototype. Qualification failure cua ExcelJS, xlsx-extract va xlsx-stream-reader duoc ghi trong tai lieu Excel.

## Alternatives Considered

Multer memory buffering va parser EventEmitter khong co producer backpressure bi reject.
