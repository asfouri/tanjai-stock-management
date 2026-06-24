import { inflateRawSync } from 'node:zlib';

export type WorkbookCellValue = string | number | null;

export type WorkbookRow = {
  rowNumber: number;
  cells: Record<number, WorkbookCellValue>;
};

export type WorkbookSheet = {
  name: string;
  rows: WorkbookRow[];
  comments: Record<string, string>;
  images: WorkbookImage[];
  imageWarnings: WorkbookImageWarning[];
};

export type ParsedWorkbook = {
  sheets: WorkbookSheet[];
};

export type WorkbookImage = {
  sourceRow: number;
  sourceColumn: number;
  mimeType: string;
  dataUrl: string;
  mediaPath: string;
};

export type WorkbookImageWarning = {
  sourceRow?: number;
  sourceColumn?: number;
  message: string;
};

type ZipEntry = {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

const textDecoder = new TextDecoder('utf-8');

export function parseXlsxWorkbook(buffer: Buffer): ParsedWorkbook {
  const entries = readZipEntries(buffer);
  const getText = (name: string) => {
    const data = readZipEntry(buffer, entries, name);
    return data ? textDecoder.decode(data) : '';
  };
  const getBytes = (name: string) => readZipEntry(buffer, entries, name);

  const sharedStrings = parseSharedStrings(getText('xl/sharedStrings.xml'));
  const workbookXml = getText('xl/workbook.xml');
  const workbookRels = parseRelationships(getText('xl/_rels/workbook.xml.rels'));
  const workbookSheets = parseWorkbookSheets(workbookXml);

  const sheets = workbookSheets.map((sheet) => {
    const target = normalizeWorkbookTarget(workbookRels[sheet.relationshipId]);
    const sheetXml = getText(target);
    const comments = readSheetComments(getText, target);
    const { images, warnings: imageWarnings } = readSheetImages(
      getText,
      getBytes,
      target,
    );

    return {
      name: sheet.name,
      rows: parseRows(sheetXml, sharedStrings, sheet.name),
      comments,
      images,
      imageWarnings,
    };
  });

  return { sheets };
}

function readZipEntries(buffer: Buffer): Record<string, ZipEntry> {
  const entries: Record<string, ZipEntry> = {};
  let eocdOffset = -1;

  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocdOffset = index;
      break;
    }
  }

  if (eocdOffset < 0) {
    throw new Error('Invalid XLSX file: ZIP directory not found.');
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid XLSX file: corrupted ZIP directory.');
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString('utf8');

    entries[name] = {
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    };

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function readZipEntry(
  buffer: Buffer,
  entries: Record<string, ZipEntry>,
  name: string,
) {
  const entry = entries[name];

  if (!entry) {
    return null;
  }

  const localOffset = entry.localHeaderOffset;
  const fileNameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(
    dataOffset,
    dataOffset + entry.compressedSize,
  );

  if (entry.method === 0) {
    return compressed;
  }

  if (entry.method === 8) {
    return inflateRawSync(compressed, { finishFlush: 2 }).subarray(
      0,
      entry.uncompressedSize,
    );
  }

  throw new Error(`Unsupported XLSX compression method: ${entry.method}`);
}

function parseSharedStrings(xml: string) {
  const strings: string[] = [];
  const itemRegex = /<si\b[\s\S]*?<\/si>/g;
  const textRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;

  for (const item of xml.matchAll(itemRegex)) {
    const parts = [...item[0].matchAll(textRegex)].map((part) =>
      decodeXml(part[1]),
    );
    strings.push(parts.join(''));
  }

  return strings;
}

function parseRelationships(xml: string) {
  const relationships: Record<string, string> = {};
  const relRegex = /<Relationship\b([^>]*)\/>/g;

  for (const match of xml.matchAll(relRegex)) {
    const attrs = parseAttributes(match[1]);
    if (attrs.Id && attrs.Target) {
      relationships[attrs.Id] = attrs.Target;
    }
  }

  return relationships;
}

function parseWorkbookSheets(xml: string) {
  const sheets: Array<{ name: string; relationshipId: string }> = [];
  const sheetRegex = /<sheet\b([^>]*)\/>/g;

  for (const match of xml.matchAll(sheetRegex)) {
    const attrs = parseAttributes(match[1]);
    const relationshipId = attrs['r:id'] || attrs.id;

    if (attrs.name && relationshipId) {
      sheets.push({ name: attrs.name, relationshipId });
    }
  }

  return sheets;
}

function parseRows(xml: string, sharedStrings: string[], sheetName: string) {
  const rows: WorkbookRow[] = [];
  const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;

  for (const rowMatch of xml.matchAll(rowRegex)) {
    const rowAttrs = parseAttributes(rowMatch[1]);
    const rowNumber = Number(rowAttrs.r);
    const cells: Record<number, WorkbookCellValue> = {};

    for (const cellMatch of rowMatch[2].matchAll(cellRegex)) {
      const attrs = parseAttributes(cellMatch[1]);
      const column = columnToNumber(attrs.r || '');
      const value = parseCellValue(
        cellMatch[2],
        attrs.t,
        sharedStrings,
        sheetName,
        column,
      );

      if (column > 0 && value !== null && value !== '') {
        cells[column] = value;
      }
    }

    if (Object.keys(cells).length > 0) {
      rows.push({ rowNumber, cells });
    }
  }

  return rows;
}

function parseCellValue(
  xml: string,
  type: string | undefined,
  sharedStrings: string[],
  sheetName: string,
  column: number,
): WorkbookCellValue {
  if (type === 'inlineStr') {
    return decodeXml(stripTags(xml)).trim();
  }

  const valueMatch = xml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);

  if (!valueMatch) {
    return null;
  }

  const raw = decodeXml(valueMatch[1]).trim();

  if (type === 's') {
    return sharedStrings[Number(raw)] ?? '';
  }

  const sharedStringValue = sharedStrings[Number(raw)];
  if (
    column === 1 &&
    sheetName.toLowerCase().includes('quotation') &&
    Number.isInteger(Number(raw)) &&
    looksLikeQuotationContinuationLabel(sharedStringValue)
  ) {
    return sharedStringValue;
  }

  if (raw !== '' && Number.isFinite(Number(raw))) {
    return Number(raw);
  }

  return raw;
}

function looksLikeQuotationContinuationLabel(value: string | undefined) {
  if (!value) return false;
  const text = value.replace(/\s+/g, ' ').trim().toLowerCase();
  return /^(\d+\s*pcs?|per\s+pcs?|per\s+pieces?|per\s+order)$/.test(text);
}

function readSheetComments(
  getText: (name: string) => string,
  sheetTarget: string,
) {
  const comments: Record<string, string> = {};
  const fileName = sheetTarget.split('/').pop();
  const relsXml = getText(`xl/worksheets/_rels/${fileName}.rels`);
  const relationships = parseRelationships(relsXml);
  const commentTarget = Object.values(relationships).find((target) =>
    target.includes('comments'),
  );

  if (!commentTarget) {
    return comments;
  }

  const normalizedTarget = commentTarget.startsWith('../')
    ? `xl/${commentTarget.slice(3)}`
    : commentTarget.startsWith('xl/')
      ? commentTarget
      : `xl/worksheets/${commentTarget}`;
  const commentsXml = getText(normalizedTarget);
  const commentRegex = /<comment\b([^>]*)>([\s\S]*?)<\/comment>/g;

  for (const match of commentsXml.matchAll(commentRegex)) {
    const attrs = parseAttributes(match[1]);
    if (attrs.ref) {
      comments[attrs.ref] = decodeXml(stripTags(match[2])).trim();
    }
  }

  return comments;
}

function readSheetImages(
  getText: (name: string) => string,
  getBytes: (name: string) => Buffer | null,
  sheetTarget: string,
): { images: WorkbookImage[]; warnings: WorkbookImageWarning[] } {
  const fileName = sheetTarget.split('/').pop();
  const relsXml = getText(`xl/worksheets/_rels/${fileName}.rels`);
  const relationships = parseRelationships(relsXml);
  const drawingTargets = Object.values(relationships).filter((target) =>
    target.includes('drawing'),
  );
  const images: WorkbookImage[] = [];
  const warnings: WorkbookImageWarning[] = [];

  for (const drawingTarget of drawingTargets) {
    try {
      const drawingPath = normalizeRelatedTarget(
        drawingTarget,
        'xl/worksheets',
      );
      const drawingXml = getText(drawingPath);
      if (!drawingXml) {
        warnings.push({
          message: `Skipped product image drawing ${drawingPath} because the drawing file is missing.`,
        });
        continue;
      }

      const drawingFileName = drawingPath.split('/').pop();
      const drawingRels = parseRelationships(
        getText(`xl/drawings/_rels/${drawingFileName}.rels`),
      );
      const anchorRegex =
        /<(?:xdr:)?(?:oneCellAnchor|twoCellAnchor)\b[\s\S]*?<\/(?:xdr:)?(?:oneCellAnchor|twoCellAnchor)>/g;

      for (const anchorMatch of drawingXml.matchAll(anchorRegex)) {
        const anchorXml = anchorMatch[0];
        const fromXml =
          anchorXml.match(/<(?:xdr:)?from>([\s\S]*?)<\/(?:xdr:)?from>/)?.[1] ??
          '';
        const rowIndex = numberFromTag(fromXml, 'row');
        const columnIndex = numberFromTag(fromXml, 'col');
        const sourceRow = rowIndex === null ? undefined : rowIndex + 1;
        const sourceColumn =
          columnIndex === null ? undefined : columnIndex + 1;
        const relationshipId = anchorXml.match(/r:embed="([^"]+)"/)?.[1];
        const imageTarget = relationshipId
          ? drawingRels[relationshipId]
          : undefined;

        if (rowIndex === null || columnIndex === null) {
          warnings.push({
            message:
              'Skipped product image because its Excel drawing anchor is missing a row or column.',
          });
          continue;
        }

        if (!imageTarget) {
          warnings.push({
            sourceRow,
            sourceColumn,
            message:
              'Skipped product image because its Excel drawing relationship is missing.',
          });
          continue;
        }

        const mediaPath = normalizeRelatedTarget(imageTarget, 'xl/drawings');
        const bytes = getBytes(mediaPath);
        const mimeType = mimeTypeForPath(mediaPath);

        if (!bytes) {
          warnings.push({
            sourceRow,
            sourceColumn,
            message: `Skipped product image ${mediaPath} because the image file is missing.`,
          });
          continue;
        }

        if (!mimeType) {
          warnings.push({
            sourceRow,
            sourceColumn,
            message: `Skipped product image ${mediaPath} because its format is unsupported.`,
          });
          continue;
        }

        images.push({
          sourceRow: rowIndex + 1,
          sourceColumn: columnIndex + 1,
          mimeType,
          mediaPath,
          dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
        });
      }
    } catch (error) {
      warnings.push({
        message: `Skipped product image drawing because it could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  return { images, warnings };
}

function numberFromTag(xml: string, tagName: string) {
  const match = xml.match(
    new RegExp(`<(?:xdr:)?${tagName}>(\\d+)<\\/(?:xdr:)?${tagName}>`),
  );
  if (!match) return null;

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function normalizeRelatedTarget(target: string, basePath: string) {
  if (target.startsWith('/')) {
    return target.slice(1);
  }

  if (target.startsWith('../')) {
    return `xl/${target.slice(3)}`;
  }

  if (target.startsWith('xl/')) {
    return target;
  }

  return `${basePath}/${target}`;
}

function mimeTypeForPath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  return '';
}

function normalizeWorkbookTarget(target = '') {
  if (target.startsWith('/')) {
    return target.slice(1);
  }

  return target.startsWith('xl/') ? target : `xl/${target}`;
}

function parseAttributes(input: string) {
  const attrs: Record<string, string> = {};
  const attrRegex = /([\w:]+)="([^"]*)"/g;

  for (const match of input.matchAll(attrRegex)) {
    attrs[match[1]] = decodeXml(match[2]);
  }

  return attrs;
}

function columnToNumber(ref: string) {
  const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase();
  if (!letters) {
    return 0;
  }

  return [...letters].reduce(
    (total, letter) => total * 26 + letter.charCodeAt(0) - 64,
    0,
  );
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, '');
}

function decodeXml(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
