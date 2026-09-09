import { createRequire } from 'node:module';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ExcelJS from 'exceljs';

const require = createRequire(import.meta.url);
// The package has no TypeScript declarations. It is qualification-only and must not become an
// implementation dependency without an approved, typed adapter and bounded-flow proof.
const XlsxStreamReader = require('xlsx-stream-reader') as new (options: { formatting: boolean }) => WorkbookReader;

interface WorkbookReader {
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'worksheet', listener: (worksheet: WorksheetReader) => void): this;
}

interface WorksheetReader {
  id: string | number;
  on(event: 'row', listener: (row: { attributes: { r: string }; values: unknown[] }) => void): this;
  on(event: 'end', listener: () => void): this;
  process(): void;
  skip(): void;
}

describe('xlsx-stream-reader qualification spike', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cdms-xlsx-stream-reader-'));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it('emits ordered shared-string and numeric cell values without reader-side rounding', async () => {
    const filename = join(directory, 'products.xlsx');
    await writeFile(filename, await createWorkbook(2));

    const rows = await readRows(filename);

    expect(rows).toEqual([
      ['productId', 'version', 'sku', 'name', 'price', 'quantity', 'observedAt'],
      ['product-1', '1', 'SKU-1', 'Product 1', '10.25', '4', '2026-01-01T00:00:00.000Z'],
      ['product-2', '2', 'SKU-2', 'Product 2', '20.5', '7', '2026-01-02T00:00:00.000Z'],
    ]);
  });

  it('propagates a corrupt workbook error', async () => {
    const filename = join(directory, 'corrupt.xlsx');
    await writeFile(filename, 'not an XLSX archive');

    await expect(readRows(filename)).rejects.toThrow();
  });

  it('cannot bound producer advance with a slow asynchronous consumer, even when its input is paused', async () => {
    const filename = join(directory, 'slow-consumer.xlsx');
    await writeFile(filename, await createWorkbook(200));

    const result = await measureSlowConsumer(filename, true);

    // The public worksheet API emits synchronously and offers no supported pause/resume control.
    // This records the rejection reason: bounding consumer slots alone cannot prevent all parser
    // rows from being emitted before those slots complete, so it cannot meet Task 19's invariant.
    expect(result).toEqual({
      completed: 201,
      emitted: 201,
      emittedBeforeFirstAsyncCompletion: 201,
      maxProducerAhead: 201,
    });
  });
});

async function createWorkbook(rowCount: number): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products');
  sheet.addRow(['productId', 'version', 'sku', 'name', 'price', 'quantity', 'observedAt']);
  for (let index = 1; index <= rowCount; index += 1) {
    sheet.addRow([
      `product-${index}`,
      index,
      `SKU-${index}`,
      `Product ${index}`,
      index === 1 ? 10.25 : 20.5,
      index === 1 ? 4 : 7,
      `2026-01-0${index === 1 ? 1 : 2}T00:00:00.000Z`,
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function readRows(filename: string): Promise<unknown[][]> {
  return new Promise((resolve, reject) => {
    const rows: unknown[][] = [];
    const reader = new XlsxStreamReader({ formatting: false });
    reader.on('error', reject);
    reader.on('worksheet', (worksheet) => {
      if (Number(worksheet.id) !== 1) {
        worksheet.skip();
        return;
      }
      worksheet.on('row', (row) => rows.push(row.values.slice(1)));
      worksheet.on('end', () => resolve(rows));
      worksheet.process();
    });
    createReadStream(filename).pipe(reader as never);
  });
}

function measureSlowConsumer(
  filename: string,
  pauseInput: boolean,
): Promise<{ emitted: number; completed: number; emittedBeforeFirstAsyncCompletion: number; maxProducerAhead: number }> {
  return new Promise((resolve, reject) => {
    const input = createReadStream(filename);
    const reader = new XlsxStreamReader({ formatting: false });
    let emitted = 0;
    let completed = 0;
    let emittedBeforeFirstAsyncCompletion = 0;
    let firstAsyncCompletion = false;
    let maxProducerAhead = 0;
    let paused = false;

    reader.on('error', reject);
    reader.on('worksheet', (worksheet) => {
      if (Number(worksheet.id) !== 1) {
        worksheet.skip();
        return;
      }
      worksheet.on('row', () => {
        emitted += 1;
        maxProducerAhead = Math.max(maxProducerAhead, emitted - completed);
        if (pauseInput && emitted - completed >= 2 && !paused) {
          paused = true;
          input.pause();
        }
        setTimeout(() => {
          completed += 1;
          if (!firstAsyncCompletion) {
            firstAsyncCompletion = true;
            emittedBeforeFirstAsyncCompletion = emitted;
          }
          if (paused && emitted - completed < 2) {
            paused = false;
            input.resume();
          }
        }, 25);
      });
      worksheet.on('end', async () => {
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
        resolve({ emitted, completed, emittedBeforeFirstAsyncCompletion, maxProducerAhead });
      });
      worksheet.process();
    });
    input.pipe(reader as never);
  });
}
