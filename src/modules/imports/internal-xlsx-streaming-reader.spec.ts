import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ExcelJS from 'exceljs';

import { InternalXlsxStreamingReader } from './internal-xlsx-streaming-reader.js';

describe('InternalXlsxStreamingReader', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cdms-internal-xlsx-'));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it('preserves ordered shared-string and sparse cell positions without rounding numeric source values', async () => {
    const filename = join(directory, 'products.xlsx');
    await writeFile(filename, await createWorkbook(2));

    const reader = new InternalXlsxStreamingReader();
    const rows = await collectRows(reader.open(filename));

    expect(rows).toEqual([
      { rowNumber: 1, cells: ['productId', 'version', 'sku', 'name', 'price', 'quantity', 'observedAt'] },
      { rowNumber: 2, cells: ['product-1', '1', 'SKU-1', 'Product 1', '10.25', '4', '2026-01-01T00:00:00.000Z'] },
      { rowNumber: 3, cells: ['product-2', '2', 'SKU-2', 'Product 2', '20.5', undefined, '2026-01-02T00:00:00.000Z'] },
    ]);
  });

  it('fails a corrupt XLSX without yielding rows', async () => {
    const filename = join(directory, 'corrupt.xlsx');
    await writeFile(filename, 'not an XLSX archive');

    const reader = new InternalXlsxStreamingReader();
    const source = reader.open(filename);
    source.on('error', () => undefined);
    await expect(collectRows(source)).rejects.toThrow();
  });

  it('does not run 200 worksheet rows ahead of a blocked object-mode sink', async () => {
    const filename = join(directory, 'slow-consumer.xlsx');
    await writeFile(filename, await createWorkbook(200));

    const reader = new InternalXlsxStreamingReader({ rowHighWaterMark: 1, xmlChunkBytes: 128 });
    const source = reader.open(filename);
    let written = 0;
    let sourceEndedWhileBlocked = false;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sink = new Writable({
      highWaterMark: 1,
      objectMode: true,
      write(_row, _encoding, callback) {
        written += 1;
        if (written === 1) {
          void blocked.then(() => callback());
          return;
        }
        callback();
      },
    });

    source.once('end', () => {
      sourceEndedWhileBlocked = true;
    });
    source.pipe(sink);
    await waitUntil(() => written === 1);

    expect(written).toBe(1);
    expect(sourceEndedWhileBlocked).toBe(false);
    expect(source.readableLength).toBeLessThanOrEqual(1);

    release();
    await finished(sink);
    expect(written).toBe(201);
  });
});

async function collectRows(source: NodeJS.ReadableStream): Promise<unknown[]> {
  const rows: unknown[] = [];
  for await (const row of source) {
    rows.push(row);
  }
  return rows;
}

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
      index === 2 ? undefined : index === 1 ? 4 : 7,
      `2026-01-0${index === 1 ? 1 : 2}T00:00:00.000Z`,
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for the blocked sink');
}
