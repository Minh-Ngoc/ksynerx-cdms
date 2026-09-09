import { StringDecoder } from 'node:string_decoder';
import { Readable } from 'node:stream';

import sax from 'sax';
import yauzl, { Entry, ZipFile } from 'yauzl';

import { ImportWorkbookParseError } from './import-streaming.contract.js';

export interface XlsxRow {
  rowNumber: number;
  cells: Array<string | undefined>;
}

export interface InternalXlsxStreamingReaderOptions {
  rowHighWaterMark?: number;
  xmlChunkBytes?: number;
}

type XmlAttributes = sax.Tag['attributes'] | sax.QualifiedTag['attributes'];

const SHARED_STRINGS_ENTRY = 'xl/sharedStrings.xml';
const WORKBOOK_ENTRY = 'xl/workbook.xml';
const WORKBOOK_RELATIONSHIPS_ENTRY = 'xl/_rels/workbook.xml.rels';

/**
 * This reader intentionally supports only the import workbook subset. Staging makes the ZIP
 * seekable, then the async generator yields rows only when the Node stream consumer requests one.
 * That is the backpressure boundary missing from the rejected EventEmitter-based readers: a slow
 * BullMQ Writable stops this generator before it asks the ZIP entry stream for more XML.
 */
export class InternalXlsxStreamingReader {
  private readonly rowHighWaterMark: number;
  private readonly xmlChunkBytes: number;

  constructor(options: InternalXlsxStreamingReaderOptions = {}) {
    this.rowHighWaterMark = options.rowHighWaterMark ?? 1;
    this.xmlChunkBytes = options.xmlChunkBytes ?? 1024;
  }

  open(filename: string): Readable {
    return Readable.from(this.readRows(filename), {
      highWaterMark: this.rowHighWaterMark,
      objectMode: true,
    });
  }

  private async *readRows(filename: string): AsyncGenerator<XlsxRow> {
    const entries = await listEntries(filename);
    const worksheetEntry = await resolveFirstWorksheetEntry(filename, entries);
    const sharedStrings = entries.has(SHARED_STRINGS_ENTRY)
      ? await readSharedStrings(filename, SHARED_STRINGS_ENTRY)
      : [];

    const opened = await openEntryStream(filename, worksheetEntry);
    try {
      yield* parseWorksheetRows(opened.stream, sharedStrings, this.xmlChunkBytes);
    } finally {
      opened.close();
    }
  }
}

async function listEntries(filename: string): Promise<Set<string>> {
  const zip = await openZip(filename);
  return new Promise((resolve, reject) => {
    const entries = new Set<string>();
    zip.once('error', reject);
    zip.on('entry', (entry: Entry) => {
      entries.add(entry.fileName);
      zip.readEntry();
    });
    zip.once('end', () => {
      zip.close();
      resolve(entries);
    });
    zip.readEntry();
  });
}

async function resolveFirstWorksheetEntry(filename: string, entries: Set<string>): Promise<string> {
  if (!entries.has(WORKBOOK_ENTRY) || !entries.has(WORKBOOK_RELATIONSHIPS_ENTRY)) {
    throw new ImportWorkbookParseError('Workbook metadata is missing');
  }

  const firstRelationshipId = await readFirstSheetRelationshipId(filename);
  if (firstRelationshipId === undefined) {
    throw new ImportWorkbookParseError('Workbook has no readable worksheet');
  }
  const target = await readWorksheetTarget(filename, firstRelationshipId);
  const entry = normalizeWorksheetTarget(target);
  if (!entries.has(entry)) {
    throw new ImportWorkbookParseError('Workbook worksheet entry is missing');
  }
  return entry;
}

async function readFirstSheetRelationshipId(filename: string): Promise<string | undefined> {
  let relationshipId: string | undefined;
  await parseXmlEntry(filename, WORKBOOK_ENTRY, (name, attributes) => {
    if (relationshipId === undefined && name === 'sheet') {
      relationshipId = attribute(attributes, 'r:id');
    }
  });
  return relationshipId;
}

async function readWorksheetTarget(filename: string, relationshipId: string): Promise<string> {
  let target: string | undefined;
  await parseXmlEntry(filename, WORKBOOK_RELATIONSHIPS_ENTRY, (name, attributes) => {
    if (name === 'relationship' && attribute(attributes, 'id') === relationshipId) {
      target = attribute(attributes, 'target');
    }
  });
  if (target === undefined) {
    throw new ImportWorkbookParseError('Workbook worksheet relationship is missing');
  }
  return target;
}

function normalizeWorksheetTarget(target: string): string {
  if (target.startsWith('/') || target.includes('..')) {
    throw new ImportWorkbookParseError('Workbook has an unsafe worksheet relationship');
  }
  return `xl/${target.replace(/^\//, '')}`;
}

async function readSharedStrings(filename: string, entry: string): Promise<string[]> {
  const strings: string[] = [];
  let current = '';
  let inString = false;
  let inText = false;
  await parseXmlEntry(
    filename,
    entry,
    (name) => {
      if (name === 'si') {
        inString = true;
        current = '';
      } else if (inString && name === 't') {
        inText = true;
      }
    },
    (text) => {
      if (inText) {
        current += text;
      }
    },
    (name) => {
      if (name === 't') {
        inText = false;
      } else if (name === 'si') {
        strings.push(current);
        inString = false;
      }
    },
  );
  return strings;
}

async function parseXmlEntry(
  filename: string,
  entryName: string,
  onOpen: (name: string, attributes: XmlAttributes) => void,
  onText: (text: string) => void = () => undefined,
  onClose: (name: string) => void = () => undefined,
): Promise<void> {
  const opened = await openEntryStream(filename, entryName);
  const parser = sax.createStream(true, { normalize: false, trim: false });
  parser.on('opentag', (tag) => onOpen(tag.name.toLowerCase(), tag.attributes));
  parser.on('text', onText);
  parser.on('closetag', (name) => onClose(name.toLowerCase()));

  try {
    await new Promise<void>((resolve, reject) => {
      parser.once('error', reject);
      parser.once('end', resolve);
      opened.stream.pipe(parser);
    });
  } catch {
    throw new ImportWorkbookParseError('Workbook metadata could not be read');
  } finally {
    opened.close();
  }
}

async function *parseWorksheetRows(
  stream: Readable,
  sharedStrings: readonly string[],
  xmlChunkBytes: number,
): AsyncGenerator<XlsxRow> {
  const parser = sax.parser(true, { normalize: false, trim: false });
  const decoder = new StringDecoder('utf8');
  const produced: XlsxRow[] = [];
  let parseError: Error | undefined;
  let row: XlsxRow | undefined;
  let cell: { index: number; type: string; value: string; inlineText: string } | undefined;
  let collectValue = false;
  let collectInlineText = false;

  parser.onerror = (error) => {
    parseError = error;
  };
  parser.onopentag = (tag) => {
    const name = tag.name.toLowerCase();
    if (name === 'row') {
      const rowNumber = Number(attribute(tag.attributes, 'r'));
      if (!Number.isInteger(rowNumber) || rowNumber < 1) {
        parseError = new ImportWorkbookParseError('Worksheet row is missing a valid coordinate');
        return;
      }
      row = { rowNumber, cells: [] };
      return;
    }
    if (name === 'c' && row !== undefined) {
      const coordinate = attribute(tag.attributes, 'r');
      const index = coordinate === undefined ? undefined : columnIndex(coordinate);
      if (index === undefined) {
        parseError = new ImportWorkbookParseError('Worksheet cell is missing a valid coordinate');
        return;
      }
      cell = { index, type: attribute(tag.attributes, 't') ?? 'n', value: '', inlineText: '' };
      return;
    }
    if (name === 'v' && cell !== undefined) {
      collectValue = true;
    } else if (name === 't' && cell?.type === 'inlinestr') {
      collectInlineText = true;
    }
  };
  parser.ontext = (text) => {
    if (collectValue && cell !== undefined) {
      cell.value += text;
    }
    if (collectInlineText && cell !== undefined) {
      cell.inlineText += text;
    }
  };
  parser.onclosetag = (rawName) => {
    const name = rawName.toLowerCase();
    if (name === 'v') {
      collectValue = false;
      return;
    }
    if (name === 't') {
      collectInlineText = false;
      return;
    }
    if (name === 'c' && cell !== undefined && row !== undefined) {
      row.cells[cell.index] = resolveCellValue(cell, sharedStrings);
      cell = undefined;
      return;
    }
    if (name === 'row' && row !== undefined) {
      produced.push(row);
      row = undefined;
    }
  };

  for await (const sourceChunk of stream) {
    const text = decoder.write(sourceChunk as Buffer);
    for (let offset = 0; offset < text.length; offset += xmlChunkBytes) {
      parser.write(text.slice(offset, offset + xmlChunkBytes));
      throwIfParseFailed(parseError);

      // A SAX callback is synchronous, so rows from one bounded XML slice are held only until the
      // generator can yield them. It then stops asking the ZIP stream for bytes while downstream
      // is backpressured; the fixed slice prevents an arbitrary callback burst from becoming a row queue.
      while (produced.length > 0) {
        yield produced.shift()!;
      }
    }
  }
  parser.write(decoder.end()).close();
  throwIfParseFailed(parseError);
  while (produced.length > 0) {
    yield produced.shift()!;
  }
}

function resolveCellValue(
  cell: { index: number; type: string; value: string; inlineText: string },
  sharedStrings: readonly string[],
): string {
  if (cell.type === 's') {
    const index = Number(cell.value);
    if (!Number.isInteger(index) || sharedStrings[index] === undefined) {
      throw new ImportWorkbookParseError('Worksheet has an invalid shared-string reference');
    }
    return sharedStrings[index];
  }
  if (cell.type === 'inlinestr') {
    return cell.inlineText;
  }
  if (!['n', 'str', 'b', 'e'].includes(cell.type)) {
    throw new ImportWorkbookParseError(`Worksheet cell type ${cell.type} is unsupported`);
  }
  return cell.value;
}

function columnIndex(coordinate: string): number | undefined {
  const match = /^([A-Z]+)[1-9]\d*$/i.exec(coordinate);
  if (match === null) {
    return undefined;
  }
  let index = 0;
  for (const letter of match[1]!.toUpperCase()) {
    index = index * 26 + letter.charCodeAt(0) - 64;
  }
  return index - 1;
}

function attribute(attributes: XmlAttributes, name: string): string | undefined {
  const entry = Object.entries(attributes).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry === undefined ? undefined : String(entry[1]);
}

function throwIfParseFailed(error: Error | undefined): void {
  if (error !== undefined) {
    throw new ImportWorkbookParseError('Worksheet XML could not be read');
  }
}

async function openEntryStream(filename: string, entryName: string): Promise<{ stream: Readable; close: () => void }> {
  const zip = await openZip(filename);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        zip.close();
        reject(error);
      }
    };
    zip.once('error', fail);
    zip.on('entry', (entry: Entry) => {
      if (entry.fileName !== entryName) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error !== null || stream === undefined) {
          fail(error ?? new Error('ZIP entry stream could not be opened'));
          return;
        }
        settled = true;
        resolve({ stream, close: () => zip.close() });
      });
    });
    zip.once('end', () => fail(new ImportWorkbookParseError(`Workbook entry ${entryName} is missing`)));
    zip.readEntry();
  });
}

function openZip(filename: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { autoClose: false, lazyEntries: true }, (error, zip) => {
      if (error !== null || zip === undefined) {
        reject(new ImportWorkbookParseError('Workbook could not be opened'));
        return;
      }
      resolve(zip);
    });
  });
}
