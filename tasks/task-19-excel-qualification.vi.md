# Tham Dinh Streaming Excel Task 19

Trang thai: REJECTED cho production use sau flow-control qualification. Task 19 implementation van incomplete.

## Blocker ExcelJS

- Dependency da kiem tra: `exceljs@4.4.0`.
- Da dung API `ExcelJS.stream.xlsx.WorkbookReader` duoc tai lieu hoa voi nguon `Readable`.
- Mot XLSX hop le do ExcelJS tu tao tai hien loi `Cannot read properties of undefined (reading 'sheets')`.
- Khong chap nhan mutate internals `reader.model` khong duoc tai lieu hoa vi cach nay khong resolve shared strings dung va khong phai API duoc ho tro.
- Khong chap nhan `Workbook.xlsx.load(...)` vi can full workbook buffer.
- Khong patch `node_modules` hoac vendor private ExcelJS modification.

## Tham Dinh Phuong An Thay The

- Candidate: `xlsx-extract@0.2.0`, repository `ffalt/xlsx-extract`.
- Metadata nguon yeu cau Node.js `>=20`; runtime cua project dap ung yeu cau nay.
- API: `new XLSX().extract(filename, { sheet_nr: '1', format: 'array' })` phat cac event `row`, `error`, va `end`.
- Input: API duoc tai lieu hoa/nguon chi nhan filename/path, khong nhan HTTP `Readable`.
- Source dung `yauzl` va SAX parsing va phat row tang dan. Source khong giu worksheet rows/cells hoac XLSX file buffer, nhung giu workbook metadata va toan bo shared-string table de resolve shared-string cells. Phan memory nay bi gioi han boi workbook metadata va unique strings, khong phai boi tat ca worksheet rows, va van la trade-off can duoc tai lieu hoa neu ap dung.
- Qualification test: fixture do ExcelJS tao voi header, string lap lai, decimal price, integer quantity, va nhieu row phat gia tri da resolve theo dung thu tu. Corrupt archive phat error.
- Bao tri: metadata package xac dinh upstream repository dang hoat dong va release `0.2.0` hien tai; khong de xuat source patch.

## Anh Huong Contract

`xlsx-extract` can bounded temporary-file staging:

```text
Busboy file Readable -> bounded temporary XLSX file -> XLSX row events -> row normalization/bounded batches -> delete trong finally
```

Upload van co the streaming xuong disk va enforce size trong khi nhan bytes; parser co the consume row events tang dan ma khong giu tat ca rows. Temporary file khong phai durable storage va phai duoc xoa khi thanh cong va failure.

Tuy nhien, XLSX parsing chi bat dau sau khi upload EOF va temporary file hoan tat. SPEC/PLAN/test-contract amendment da duyet vi vay thay HTTP-EOF assertion bang proof rang first full batch co the enqueue truoc parser/workbook EOF sau staging. Parser nay sau do bi reject cho production use vi public EventEmitter API khong the apply asynchronous consumer backpressure; runtime test 200 rows emit moi row truoc khi asynchronous consumer dau tien complete. Task 19 implementation van incomplete.
