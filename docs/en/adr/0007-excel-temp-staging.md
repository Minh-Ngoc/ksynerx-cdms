# ADR-007: Excel Streaming with Temporary Staging and yauzl/sax

## Status
Accepted

## Context

The upload must enforce a size limit and backpressure without buffering a workbook or all rows in memory.

## Decision

Stage multipart bytes to a unique controlled temporary file, then parse the first worksheet through `yauzl` ZIP streams and `sax`, exposing rows through an async-generator-backed Node stream.

## Consequences

The stream can pause while BullMQ enqueue is blocked. Local disk and shared-string memory remain prototype limitations. ExcelJS, xlsx-extract, and xlsx-stream-reader qualification failures are recorded in the Excel document.

## Alternatives Considered

Multer memory buffering and EventEmitter parsers without producer backpressure were rejected.
