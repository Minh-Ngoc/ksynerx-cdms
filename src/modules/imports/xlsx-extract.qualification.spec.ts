import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ExcelJS from 'exceljs';
import { XLSX } from 'xlsx-extract';

interface ExtractedRow {
  row: unknown[];
  rowNumber: number;
}

describe('xlsx-extract qualification spike', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cdms-xlsx-extract-'));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it('iterates an ExcelJS-generated workbook by row with resolved shared strings and stable order', async () => {
    const filename = join(directory, 'products.xlsx');
    await writeFile(filename, await createExcelJsFixture());

    const { rows, rowEventsBeforeEnd } = await extractRows(filename);

    // The event count observed before `end` proves consumption can happen row-by-row. The spike
    // keeps this tiny assertion list only for qualification; a production adapter must emit each
    // row to the normalizer/batch producer and must not accumulate the workbook's rows in memory.
    expect(rowEventsBeforeEnd).toBe(3);
    expect(rows).toEqual([
      { rowNumber: 1, row: ['productId', 'version', 'sku', 'name', 'price', 'quantity', 'observedAt'] },
      { rowNumber: 2, row: ['product-1', 1, 'SKU-1', 'Product 1', 10.25, 4, '2026-01-01T00:00:00.000Z'] },
      { rowNumber: 3, row: ['product-2', 2, 'SKU-2', 'Product 2', 20.5, 7, '2026-01-02T00:00:00.000Z'] },
    ]);
  });

  it('propagates a corrupt workbook failure', async () => {
    const filename = join(directory, 'corrupt.xlsx');
    await writeFile(filename, 'not an XLSX archive');

    await expect(extractRows(filename)).rejects.toThrow();
  });
});

async function createExcelJsFixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products');
  sheet.addRow(['productId', 'version', 'sku', 'name', 'price', 'quantity', 'observedAt']);
  sheet.addRow(['product-1', 1, 'SKU-1', 'Product 1', 10.25, 4, '2026-01-01T00:00:00.000Z']);
  sheet.addRow(['product-2', 2, 'SKU-2', 'Product 2', 20.5, 7, '2026-01-02T00:00:00.000Z']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function extractRows(filename: string): Promise<{ rows: ExtractedRow[]; rowEventsBeforeEnd: number }> {
  return new Promise((resolve, reject) => {
    const rows: ExtractedRow[] = [];
    let rowEventsBeforeEnd = 0;
    let settled = false;
    const reader = new XLSX();

    // `xlsx-extract` accepts only a filename, so a production integration would need bounded
    // temporary-file staging. It must consume the `row` event immediately; the array exists only
    // in this three-row qualification fixture to assert header/value order and parser behavior.
    reader.on('row', (row: unknown[]) => {
      rowEventsBeforeEnd += 1;
      rows.push({ row, rowNumber: rowEventsBeforeEnd });
    });
    reader.once('error', (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    reader.once('end', () => {
      if (!settled) {
        settled = true;
        resolve({ rows, rowEventsBeforeEnd });
      }
    });
    reader.extract(filename, {
      convert_values: { bools: true, dates: true, floats: true, ints: true },
      format: 'array',
      sheet_nr: '1',
    });
  });
}
