# Task 19 xlsx-stream-reader Qualification

Status: REJECTED for Task 19 production use.

## Source Inspection

- Candidate: `xlsx-stream-reader@1.1.1` from `daspawn/xlsx-stream-reader`; package metadata advertises Node.js `>=0.10.0` and the README labels it beta.
- The public API pipes an input stream into a workbook reader, receives a worksheet event, attaches `row`/`end` handlers, then calls `worksheet.process()`.
- `worksheet.process()` directly pipes the worksheet stream into a SAX parser. The parser synchronously emits rows through `EventEmitter` callbacks.
- There is no documented worksheet pause/resume API or async iterator. The README says pausing the input stream is only theoretical and untested.
- The source retains shared strings, styles, and workbook metadata. If shared strings arrive after a worksheet, it writes that worksheet to a library-managed temporary file and rereads it later. This uncontrolled staging behavior is incompatible with the approved controlled-temp-file cleanup contract.

## Runtime Qualification

A 200-data-row workbook produces 201 row events including the header. With a 25 ms asynchronous consumer:

```json
{
  "emitted": 201,
  "completed": 201,
  "emittedBeforeFirstAsyncCompletion": 201,
  "maxProducerAhead": 201
}
```

Calling `Readable.pause()` after two outstanding consumer slots did not change those results. The parser still emitted all rows before the first async consumer completed.

## Value and Failure Qualification

- Ordered headers and ExcelJS shared strings resolve.
- With reader formatting disabled, decimal `10.25` and integer `4` are exposed as exact source strings without reader-side rounding.
- A corrupt XLSX emits an error.

## Decision

This candidate fails the required bounded producer-side backpressure invariant. A semaphore could bound consumer work but cannot stop parser row emission, so it would still require an unbounded row queue or unbounded pending promises. Do not use it for Task 19 production code.

No additional third-party parser will be qualified. The next approved option is a limited internal reader over the staged file: ZIP entry reader -> metadata/shared strings -> target worksheet stream -> SAX transform whose writable callback awaits bounded async row processing. That callback chain provides the required propagation: consumer wait -> worksheet row wait -> SAX transform wait -> ZIP entry stream wait.
