# Tham Dinh xlsx-stream-reader Cho Task 19

Trang thai: REJECTED cho Task 19 production use.

## Source Inspection

- Candidate: `xlsx-stream-reader@1.1.1` tu `daspawn/xlsx-stream-reader`; package metadata ghi Node.js `>=0.10.0` va README goi package la beta.
- Public API pipe input stream vao workbook reader, nhan worksheet event, gan handlers `row`/`end`, sau do goi `worksheet.process()`.
- `worksheet.process()` pipe truc tiep worksheet stream vao SAX parser. Parser dong bo emit rows qua `EventEmitter` callbacks.
- Khong co documented worksheet pause/resume API hoac async iterator. README noi pausing input stream chi la ly thuyet va chua duoc test.
- Source giu shared strings, styles, va workbook metadata. Neu shared strings den sau worksheet, source write worksheet do vao library-managed temporary file va doc lai sau. Uncontrolled staging nay khong tuong thich voi controlled-temp-file cleanup contract da approve.

## Runtime Qualification

Workbook co 200 data rows tao 201 row events bao gom header. Voi asynchronous consumer 25 ms:

```json
{
  "emitted": 201,
  "completed": 201,
  "emittedBeforeFirstAsyncCompletion": 201,
  "maxProducerAhead": 201
}
```

Goi `Readable.pause()` sau hai outstanding consumer slots khong doi ket qua. Parser van emit tat ca rows truoc khi async consumer dau tien complete.

## Value Va Failure Qualification

- Ordered headers va ExcelJS shared strings resolve.
- Khi reader formatting disabled, decimal `10.25` va integer `4` duoc expose la source strings chinh xac, khong reader-side rounding.
- Corrupt XLSX emit error.

## Decision

Candidate nay fail bounded producer-side backpressure invariant bat buoc. Semaphore co the bound consumer work nhung khong the stop parser row emission, nen van can unbounded row queue hoac unbounded pending promises. Khong dung cho Task 19 production code.

Khong tham dinh them third-party parser. Lua chon tiep theo can duoc approve la limited internal reader tren staged file: ZIP entry reader -> metadata/shared strings -> target worksheet stream -> SAX transform voi writable callback await bounded async row processing. Callback chain nay cung cap propagation bat buoc: consumer wait -> worksheet row wait -> SAX transform wait -> ZIP entry stream wait.
