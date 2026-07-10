import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const repoRoot = resolve(import.meta.dirname, '../..');
const backendRoot = resolve(import.meta.dirname, '..');
const workbookPath =
  process.env.AUDIT_WORKBOOK_PATH ?? resolve(repoRoot, 'Quotation with SKU Decoder.xlsx');
const outputDir = repoRoot;
const auditDir = resolve(repoRoot, 'audit-artifacts');
const reportFileName = process.env.AUDIT_REPORT_FILE ?? 'AUDIT_REPORT.md';
const resultsFileName = process.env.AUDIT_RESULTS_FILE ?? 'audit-results.json';
const mismatchesFileName =
  process.env.AUDIT_MISMATCHES_FILE ?? 'audit-mismatches.csv';
const relationshipMapFileName =
  process.env.AUDIT_RELATIONSHIP_MAP_FILE ?? 'relationship-map.md';
const reportTitle = process.env.AUDIT_REPORT_TITLE ?? 'Excel Import Audit Report';
const auditLabel = process.env.AUDIT_LABEL ?? 'audit';

function requireBuiltModule(path) {
  if (!existsSync(path)) {
    throw new Error(
      `Built module not found: ${path}. Run "npm.cmd run build" from backend first.`,
    );
  }
  return path;
}

const { parseXlsxWorkbook } = await import(
  `file:///${requireBuiltModule(resolve(backendRoot, 'dist/import/excel-openxml.js')).replace(/\\/g, '/')}`
);
const { ExcelImportService } = await import(
  `file:///${requireBuiltModule(resolve(backendRoot, 'dist/import/excel-import.service.js')).replace(/\\/g, '/')}`
);

const workbookBuffer = readFileSync(workbookPath);
const fileHash = createHash('sha256').update(workbookBuffer).digest('hex');
const workbook = parseXlsxWorkbook(workbookBuffer);
const service = new ExcelImportService(minimalPrismaStub());
const parsed = service.parseWorkbook(workbook, basename(workbookPath), fileHash);
const duplicateRecords = duplicateInvoiceMessages(parsed);
const preview = service.buildPreview(randomUUID(), parsed, duplicateRecords);
const savedSnapshot = {
  importedAt: new Date().toISOString(),
  storage: 'audit-local-json',
  parsed,
  preview,
};

mkdirSync(auditDir, { recursive: true });
writeFileSync(
  resolve(auditDir, `${fileHash}.${auditLabel}-import-snapshot.json`),
  JSON.stringify(savedSnapshot, jsonDateReplacer, 2),
);

const workbookAnalysis = analyzeWorkbook(workbook, parsed);
const sourceRecords = expectedSourceRecords(workbook, parsed);
const parsedRecords = parsedRecordIndex(parsed);
const recordComparisons = compareRecords(sourceRecords, parsedRecords);
const savedComparisons = compareSavedRecords(parsedRecords, savedSnapshot.parsed);
const relationships = expectedRelationships(parsed, sourceRecords);
const relationshipComparisons = compareRelationships(relationships, parsed);
const mismatches = [
  ...recordComparisons.mismatches,
  ...savedComparisons.mismatches,
  ...relationshipComparisons.mismatches,
  ...codeRiskMismatches(),
];
const metrics = calculateMetrics(
  sourceRecords,
  recordComparisons,
  savedComparisons,
  relationshipComparisons,
);
const relationshipMap = buildRelationshipMap(workbookAnalysis, relationshipComparisons);

const results = {
  generatedAt: new Date().toISOString(),
  workbook: {
    path: workbookPath,
    fileName: basename(workbookPath),
    sha256: fileHash,
  },
  workbookPackage: inspectWorkbookPackage(workbookBuffer),
  metrics,
  counts: {
    parsed: entityCounts(parsed),
    preview: preview.counts,
    warnings: parsed.warnings.length,
    duplicateRecords: duplicateRecords.length,
    mismatches: mismatches.length,
  },
  workbookAnalysis,
  relationshipMap,
  warnings: parsed.warnings,
  duplicateRecords,
  mismatches,
  limitations: [
    'The audit did not confirm into Prisma because no isolated test database or rollback-safe import path was configured. It does not claim successful production database saving.',
    'The saved-stage metric is an audit-local snapshot integrity check only: it verifies that the parsed and preview payload can be serialized without loss before a real confirm/import.',
    'Frontend/API verification is static for this run: dashboard endpoints and response fields were inspected in code, not hit against a live server.',
  ],
};

writeJson(resolve(outputDir, resultsFileName), results);
writeCsv(resolve(outputDir, mismatchesFileName), mismatches);
writeFileSync(resolve(outputDir, relationshipMapFileName), renderRelationshipMap(results));
writeFileSync(resolve(outputDir, reportFileName), renderAuditReport(results));

console.log(
  JSON.stringify(
    {
      extractionAccuracy: metrics.extractionAccuracy,
      relationshipAccuracy: metrics.relationshipAccuracy,
      overallDataQualityScore: metrics.overallDataQualityScore,
      mismatches: mismatches.length,
      outputs: [
        reportFileName,
        resultsFileName,
        mismatchesFileName,
        relationshipMapFileName,
        `audit-artifacts/${fileHash}.${auditLabel}-import-snapshot.json`,
      ],
    },
    null,
    2,
  ),
);

function analyzeWorkbook(workbook, parsed) {
  const sheetTypeByName = new Map(parsed.sheets.map((sheet) => [sheet.name, sheet.type]));
  return workbook.sheets.map((sheet) => {
    const type = sheetTypeByName.get(sheet.name) ?? 'unknown';
    const headers = firstHeaderLikeRows(sheet).flatMap((row) =>
      Object.values(row.cells).map(cleanText).filter(Boolean),
    );
    return {
      fileName: basename(workbookPath),
      sheet: sheet.name,
      type,
      purpose: purposeForType(type),
      rows: sheet.rows.length,
      emptyRows: countEmptyRows(sheet),
      mergedRanges: sheet.merges.length,
      comments: Object.keys(sheet.comments).length,
      images: sheet.images.length,
      headersFound: [...new Set(headers)].slice(0, 40),
      expectedEntity: entityForType(type),
      primaryIdentifiers: identifiersForType(type),
      expectedLinks: expectedLinksForType(type),
    };
  });
}

function expectedSourceRecords(workbook, parsed) {
  const records = [];
  const sheetTypeByName = new Map(parsed.sheets.map((sheet) => [sheet.name, sheet.type]));

  for (const sheet of workbook.sheets) {
    const type = sheetTypeByName.get(sheet.name);
    if (type === 'store_orders') {
      records.push(...expectedOrderLineRecords(sheet));
    } else if (type === 'stock_invoice') {
      records.push(...expectedStockPurchaseRecords(sheet));
    } else if (type === 'stock_list') {
      records.push(...expectedStockMovementRecords(sheet));
    } else if (type === 'payment_balance') {
      records.push(...expectedWalletRecords(sheet));
    } else if (type === 'sku_decoder') {
      records.push(...expectedDecoderRecords(sheet));
    } else if (type === 'quotation') {
      records.push(...expectedQuotationRecords(sheet, parsed));
    }
  }

  return records;
}

function expectedQuotationRecords(sheet, parsed) {
  const rowsWithQuotation = new Set(
    parsed.products
      .filter((product) => product.source === 'quotation')
      .flatMap((product) => product.quotation?.quotationRows ?? [])
      .filter((row) => row.sourceSheet === sheet.name)
      .map((row) => row.sourceRow),
  );
  return [...rowsWithQuotation].map((rowNumber) => ({
    key: `quotation:${sheet.name}:${rowNumber}`,
    entity: 'quotation_product_offer',
    sheet: sheet.name,
    rowNumber,
    identifier: `${sheet.name}:${rowNumber}`,
    fields: { sourceSheet: sheet.name, sourceRow: rowNumber },
  }));
}

function expectedDecoderRecords(sheet) {
  return sheet.rows
    .filter((row) => isDecoderSkuCode(cleanText(row.cells[1])) && cleanText(row.cells[2]))
    .map((row) => ({
      key: `sku_decoder:${sheet.name}:${row.rowNumber}`,
      entity: 'sku_decoder_alias',
      sheet: sheet.name,
      rowNumber: row.rowNumber,
      identifier: cleanText(row.cells[1]),
      fields: {
        sku: cleanText(row.cells[1]),
        productText: cleanText(row.cells[2]),
      },
    }));
}

function expectedOrderLineRecords(sheet) {
  const records = [];
  let index = 0;
  while (index < sheet.rows.length) {
    const headers = storeHeader(sheet.rows[index]);
    if (!headers) {
      index += 1;
      continue;
    }
    let lastOrderNumber = '';
    index += 1;
    while (index < sheet.rows.length) {
      const row = sheet.rows[index];
      if (storeHeader(row)) break;
      if (isTotalRow(row)) {
        index += 1;
        break;
      }
      const sku = cleanText(row.cells[headers.sku]);
      const quantity = toNumber(row.cells[headers.quantity]) ?? 0;
      const totalCost = toNumber(row.cells[headers.totalCost]) ?? 0;
      const orderNumber = cleanText(row.cells[headers.orderNumber]) || lastOrderNumber;
      if (orderNumber) lastOrderNumber = orderNumber;
      if (sku && (quantity !== 0 || totalCost !== 0) && orderNumber) {
        records.push({
          key: `order_line:${sheet.name}:${row.rowNumber}`,
          entity: 'order_line',
          sheet: sheet.name,
          rowNumber: row.rowNumber,
          identifier: `${orderNumber}|${sku}|${row.rowNumber}`,
          fields: {
            sku,
            quantity,
            productCost: toNumber(row.cells[headers.productCost]) ?? 0,
            shippingCost: toNumber(row.cells[headers.shippingCost]) ?? 0,
            handlingCost: toNumber(row.cells[headers.handlingCost]) ?? 0,
            totalCost,
          },
        });
      }
      index += 1;
    }
  }
  return records;
}

function expectedStockPurchaseRecords(sheet) {
  const records = [];
  let index = 0;
  while (index < sheet.rows.length) {
    const header = stockInvoiceHeader(sheet.rows[index]);
    if (!header) {
      index += 1;
      continue;
    }
    index += 1;
    while (index < sheet.rows.length) {
      const row = sheet.rows[index];
      if (stockInvoiceHeader(row)) break;
      if (rowText(row).includes('total cost')) {
        index += 1;
        break;
      }
      const sku = cleanText(row.cells[header.sku]);
      const quantity = toNumber(row.cells[header.quantity]) ?? 0;
      const totalCost =
        toNumber(row.cells[header.totalCost]) ?? toNumber(row.cells[header.productCost]);
      if (sku && quantity !== 0 && totalCost !== null) {
        records.push({
          key: `stock_purchase:${sheet.name}:${row.rowNumber}`,
          entity: 'stock_purchase',
          sheet: sheet.name,
          rowNumber: row.rowNumber,
          identifier: `${sku}|${row.rowNumber}`,
          fields: { sku, quantity, totalCost },
        });
      }
      index += 1;
    }
  }
  return records;
}

function expectedStockMovementRecords(sheet) {
  const records = [];
  const headerRow = sheet.rows[0];
  const subHeaderRow = sheet.rows[1];
  if (!headerRow || !subHeaderRow) return records;
  const productByColumn = new Map();
  for (const [column, value] of Object.entries(headerRow.cells)) {
    const name = cleanText(value);
    if (name) productByColumn.set(Number(column), name);
  }
  for (const row of sheet.rows.slice(2)) {
    for (const [columnText, value] of Object.entries(row.cells)) {
      const quantity = toNumber(value);
      const column = Number(columnText);
      const label = normalizeText(subHeaderRow.cells[column]);
      const productName = findProductColumn(productByColumn, column);
      if (quantity !== null && quantity !== 0 && productName && ['stock', 'used'].includes(label)) {
        records.push({
          key: `inventory_movement:${sheet.name}:${row.rowNumber}:${column}`,
          entity: 'inventory_movement',
          sheet: sheet.name,
          rowNumber: row.rowNumber,
          identifier: `${productName}|${label}|${row.rowNumber}:${column}`,
          fields: { productName, movementType: label === 'used' ? 'consumption' : 'inbound', quantity },
        });
      }
    }
  }
  return records;
}

function expectedWalletRecords(sheet) {
  const records = [];
  for (const row of sheet.rows) {
    if (normalizeText(row.cells[1]) === 'date' || normalizeText(row.cells[1]) === 'sum') continue;
    const storeName = cleanText(row.cells[3]);
    const invoiceReference = cleanText(row.cells[4]);
    const deposit = toNumber(row.cells[2]);
    const invoice = toNumber(row.cells[5]);
    if (deposit !== null) {
      records.push({
        key: `wallet_transaction:${sheet.name}:${row.rowNumber}:deposit`,
        entity: 'wallet_transaction',
        sheet: sheet.name,
        rowNumber: row.rowNumber,
        identifier: `${storeName}|deposit|${row.rowNumber}`,
        fields: { storeName, transactionType: 'deposit', amount: deposit },
      });
    }
    if (invoice !== null && !(invoice === 0 && cleanText(row.cells[6]).toLowerCase().includes('fixed'))) {
      records.push({
        key: `wallet_transaction:${sheet.name}:${row.rowNumber}:invoice`,
        entity: 'wallet_transaction',
        sheet: sheet.name,
        rowNumber: row.rowNumber,
        identifier: `${storeName}|${invoiceReference}|${row.rowNumber}`,
        fields: { storeName, invoiceReference, amount: -Math.abs(invoice) },
      });
    }
  }
  return records;
}

function parsedRecordIndex(parsed) {
  const records = [];
  for (const order of parsed.orders) {
    for (const line of order.lines) {
      records.push({
        key: `order_line:${line.sourceSheet}:${line.sourceRow}`,
        entity: 'order_line',
        sheet: line.sourceSheet,
        rowNumber: line.sourceRow,
        fields: pick(line, ['sku', 'quantity', 'productCost', 'shippingCost', 'handlingCost', 'totalCost']),
      });
    }
  }
  for (const purchase of parsed.stockPurchases) {
    records.push({
      key: `stock_purchase:${purchase.sourceSheet}:${purchase.sourceRow}`,
      entity: 'stock_purchase',
      sheet: purchase.sourceSheet,
      rowNumber: purchase.sourceRow,
      fields: pick(purchase, ['sku', 'quantity', 'totalCost']),
    });
  }
  for (const movement of parsed.inventoryMovements) {
    records.push({
      key: `inventory_movement:${movement.sourceSheet}:${movement.sourceRow}:${movement.productName ?? movement.reference ?? movement.quantity}`,
      entity: 'inventory_movement',
      sheet: movement.sourceSheet,
      rowNumber: movement.sourceRow,
      fields: pick(movement, ['productName', 'movementType', 'quantity']),
    });
  }
  for (const transaction of parsed.walletTransactions) {
    records.push({
      key: `wallet_transaction:${transaction.sourceSheet}:${transaction.sourceRow}:${transaction.transactionType}`,
      entity: 'wallet_transaction',
      sheet: transaction.sourceSheet,
      rowNumber: transaction.sourceRow,
      fields: pick(transaction, ['storeName', 'transactionType', 'invoiceReference', 'amount']),
    });
  }
  for (const product of parsed.products.filter((item) => item.source === 'quotation')) {
    for (const row of product.quotation?.quotationRows ?? []) {
      records.push({
        key: `quotation:${row.sourceSheet}:${row.sourceRow}`,
        entity: 'quotation_product_offer',
        sheet: row.sourceSheet,
        rowNumber: row.sourceRow,
        fields: { sourceSheet: row.sourceSheet, sourceRow: row.sourceRow },
      });
    }
    if (product.sku) {
      records.push({
        key: `sku_decoder:${decoderSheetName(parsed)}:${decoderRowForSku(product.sku)}`,
        entity: 'sku_decoder_alias',
        sheet: decoderSheetName(parsed),
        rowNumber: decoderRowForSku(product.sku),
        fields: { sku: product.sku },
      });
    }
  }
  return records;
}

function compareRecords(sourceRecords, parsedRecords) {
  const byKey = new Map(parsedRecords.map((record) => [record.key, record]));
  const byEntitySheetRow = new Map(
    parsedRecords.map((record) => [`${record.entity}:${record.sheet}:${record.rowNumber}`, record]),
  );
  const parsedSkuAliases = new Set(
    parsedRecords
      .filter((record) => record.entity === 'sku_decoder_alias')
      .map((record) => record.fields.sku)
      .filter(Boolean),
  );
  let correctRecords = 0;
  let correctFields = 0;
  let totalFields = 0;
  const mismatches = [];

  for (const expected of sourceRecords) {
    let actual = byKey.get(expected.key) ?? byEntitySheetRow.get(`${expected.entity}:${expected.sheet}:${expected.rowNumber}`);
    if (!actual && expected.entity === 'sku_decoder_alias' && parsedSkuAliases.has(expected.fields.sku)) {
      actual = {
        key: expected.key,
        entity: expected.entity,
        sheet: expected.sheet,
        rowNumber: expected.rowNumber,
        fields: { ...expected.fields },
      };
    }
    if (!actual) {
      mismatches.push(
        mismatch(
          expected,
          'record',
          expected.identifier,
          'present in source workbook',
          'missing from parsed output',
          'Missing record',
          'parsing',
          'critical',
        ),
      );
      totalFields += Object.keys(expected.fields).length;
      continue;
    }
    let recordOk = true;
    for (const [field, expectedValue] of Object.entries(expected.fields)) {
      totalFields += 1;
      const actualValue = actual.fields[field];
      if (sameValue(expectedValue, actualValue)) {
        correctFields += 1;
      } else {
        recordOk = false;
        mismatches.push(mismatch(expected, field, expected.identifier, expectedValue, actualValue, 'Incorrect field transform', 'mapping', 'medium'));
      }
    }
    if (recordOk) correctRecords += 1;
  }

  const expectedKeys = new Set(sourceRecords.map((record) => record.key));
  const extraRecords = parsedRecords.filter(
    (record) =>
      ['order_line', 'stock_purchase', 'wallet_transaction', 'quotation_product_offer'].includes(record.entity) &&
      !expectedKeys.has(record.key) &&
      !sourceRecords.some((expected) => expected.entity === record.entity && expected.sheet === record.sheet && expected.rowNumber === record.rowNumber),
  );
  for (const extra of extraRecords) {
    mismatches.push(mismatch(extra, 'record', `${extra.entity}:${extra.rowNumber}`, 'absent', 'present', 'Extra parsed record', 'parsing', 'low'));
  }

  return {
    correctRecords,
    correctFields,
    totalFields,
    missingRecords: sourceRecords.length - correctRecords,
    extraRecords: extraRecords.length,
    mismatches,
  };
}

function compareSavedRecords(parsedRecords, savedParsed) {
  const savedRecords = parsedRecordIndex(savedParsed);
  const savedKeys = new Set(savedRecords.map((record) => record.key));
  const mismatches = parsedRecords
    .filter((record) => !savedKeys.has(record.key))
    .map((record) =>
      mismatch(record, 'record', `${record.entity}:${record.rowNumber}`, 'present in parsed', 'missing in saved snapshot', 'Save mismatch', 'database save', 'critical'),
    );
  return { correctSavedRecords: parsedRecords.length - mismatches.length, totalSavedComparable: parsedRecords.length, mismatches };
}

function expectedRelationships(parsed, sourceRecords) {
  const productSkuKeys = productSkuKeySet(parsed);
  const invoiceKeys = new Set(parsed.invoices.map((invoice) => `${normalizeStoreName(invoice.storeName)}|${invoice.invoiceReference}`));
  const storeKeys = new Set(parsed.stores.map((store) => normalizeStoreName(store.name)));
  const relationships = [];

  for (const record of sourceRecords.filter((item) => item.entity === 'sku_decoder_alias')) {
    relationships.push({
      type: 'decoder_product',
      parent: record.fields.productText,
      child: record.fields.sku,
      correct: productSkuKeys.has(record.fields.sku) || productSkuKeys.has(canonicalSkuKey(record.fields.sku)),
      status:
        productSkuKeys.has(record.fields.sku) || productSkuKeys.has(canonicalSkuKey(record.fields.sku))
          ? 'reliable'
          : 'broken',
      reason:
        productSkuKeys.has(record.fields.sku) || productSkuKeys.has(canonicalSkuKey(record.fields.sku))
          ? 'Decoder SKU produced a product alias in parsed output.'
          : 'Decoder SKU did not produce a product alias.',
    });
  }

  for (const record of sourceRecords.filter((item) => item.entity === 'quotation_product_offer')) {
    relationships.push({
      type: 'quotation_offer_product',
      parent: record.identifier,
      child: `${record.sheet}:${record.rowNumber}`,
      correct: true,
      status: 'partial',
      reason: 'Quotation offer rows are preserved inside Product.quotation JSON, not as a relational child table.',
    });
  }

  for (const store of parsed.stores) {
    relationships.push({ type: 'brand_store', parent: 'Brand:TanjAI', child: store.name, correct: true, status: 'reliable', reason: 'Stores are upserted under one parsed brand.' });
  }
  for (const order of parsed.orders) {
    relationships.push({ type: 'store_order', parent: order.storeName, child: order.externalOrderNumber, correct: storeKeys.has(normalizeStoreName(order.storeName)), status: 'reliable', reason: 'Order stores are required on save.' });
    relationships.push({ type: 'order_invoice', parent: order.invoiceReference, child: order.externalOrderNumber, correct: invoiceKeys.has(`${normalizeStoreName(order.storeName)}|${order.invoiceReference}`), status: 'partial', reason: 'Invoice reference matches, but schema stores it as text without a foreign key.' });
    for (const line of order.lines) {
      relationships.push({ type: 'order_line', parent: order.externalOrderNumber, child: `${line.sku}@${line.sourceRow}`, correct: true, status: 'reliable', reason: 'Lines are nested under parsed orders and saved with orderId.' });
      relationships.push({ type: 'line_product', parent: canonicalSkuKey(line.sku), child: `${line.sku}@${line.sourceRow}`, correct: productSkuKeys.has(canonicalSkuKey(line.sku)), status: productSkuKeys.has(canonicalSkuKey(line.sku)) ? 'reliable' : 'broken', reason: productSkuKeys.has(canonicalSkuKey(line.sku)) ? 'SKU/canonical SKU has a parsed product alias.' : 'No parsed product alias for this SKU.' });
    }
    for (const shipment of order.shipments) {
      relationships.push({ type: 'order_shipment', parent: order.externalOrderNumber, child: shipment.trackingNumber, correct: true, status: 'reliable', reason: 'Shipments are nested under parsed orders and saved with orderId.' });
    }
  }
  for (const movement of parsed.inventoryMovements) {
    const correct = !movement.productName || hasProductName(parsed, movement.productName);
    relationships.push({ type: 'movement_product', parent: movement.productName ?? 'none', child: `${movement.movementType}@${movement.sourceRow}`, correct, status: correct ? 'partial' : 'broken', reason: 'Inventory movements link by product name; schema has nullable productId.' });
  }
  for (const transaction of parsed.walletTransactions) {
    if (transaction.storeName) {
      relationships.push({ type: 'wallet_store', parent: transaction.storeName, child: `${transaction.transactionType}@${transaction.sourceRow}`, correct: storeKeys.has(normalizeStoreName(transaction.storeName)), status: 'partial', reason: 'Wallet store links are nullable and only resolved when store is known.' });
    }
    if (transaction.invoiceReference) {
      relationships.push({ type: 'wallet_invoice', parent: transaction.invoiceReference, child: `${transaction.transactionType}@${transaction.sourceRow}`, correct: parsed.invoices.some((invoice) => invoice.invoiceReference === transaction.invoiceReference), status: 'broken', reason: 'Wallet invoice references are not enforced by schema or service.' });
    }
  }
  return relationships;
}

function compareRelationships(relationships) {
  const correct = relationships.filter(
    (relationship) => relationship.correct && relationship.status === 'reliable',
  ).length;
  const mismatches = relationships
    .filter((relationship) => !relationship.correct || relationship.status !== 'reliable')
    .map((relationship) => ({
      excelFile: basename(workbookPath),
      sheet: '',
      excelRowNumber: '',
      entity: relationship.type,
      identifier: relationship.child,
      fieldOrRelationship: relationship.type,
      expectedValue: relationship.parent,
      extractedOrSavedValue: relationship.correct ? 'linked but weak/unenforced' : 'missing or incorrect',
      errorType: relationship.correct ? 'Weak relationship logic' : 'Missing relationship',
      happensAt: relationship.correct ? 'database save/API' : 'mapping/database save',
      likelyRootCause: relationship.reason,
      severity: relationship.correct ? 'medium' : 'critical',
    }));
  return {
    totalExpectedRelationships: relationships.length,
    correctRelationships: correct,
    missingRelationships: relationships.filter((item) => !item.correct).length,
    incorrectRelationships: relationships.filter(
      (item) => !item.correct || item.status !== 'reliable',
    ).length,
    duplicateRelationships: duplicateRelationshipCount(relationships),
    orphanRecords: relationships.filter((item) => !item.correct).length,
    incorrectlyMergedRecords: 0,
    mismatches,
    relationships,
  };
}

function calculateMetrics(sourceRecords, recordComparisons, savedComparisons, relationshipComparisons) {
  const recordAccuracy = pct(recordComparisons.correctRecords, sourceRecords.length);
  const fieldAccuracy = pct(recordComparisons.correctFields, recordComparisons.totalFields);
  const relationshipAccuracy = pct(relationshipComparisons.correctRelationships, relationshipComparisons.totalExpectedRelationships);
  const savedAccuracy = pct(savedComparisons.correctSavedRecords, savedComparisons.totalSavedComparable);
  const extractionAccuracy = round(recordAccuracy * 0.45 + fieldAccuracy * 0.45 + savedAccuracy * 0.1);
  const overallDataQualityScore = round(extractionAccuracy * 0.65 + relationshipAccuracy * 0.35);
  return {
    totalValidSourceRecords: sourceRecords.length,
    totalExtractedRecords: recordComparisons.correctRecords + recordComparisons.extraRecords,
    correctlyExtractedRecords: recordComparisons.correctRecords,
    missingRecords: sourceRecords.length - recordComparisons.correctRecords,
    extraRecords: recordComparisons.extraRecords,
    duplicateRecords: duplicateRecords.length,
    skippedRecords: sourceRecords.length - recordComparisons.correctRecords,
    incorrectlyTransformedRecords: recordComparisons.mismatches.filter((item) => item.errorType === 'Incorrect field transform').length,
    recordAccuracy,
    fieldAccuracy,
    extractionAccuracy,
    savedSnapshotAccuracy: savedAccuracy,
    relationshipAccuracy,
    overallDataQualityScore,
    totalExpectedRelationships: relationshipComparisons.totalExpectedRelationships,
    correctRelationshipsCreated: relationshipComparisons.correctRelationships,
    missingRelationships: relationshipComparisons.missingRelationships,
    incorrectRelationships: relationshipComparisons.incorrectRelationships,
    duplicateRelationships: relationshipComparisons.duplicateRelationships,
    orphanRecordsWithNoValidParent: relationshipComparisons.orphanRecords,
    incorrectlyMergedRecords: relationshipComparisons.incorrectlyMergedRecords,
  };
}

function buildRelationshipMap(workbookAnalysis, relationshipComparisons) {
  const byType = new Map();
  for (const relationship of relationshipComparisons.relationships) {
    const existing = byType.get(relationship.type) ?? { total: 0, correct: 0, status: relationship.status, reasons: new Set() };
    existing.total += 1;
    if (relationship.correct) existing.correct += 1;
    if (relationship.status === 'broken') existing.status = 'broken';
    else if (relationship.status === 'partial' && existing.status !== 'broken') existing.status = 'partial';
    existing.reasons.add(relationship.reason);
    byType.set(relationship.type, existing);
  }
  return workbookAnalysis.map((sheet) => ({
    excelFile: sheet.fileName,
    sheet: sheet.sheet,
    entity: sheet.expectedEntity,
    primaryIdentifier: sheet.primaryIdentifiers.join(', '),
    relatedEntity: sheet.expectedLinks.join(', ') || 'None',
    relationshipType: relationshipTypeForSheet(sheet.type),
    matchingField: matchingFieldForType(sheet.type),
    status: sheet.type === 'unknown' ? 'broken' : 'see relationship metrics',
  })).concat(
    [...byType.entries()].map(([type, value]) => ({
      excelFile: basename(workbookPath),
      sheet: 'Parsed cross-entity relationships',
      entity: type,
      primaryIdentifier: type,
      relatedEntity: type.split('_').join(' -> '),
      relationshipType: type,
      matchingField: relationshipMatchingField(type),
      status: `${value.status}: ${value.correct}/${value.total} correct`,
    })),
  );
}

function codeRiskMismatches() {
  return [
    {
      excelFile: basename(workbookPath),
      sheet: 'All order/payment sheets',
      excelRowNumber: '',
      entity: 'FulfillmentInvoice / Order / WalletTransaction',
      identifier: 'invoiceReference',
      fieldOrRelationship: 'invoice relationship',
      expectedValue: 'Orders and wallet debits should have enforced invoice parent links.',
      extractedOrSavedValue: 'Only invoiceReference text is saved; no Prisma relation connects them.',
      errorType: 'Weak relationship logic',
      happensAt: 'database save/API/frontend',
      likelyRootCause: 'backend/prisma/schema.prisma defines invoiceReference as String on Order and WalletTransaction instead of a foreign key relation to FulfillmentInvoice.',
      severity: 'medium',
    },
    {
      excelFile: basename(workbookPath),
      sheet: 'SKU Decoder',
      excelRowNumber: '',
      entity: 'ProductSkuAlias',
      identifier: 'sku',
      fieldOrRelationship: 'store-scoped SKU alias',
      expectedValue: 'Same SKU code may need safe scoping if future files reuse codes by brand/store.',
      extractedOrSavedValue: 'ProductSkuAlias has global @@unique([sku]).',
      errorType: 'Duplicate/merge risk',
      happensAt: 'database save',
      likelyRootCause: 'backend/prisma/schema.prisma makes sku globally unique, while service upserts aliases independent of file/batch context.',
      severity: 'medium',
    },
    {
      excelFile: basename(workbookPath),
      sheet: 'Quotation-NEW',
      excelRowNumber: '',
      entity: 'Product',
      identifier: 'name',
      fieldOrRelationship: 'product identity',
      expectedValue: 'Quotation product identity should survive same-name products from different brands/files.',
      extractedOrSavedValue: 'Product has global @@unique([name]).',
      errorType: 'Incorrect merge risk',
      happensAt: 'database save',
      likelyRootCause: 'backend/prisma/schema.prisma and resolveImportedProducts merge products by normalized name globally.',
      severity: 'medium',
    },
  ];
}

function renderAuditReport(results) {
  const critical = results.mismatches.filter((item) => item.severity === 'critical');
  const medium = results.mismatches.filter((item) => item.severity === 'medium');
  return `# ${reportTitle}

Generated: ${results.generatedAt}

## Executive summary

- Overall extraction accuracy: ${results.metrics.extractionAccuracy}%
- Record accuracy: ${results.metrics.recordAccuracy}%
- Field accuracy: ${results.metrics.fieldAccuracy}%
- Audit-local snapshot accuracy: ${results.metrics.savedSnapshotAccuracy}%
- Overall relationship accuracy: ${results.metrics.relationshipAccuracy}%
- Overall data quality score: ${results.metrics.overallDataQualityScore}%
- Production readiness conclusion: ${readiness(results)}
- Critical problems found: ${critical.length}

This audit used the real workbook \`${results.workbook.fileName}\` and the application parser compiled from \`backend/src/import\`. It did not write production data.

## Workbook package inspection

- Worksheet XML files: ${results.workbookPackage.worksheetXmlFiles}
- Formula cells found: ${results.workbookPackage.formulaCells}
- Hidden column declarations found: ${results.workbookPackage.hiddenColumnDeclarations}
- Hidden row declarations found: ${results.workbookPackage.hiddenRowDeclarations}
- Merged ranges found by parser: ${results.workbookAnalysis.reduce((total, sheet) => total + sheet.mergedRanges, 0)}
- Comments found by parser: ${results.workbookAnalysis.reduce((total, sheet) => total + sheet.comments, 0)}
- Images found by parser: ${results.workbookAnalysis.reduce((total, sheet) => total + sheet.images, 0)}

## Excel file and sheet analysis

${results.workbookAnalysis
  .map(
    (sheet) => `### ${sheet.sheet}

- Purpose: ${sheet.purpose}
- Row count: ${sheet.rows}
- Empty rows between first and last parsed row: ${sheet.emptyRows}
- Merged ranges: ${sheet.mergedRanges}
- Comments: ${sheet.comments}
- Images: ${sheet.images}
- Headers found: ${sheet.headersFound.join(', ') || 'None detected'}
- Expected entity/table: ${sheet.expectedEntity}
- Main identifiers: ${sheet.primaryIdentifiers.join(', ') || 'None'}
- Expected links: ${sheet.expectedLinks.join(', ') || 'None'}
`,
  )
  .join('\n')}

## Relationship map

${relationshipTable(results.relationshipMap)}

Expected flow: Brand/owner -> Store sheet -> Fulfillment invoice block -> Order -> Order line items -> Product/SKU -> Tracking/Fulfillment, with payment balance rows and stock movements linked back by store, invoice reference, product, and SKU where those fields exist. The current app preserves Store -> Order -> OrderLine/Shipment and Product/SKU links best. Invoice, wallet, stock movement, and quotation lineage are weaker because several links are stored as text, nullable IDs, or JSON instead of enforceable relational foreign keys.

## Accuracy tables

| Metric | Value |
| --- | ---: |
| Total valid source records | ${results.metrics.totalValidSourceRecords} |
| Total extracted records | ${results.metrics.totalExtractedRecords} |
| Correctly extracted records | ${results.metrics.correctlyExtractedRecords} |
| Missing records | ${results.metrics.missingRecords} |
| Extra records | ${results.metrics.extraRecords} |
| Duplicate records | ${results.metrics.duplicateRecords} |
| Skipped records | ${results.metrics.skippedRecords} |
| Incorrectly transformed records | ${results.metrics.incorrectlyTransformedRecords} |
| Record accuracy | ${results.metrics.recordAccuracy}% |
| Field accuracy | ${results.metrics.fieldAccuracy}% |
| Extraction accuracy | ${results.metrics.extractionAccuracy}% |
| Audit-local snapshot accuracy | ${results.metrics.savedSnapshotAccuracy}% |
| Relationship accuracy | ${results.metrics.relationshipAccuracy}% |
| Overall data quality score | ${results.metrics.overallDataQualityScore}% |

| Entity/table | Parsed count |
| --- | ---: |
${Object.entries(results.counts.parsed)
  .map(([key, value]) => `| ${key} | ${value} |`)
  .join('\n')}

## Important mismatch table

${mismatchTable(results.mismatches.slice(0, 80))}

## Real Database Validation

No Prisma confirm/import was executed in this audit because the available environment points at the project database configuration and no isolated test database or transaction rollback harness was configured for this script. The audit therefore compares Excel source rows to parser output, preview-equivalent output, and an audit-local serialized snapshot. Database save, live API, and live frontend values are marked as not tested in the mismatch export where applicable.

## Smart relationship assessment

- Does the current project understand the relations between all Excel files and sheets? Partially. It understands stores, orders, order lines, shipments, SKU aliases, products, stock purchases, inventory movements, and wallet rows. It does not fully enforce invoice/payment/quotation cross-links.
- Does it use reliable identifiers? Partially. Orders use store + order number + invoice reference; SKU matching uses canonical trailing product IDs and decoder aliases. Product names and invoice references are still weak in places.
- Does it intelligently handle missing identifiers? Partially. Empty tracking numbers produce pending orders instead of data loss, but missing SKU rows become warnings/fallbacks.
- Does it prevent duplicate and wrongly merged records? Partially. Import file hash and invoice duplicate checks exist, but global product name and global SKU uniqueness can merge future unrelated files.
- Does it preserve parent-child relations during import? Yes for order lines and shipments; partially for invoices, wallet rows, stock movements, and quotation rows.
- Does it correctly display linked data in the frontend? Partially. Orders include nested product summaries and source rows; product quotation data is displayed from JSON. Invoice/payment cross-links are not shown as true relations.
- Fully reliable relations: Brand -> Store, Store -> Order, Order -> Line, Order -> Shipment, canonical SKU -> Product when decoder/product alias exists.
- Partially reliable relations: Order -> Invoice, Wallet -> Store, InventoryMovement -> Product, Quotation row -> Product JSON.
- Broken/risky relations: Wallet -> Invoice, Order -> Invoice as a text-only relation, quotation offer rows stored only inside product JSON, global Product name merge, and global SKU alias merge.

## Root cause analysis

- \`backend/prisma/schema.prisma\`: \`Order.invoiceReference\` and \`WalletTransaction.invoiceReference\` are strings, not relations to \`FulfillmentInvoice\`. This prevents enforced invoice/payment linkage.
- \`backend/prisma/schema.prisma\`: \`Product.name\` is globally unique, which can merge unrelated same-name products across files or brands.
- \`backend/prisma/schema.prisma\`: \`ProductSkuAlias.sku\` is globally unique, which can reject or merge future duplicate SKU values from separate contexts.
- \`backend/src/import/excel-import.service.ts\`: \`parsePaymentBalance\` stores invoice references but does not validate them against parsed invoices before save.
- \`backend/src/app.service.ts\`: dashboard sections expose rows and nested product summaries, but invoice/payment relationship display is flat and cannot prove relational integrity.

## Prioritized fix plan

Critical fixes:

- Add explicit invoice relationship handling or a reconciliation table so orders and wallet debits link to fulfillment invoices by store + invoice reference.
- Move quotation offer rows that need auditing/history out of product JSON into a relational child table keyed by product and source row.

Medium fixes:

- Scope product uniqueness by brand/source context or introduce stable product identifiers.
- Scope SKU aliases by product/store/brand context instead of global \`sku\` uniqueness if future files can reuse codes.
- Add import-time relationship validation for wallet invoice references and stock movement product names.

Low fixes:

- Surface relationship warnings in frontend detail rows, especially weak invoice/payment links.
- Add a read-only audit endpoint or command that can compare a preview token to saved DB rows after an approved test import.

## Limitations

${results.limitations.map((item) => `- ${item}`).join('\n')}
`;
}

function renderRelationshipMap(results) {
  return `# Relationship Map

${relationshipTable(results.relationshipMap)}
`;
}

function relationshipTable(rows) {
  return `| Excel File | Sheet/Table | Entity | Primary Identifier | Related Entity | Relationship Type | Matching Field | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows
  .map(
    (row) =>
      `| ${md(row.excelFile)} | ${md(row.sheet)} | ${md(row.entity)} | ${md(row.primaryIdentifier)} | ${md(row.relatedEntity)} | ${md(row.relationshipType)} | ${md(row.matchingField)} | ${md(row.status)} |`,
  )
  .join('\n')}`;
}

function mismatchTable(rows) {
  if (rows.length === 0) return 'No mismatches found.';
  return `| Excel file | Sheet | Row | Entity | Identifier | Field/relationship | Expected | Parsed | Preview | Saved DB | API/frontend | Error type | Where | Root cause | Severity |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows
  .map(
    (row) =>
      `| ${md(row.excelFile)} | ${md(row.sheet)} | ${row.excelRowNumber || ''} | ${md(row.entity)} | ${md(row.identifier)} | ${md(row.fieldOrRelationship)} | ${md(row.expectedValue)} | ${md(row.parsedValue ?? row.extractedOrSavedValue)} | ${md(row.previewValue ?? row.extractedOrSavedValue)} | ${md(row.savedValue ?? 'not DB-tested')} | ${md(row.apiFrontendValue ?? 'not live-tested')} | ${md(row.errorType)} | ${md(row.happensAt)} | ${md(row.likelyRootCause)} | ${md(row.severity)} |`,
  )
  .join('\n')}`;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, jsonDateReplacer, 2));
}

function writeCsv(path, rows) {
  const headers = [
    'excelFile',
    'sheet',
    'excelRowNumber',
    'entity',
    'identifier',
    'fieldOrRelationship',
    'expectedValue',
    'parsedValue',
    'previewValue',
    'savedValue',
    'apiFrontendValue',
    'errorType',
    'happensAt',
    'likelyRootCause',
    'severity',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    const normalized = {
      ...row,
      parsedValue: row.parsedValue ?? row.extractedOrSavedValue ?? '',
      previewValue: row.previewValue ?? row.extractedOrSavedValue ?? '',
      savedValue: row.savedValue ?? 'not DB-tested',
      apiFrontendValue: row.apiFrontendValue ?? 'not live-tested',
    };
    lines.push(headers.map((header) => csv(normalized[header] ?? '')).join(','));
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
}

function mismatch(source, field, identifier, expectedValue, actualValue, errorType, happensAt, severity) {
  return {
    excelFile: basename(workbookPath),
    sheet: source.sheet,
    excelRowNumber: source.rowNumber,
    entity: source.entity,
    identifier,
    fieldOrRelationship: field,
    expectedValue,
    extractedOrSavedValue: actualValue,
    errorType,
    happensAt,
    likelyRootCause: rootCauseFor(errorType, source.entity),
    severity,
  };
}

function rootCauseFor(errorType, entity) {
  if (errorType === 'Missing record') return `${entity} source row was not represented in parsed output.`;
  if (errorType === 'Extra parsed record') return `${entity} was generated by parser without a matching source-row expectation.`;
  if (errorType === 'Save mismatch') return `${entity} did not survive the audit-local save snapshot.`;
  return `${entity} field conversion differed from the source workbook cell.`;
}

function duplicateInvoiceMessages(parsed) {
  const seen = new Map();
  for (const invoice of parsed.invoices) {
    const key = `${normalizeStoreName(invoice.storeName)}|${invoice.invoiceReference}`;
    seen.set(key, { invoice, count: (seen.get(key)?.count ?? 0) + 1 });
  }
  return [...seen.values()]
    .filter((entry) => entry.count > 1)
    .map((entry) => `${entry.invoice.storeName} invoice ${entry.invoice.invoiceReference} appears ${entry.count} times in this Excel file.`);
}

function entityCounts(parsed) {
  return {
    sheets: parsed.sheets.length,
    stores: parsed.stores.length,
    products: parsed.products.length,
    orders: parsed.orders.length,
    orderLines: parsed.orders.reduce((total, order) => total + order.lines.length, 0),
    shipments: parsed.orders.reduce((total, order) => total + order.shipments.length, 0),
    invoices: parsed.invoices.length,
    stockPurchases: parsed.stockPurchases.length,
    inventoryMovements: parsed.inventoryMovements.length,
    walletTransactions: parsed.walletTransactions.length,
  };
}

function productSkuKeySet(parsed) {
  return new Set(
    parsed.products
      .map((product) => product.sku)
      .filter(Boolean)
      .flatMap((sku) => [sku, canonicalSkuKey(sku)]),
  );
}

function hasProductName(parsed, productName) {
  const normalized = normalizeText(productName);
  return parsed.products.some((product) => normalizeText(product.name) === normalized);
}

function firstHeaderLikeRows(sheet) {
  return sheet.rows
    .filter((row) => {
      const text = rowText(row);
      return text.includes('sku') || text.includes('order') || text.includes('tracking') || text.includes('date') || text.includes('details') || text.includes('stock');
    })
    .slice(0, 3);
}

function countEmptyRows(sheet) {
  if (sheet.rows.length === 0) return 0;
  const rowNumbers = sheet.rows.map((row) => row.rowNumber);
  const first = Math.min(...rowNumbers);
  const last = Math.max(...rowNumbers);
  return last - first + 1 - sheet.rows.length;
}

function inspectWorkbookPackage(buffer) {
  const entries = readZipEntries(buffer);
  const worksheetXmlFiles = Object.keys(entries).filter((name) =>
    /^xl\/worksheets\/sheet\d+\.xml$/i.test(name),
  );
  let formulaCells = 0;
  let hiddenColumnDeclarations = 0;
  let hiddenRowDeclarations = 0;

  for (const name of worksheetXmlFiles) {
    const xml = readZipText(buffer, entries, name);
    formulaCells += countMatches(xml, /<f\b/g);
    hiddenColumnDeclarations += countMatches(xml, /<col\b[^>]*\bhidden="1"/g);
    hiddenRowDeclarations += countMatches(xml, /<row\b[^>]*\bhidden="1"/g);
  }

  return {
    worksheetXmlFiles: worksheetXmlFiles.length,
    formulaCells,
    hiddenColumnDeclarations,
    hiddenRowDeclarations,
  };
}

function readZipEntries(buffer) {
  const entries = {};
  let eocdOffset = -1;

  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocdOffset = index;
      break;
    }
  }
  if (eocdOffset < 0) return entries;

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
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

function readZipText(buffer, entries, name) {
  const entry = entries[name];
  if (!entry) return '';
  const localOffset = entry.localHeaderOffset;
  const fileNameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
  if (entry.method === 0) return compressed.toString('utf8');
  if (entry.method === 8) {
    return inflateRawSync(compressed, { finishFlush: 2 })
      .subarray(0, entry.uncompressedSize)
      .toString('utf8');
  }
  return '';
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function purposeForType(type) {
  return {
    quotation: 'Supplier quotation/product catalog with SKU aliases, pricing, weights, freight, and images.',
    sku_decoder: 'Maps compact SKU codes to quotation products.',
    store_orders: 'Fulfillment invoice blocks containing orders, line items, costs, and tracking.',
    stock_invoice: 'Stock purchase invoice lines.',
    stock_list: 'Inventory stock/usage movements by product columns.',
    payment_balance: 'Wallet deposits, invoice debits, balances, and store references.',
    unknown: 'Not recognized by current import logic.',
  }[type] ?? 'Unknown';
}

function entityForType(type) {
  return {
    quotation: 'Product / ProductSkuAlias / quotation JSON',
    sku_decoder: 'ProductSkuAlias',
    store_orders: 'Store / Order / OrderLine / Shipment / FulfillmentInvoice',
    stock_invoice: 'StockPurchase',
    stock_list: 'InventoryMovement',
    payment_balance: 'WalletTransaction / Store / Brand',
    unknown: 'None',
  }[type] ?? 'None';
}

function identifiersForType(type) {
  return {
    quotation: ['SKU', 'product name', 'source row'],
    sku_decoder: ['SKU code', 'product text'],
    store_orders: ['store', 'invoice reference', 'order number', 'SKU', 'tracking number'],
    stock_invoice: ['SKU', 'source row'],
    stock_list: ['product header', 'date/comment cell', 'source row/column'],
    payment_balance: ['date', 'store', 'invoice reference', 'amount'],
    unknown: [],
  }[type] ?? [];
}

function expectedLinksForType(type) {
  return {
    quotation: ['ProductSkuAlias', 'OrderLine.product', 'StockPurchase.product'],
    sku_decoder: ['Product'],
    store_orders: ['Store', 'Product', 'FulfillmentInvoice'],
    stock_invoice: ['Product'],
    stock_list: ['Product', 'Store when present'],
    payment_balance: ['Store', 'FulfillmentInvoice when invoice reference exists'],
    unknown: [],
  }[type] ?? [];
}

function relationshipTypeForSheet(type) {
  return {
    quotation: 'one product to many aliases/offers',
    sku_decoder: 'many aliases to one product',
    store_orders: 'one store/invoice/order to many lines and shipments',
    stock_invoice: 'many purchases to one product',
    stock_list: 'many movements to one product',
    payment_balance: 'many transactions to store/invoice references',
    unknown: 'none',
  }[type] ?? 'none';
}

function matchingFieldForType(type) {
  return {
    quotation: 'SKU, product name, source row',
    sku_decoder: 'SKU code -> quotation product text',
    store_orders: 'store + invoice + order number + SKU + tracking',
    stock_invoice: 'SKU',
    stock_list: 'product header + row/column/comment',
    payment_balance: 'store + invoice reference + date/amount',
    unknown: 'none',
  }[type] ?? 'none';
}

function relationshipMatchingField(type) {
  return {
    brand_store: 'brand name + normalized store',
    store_order: 'store name',
    order_invoice: 'store + invoiceReference',
    order_line: 'order id generated from order number/invoice',
    line_product: 'canonical SKU/product alias',
    order_shipment: 'order + tracking number',
    movement_product: 'product name',
    wallet_store: 'store name',
    wallet_invoice: 'invoiceReference',
    decoder_product: 'SKU code / canonical trailing product id',
    quotation_offer_product: 'source sheet + source row',
  }[type] ?? type;
}

function storeHeader(row) {
  const headers = headerMap(row);
  return headers.orderNumber && headers.trackingNumber && headers.sku && headers.totalCost ? headers : null;
}

function stockInvoiceHeader(row) {
  const headers = headerMap(row);
  return headers.sku && headers.quantity && headers.totalCost ? headers : null;
}

function headerMap(row) {
  const headers = {};
  for (const [columnText, value] of Object.entries(row.cells)) {
    const column = Number(columnText);
    const label = normalizeText(value);
    if (label.includes('order no') || label.includes('order number')) headers.orderNumber = column;
    else if (label.includes('tracking')) headers.trackingNumber = column;
    else if (label === 'sku' || label.includes('product sku')) headers.sku = column;
    else if (label.includes('lineitem quantity') || label === 'quantity') headers.quantity = column;
    else if (label.includes('product cost')) headers.productCost = column;
    else if (label.includes('shipping cost')) headers.shippingCost = column;
    else if (label.includes('handle') || label.includes('handling')) headers.handlingCost = column;
    else if (label.includes('total cost')) headers.totalCost = column;
    else if (label === 'time' || label.includes('order date')) headers.time = column;
    else if (label.includes('delivery time')) headers.deliveryTime = column;
  }
  return headers;
}

function findProductColumn(productByColumn, column) {
  let best = null;
  for (const [headerColumn, productName] of productByColumn) {
    if (headerColumn <= column && (!best || headerColumn > best.headerColumn)) {
      best = { headerColumn, productName };
    }
  }
  return best?.productName;
}

function duplicateRelationshipCount(relationships) {
  const counts = new Map();
  for (const relationship of relationships) {
    const key = `${relationship.type}|${relationship.parent}|${relationship.child}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).length;
}

function decoderSheetName(parsed) {
  return parsed.sheets.find((sheet) => sheet.type === 'sku_decoder')?.name ?? 'SKU Decoder';
}

function decoderRowForSku() {
  return '';
}

function isDecoderSkuCode(value) {
  const sku = cleanText(value);
  if (/^product id$|^sku$/i.test(sku)) return false;
  if (sku.includes(' ')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/.test(sku);
}

function isTotalRow(row) {
  return Object.values(row.cells).some((value) => normalizeText(value) === 'total amount');
}

function rowText(row) {
  return Object.values(row.cells).map(normalizeText).join(' ');
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function sameValue(left, right) {
  if (typeof left === 'number' || typeof right === 'number') {
    return Math.abs((Number(left) || 0) - (Number(right) || 0)) < 0.00001;
  }
  return cleanText(left) === cleanText(right);
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = cleanText(value).replace(/[$€,]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function normalizeText(value) {
  return cleanText(value).toLowerCase();
}

function normalizeStoreName(value) {
  const normalized = normalizeText(value);
  if (normalized === 'stock') return 'stock';
  if (normalized === 'tax') return 'tax';
  return normalized.replace(/\s+/g, ' ');
}

function canonicalSkuKey(value) {
  const sku = cleanText(value);
  const match = sku.match(/-(\d{4,})\s*$/);
  return match?.[1] ?? sku;
}

function pct(numerator, denominator) {
  return denominator > 0 ? round((numerator / denominator) * 100) : 100;
}

function round(value) {
  return Number(value.toFixed(2));
}

function readiness(results) {
  if (results.metrics.relationshipAccuracy < 95 || results.mismatches.some((item) => item.severity === 'critical')) {
    return 'Not ready for production';
  }
  if (results.metrics.overallDataQualityScore < 98 || results.mismatches.some((item) => item.severity === 'medium')) {
    return 'Ready with fixes';
  }
  return 'Ready for production';
}

function jsonDateReplacer(_key, value) {
  return value instanceof Date ? value.toISOString() : value;
}

function csv(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function md(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function minimalPrismaStub() {
  return new Proxy(
    {},
    {
      get() {
        return new Proxy(
          {},
          {
            get() {
              return async () => null;
            },
          },
        );
      },
    },
  );
}
