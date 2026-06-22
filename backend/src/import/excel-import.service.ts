import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { gzip } from 'node:zlib';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PrismaService } from '../prisma.service';
import {
  ParsedWorkbook,
  WorkbookRow,
  WorkbookSheet,
  parseXlsxWorkbook,
} from './excel-openxml';
import {
  ImportPreview,
  ImportWarning,
  ParsedFulfillmentInvoice,
  ParsedImport,
  ParsedInventoryMovement,
  ParsedOrder,
  ParsedProduct,
  ParsedStockPurchase,
  ParsedStore,
  ParsedWalletTransaction,
  SheetType,
} from './import.types';

type UploadedExcelFile = {
  originalname: string;
  buffer?: Buffer;
  path?: string;
  size: number;
};

type HeaderMap = Record<string, number>;

const previewStore = new Map<
  string,
  { parsed: ParsedImport; preview: ImportPreview; createdAt: number }
>();

const previewTtlMs = 30 * 60 * 1000;
const gzipAsync = promisify(gzip);

@Injectable()
export class ExcelImportService {
  constructor(private readonly prisma: PrismaService) {}

  async preview(file: UploadedExcelFile): Promise<ImportPreview> {
    if (!file?.originalname?.toLowerCase().endsWith('.xlsx')) {
      throw new BadRequestException('Only .xlsx files are supported.');
    }

    try {
      const buffer = file.buffer ?? (await readFile(file.path ?? ''));
      const fileHash = createHash('sha256').update(buffer).digest('hex');
      let workbook: ParsedWorkbook;
      try {
        workbook = parseXlsxWorkbook(buffer);
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'Unable to parse XLSX file.',
        );
      }
      const parsed = this.parseWorkbook(workbook, file.originalname, fileHash);
      const duplicateRecords = await this.findDuplicateRecords(parsed);
      const token = randomUUID();
      const preview = this.buildPreview(token, parsed, duplicateRecords);

      this.clearExpiredPreviews();
      previewStore.set(token, { parsed, preview, createdAt: Date.now() });

      return preview;
    } finally {
      if (file.path) {
        await unlink(file.path).catch(() => undefined);
      }
    }
  }

  async previewLocalFile(fileName: string): Promise<ImportPreview> {
    if (!fileName?.toLowerCase().endsWith('.xlsx')) {
      throw new BadRequestException('Only .xlsx files are supported.');
    }

    const importDir = resolve(
      process.env.EXCEL_IMPORT_DIR || resolve(process.cwd(), '../../..'),
    );
    const safeName = basename(fileName);
    const filePath = resolve(importDir, safeName);

    if (!filePath.startsWith(importDir)) {
      throw new BadRequestException('Invalid Excel file path.');
    }

    const buffer = await readFile(filePath).catch(() => {
      throw new BadRequestException(
        `Excel file was not found in import directory: ${safeName}`,
      );
    });

    return this.preview({ originalname: safeName, buffer, size: buffer.length });
  }

  async confirm(token: string) {
    if (!token) {
      throw new BadRequestException('Import preview token is required.');
    }

    const entry = previewStore.get(token);

    if (!entry) {
      throw new NotFoundException('Import preview expired or was not found.');
    }

    if (process.env.EXCEL_IMPORT_STORAGE !== 'prisma') {
      const result = await this.saveLocalImport(entry.parsed, entry.preview);
      previewStore.delete(token);
      return result;
    }

    this.ensureTransactionCompatibleDatabaseUrl();
    await this.ensureDatabaseReady();

    const existingBatch = await this.prisma.importBatch.findUnique({
      where: { fileHash: entry.parsed.fileHash },
      select: { id: true },
    });

    if (existingBatch) {
      throw new BadRequestException('This exact Excel file was already imported.');
    }

    let result: { importBatchId: string; summary: ImportPreview };

    try {
      result = await this.prisma.$transaction(
        async (tx) => {
        const batch = await tx.importBatch.create({
          data: {
            fileName: entry.parsed.fileName,
            fileHash: entry.parsed.fileHash,
            summary: this.previewSummary(entry.preview),
            warnings: entry.parsed.warnings,
            duplicates: entry.preview.duplicateRecords,
          },
        });

      const brandName = entry.parsed.brandName || 'TanjAI';
      const brand = await tx.brand.upsert({
        where: { name: brandName },
        update: {},
        create: { name: brandName },
      });

      const storeIds = new Map<string, string>();
      for (const store of entry.parsed.stores) {
        const saved = await tx.store.upsert({
          where: {
            brandId_normalizedName: {
              brandId: brand.id,
              normalizedName: store.normalizedName,
            },
          },
          update: {
            name: store.name,
            country: store.country,
            platform: store.platform,
          },
          create: {
            brandId: brand.id,
            name: store.name,
            normalizedName: store.normalizedName,
            country: store.country,
            platform: store.platform,
          },
        });
        storeIds.set(store.name, saved.id);
        storeIds.set(store.normalizedName, saved.id);
      }

      const productIds = new Map<string, string>();
      const skuProductIds = new Map<string, string>();
      for (const product of entry.parsed.products) {
        const saved = await tx.product.upsert({
          where: { name: product.name },
          update: {
            description: product.description,
            weight: product.weight,
          },
          create: {
            name: product.name,
            description: product.description,
            weight: product.weight,
          },
        });
        productIds.set(product.name, saved.id);

        if (product.sku) {
          await tx.productSkuAlias.upsert({
            where: { sku: product.sku },
            update: {
              productId: saved.id,
              storeId: product.storeName
                ? this.lookupStoreId(storeIds, product.storeName)
                : undefined,
            },
            create: {
              productId: saved.id,
              storeId: product.storeName
                ? this.lookupStoreId(storeIds, product.storeName)
                : undefined,
              sku: product.sku,
            },
          });
          skuProductIds.set(product.sku, saved.id);
        }
      }

      for (const invoice of entry.parsed.invoices) {
        const storeId = this.requireStoreId(storeIds, invoice.storeName);
        await tx.fulfillmentInvoice.upsert({
          where: {
            storeId_invoiceReference: {
              storeId,
              invoiceReference: invoice.invoiceReference,
            },
          },
          update: {},
          create: {
            importBatchId: batch.id,
            storeId,
            invoiceReference: invoice.invoiceReference,
            invoiceDate: invoice.invoiceDate,
            subtotal: invoice.subtotal,
            refunds: invoice.refunds,
            adjustments: invoice.adjustments,
            total: invoice.total,
            sourceSheet: invoice.sourceSheet,
            sourceRow: invoice.sourceRow,
          },
        });
      }

      for (const order of entry.parsed.orders) {
        const storeId = this.requireStoreId(storeIds, order.storeName);
        const existingOrder = await tx.order.findUnique({
          where: {
            storeId_externalOrderNumber_invoiceReference: {
              storeId,
              externalOrderNumber: order.externalOrderNumber,
              invoiceReference: order.invoiceReference,
            },
          },
          select: { id: true },
        });

        if (existingOrder) {
          continue;
        }

        const savedOrder = await tx.order.create({
          data: {
            importBatchId: batch.id,
            storeId,
            externalOrderNumber: order.externalOrderNumber,
            orderDate: order.orderDate,
            invoiceReference: order.invoiceReference,
            sourceSheet: order.sourceSheet,
            sourceRow: order.sourceRow,
          },
        });

        const seenTracking = new Set<string>();
        for (const shipment of order.shipments) {
          if (seenTracking.has(shipment.trackingNumber)) {
            continue;
          }
          seenTracking.add(shipment.trackingNumber);
          await tx.shipment.create({
            data: {
              orderId: savedOrder.id,
              trackingNumber: shipment.trackingNumber,
              sourceSheet: shipment.sourceSheet,
              sourceRow: shipment.sourceRow,
            },
          });
        }

        for (const line of order.lines) {
          await tx.orderLine.create({
            data: {
              orderId: savedOrder.id,
              productId: skuProductIds.get(line.sku),
              sku: line.sku,
              quantity: line.quantity,
              productCost: line.productCost,
              shippingCost: line.shippingCost,
              handlingCost: line.handlingCost,
              totalCost: line.totalCost,
              sourceSheet: line.sourceSheet,
              sourceRow: line.sourceRow,
            },
          });
        }
      }

      for (const purchase of entry.parsed.stockPurchases) {
        await tx.stockPurchase.create({
          data: {
            importBatchId: batch.id,
            productId: purchase.productName
              ? productIds.get(purchase.productName)
              : purchase.sku
                ? skuProductIds.get(purchase.sku)
                : undefined,
            purchaseDate: purchase.purchaseDate,
            sku: purchase.sku,
            quantity: purchase.quantity,
            unitCost: purchase.unitCost,
            totalCost: purchase.totalCost,
            sourceSheet: purchase.sourceSheet,
            sourceRow: purchase.sourceRow,
          },
        });
      }

      for (const movement of entry.parsed.inventoryMovements) {
        await tx.inventoryMovement.create({
          data: {
            importBatchId: batch.id,
            productId: movement.productName
              ? productIds.get(movement.productName)
              : undefined,
            storeId: movement.storeName
              ? this.lookupStoreId(storeIds, movement.storeName)
              : undefined,
            movementDate: movement.movementDate,
            movementType: movement.movementType,
            quantity: movement.quantity,
            reference: movement.reference,
            comment: movement.comment,
            sourceSheet: movement.sourceSheet,
            sourceRow: movement.sourceRow,
          },
        });
      }

      for (const transaction of entry.parsed.walletTransactions) {
        await tx.walletTransaction.create({
          data: {
            importBatchId: batch.id,
            storeId: transaction.storeName
              ? this.lookupStoreId(storeIds, transaction.storeName)
              : undefined,
            transactionDate: transaction.transactionDate,
            transactionType: transaction.transactionType,
            invoiceReference: transaction.invoiceReference,
            amount: transaction.amount,
            runningBalance: transaction.runningBalance,
            sourceSheet: transaction.sourceSheet,
            sourceRow: transaction.sourceRow,
          },
        });
      }

      for (const warning of entry.parsed.warnings.filter(
        (item) => item.severity !== 'info',
      )) {
        await tx.anomaly.create({
          data: {
            importBatchId: batch.id,
            severity: warning.severity,
            message: warning.message,
            sourceSheet: warning.sourceSheet,
            sourceRow: warning.sourceRow,
          },
        });
      }

        return { importBatchId: batch.id, summary: entry.preview };
      },
      {
        maxWait: 20000,
        timeout: 300000,
      },
    );
    } catch (error) {
      this.throwConfirmImportError(error);
    }

    previewStore.delete(token);

    return result;
  }

  private ensureTransactionCompatibleDatabaseUrl() {
    const databaseUrl = process.env.DATABASE_URL ?? '';
    const usesPgBouncer =
      databaseUrl.includes('pgbouncer=true') ||
      databaseUrl.includes(':6543') ||
      databaseUrl.includes('pooler.supabase.com');

    if (usesPgBouncer) {
      throw new BadRequestException(
        'Cannot confirm import with the Supabase pooler/PgBouncer DATABASE_URL. Set backend/.env DATABASE_URL to the Supabase Direct connection URL, restart the backend, preview the Excel file again, then confirm the import.',
      );
    }
  }

  private throwConfirmImportError(error: unknown): never {
    if (error instanceof BadRequestException || error instanceof NotFoundException) {
      throw error;
    }

    const details =
      error instanceof Error
        ? `${error.message} ${JSON.stringify((error as { code?: string; meta?: unknown }).meta ?? {})}`
        : String(error);

    if (details.includes('P2028') || details.includes('Transaction not found')) {
      throw new BadRequestException(
        'Cannot confirm import because Prisma lost the database transaction. Use the Supabase Direct connection URL for DATABASE_URL, restart the backend, preview the file again, and confirm.',
      );
    }

    if (details.includes('does not exist') || details.includes('relation')) {
      throw new BadRequestException(
        'Cannot confirm import because the Excel import tables do not exist yet. Run backend/prisma/excel_import_tables.sql in Supabase SQL Editor.',
      );
    }

    throw new BadRequestException(
      `Cannot confirm import because the database save failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  private parseWorkbook(
    workbook: ParsedWorkbook,
    fileName: string,
    fileHash: string,
  ): ParsedImport {
    const parsed: ParsedImport = {
      fileName,
      fileHash,
      brandName: undefined,
      sheets: [],
      stores: [],
      products: [],
      orders: [],
      invoices: [],
      stockPurchases: [],
      inventoryMovements: [],
      walletTransactions: [],
      warnings: [],
    };

    const storeNames = new Set<string>();
    const productKeys = new Set<string>();

    for (const sheet of workbook.sheets) {
      const type = this.detectSheetType(sheet);
      const beforeInvoiceCount = parsed.invoices.length;

      if (type === 'quotation') {
        this.parseQuotation(sheet, parsed, productKeys);
      } else if (type === 'store_orders') {
        const store = this.toStore(sheet.name);
        if (!this.isBrandOwnerName(sheet.name) && !storeNames.has(store.normalizedName)) {
          parsed.stores.push(store);
          storeNames.add(store.normalizedName);
        }
        this.parseStoreOrders(sheet, parsed, productKeys);
      } else if (type === 'stock_invoice') {
        this.parseStockInvoices(sheet, parsed, productKeys);
      } else if (type === 'stock_list') {
        this.parseStockList(sheet, parsed, productKeys);
      } else if (type === 'payment_balance') {
        this.parsePaymentBalance(sheet, parsed, storeNames);
      }

      parsed.sheets.push({
        name: sheet.name,
        type,
        rows: sheet.rows.length,
        invoiceBlocks: parsed.invoices.length - beforeInvoiceCount || undefined,
      });
    }

    return parsed;
  }

  private detectSheetType(sheet: WorkbookSheet): SheetType {
    const name = normalizeText(sheet.name);
    const rowsText = sheet.rows
      .slice(0, 30)
      .map((row) => this.rowText(row))
      .join(' ');

    if (name.includes('quotation')) return 'quotation';
    if (name.includes('payment') && name.includes('balance')) {
      return 'payment_balance';
    }
    if (name.includes('stock invoice')) return 'stock_invoice';
    if (name.includes('stock list')) return 'stock_list';
    if (this.hasStoreOrderHeader(rowsText)) return 'store_orders';

    return 'unknown';
  }

  private parseQuotation(
    sheet: WorkbookSheet,
    parsed: ParsedImport,
    productKeys: Set<string>,
  ) {
    for (const row of sheet.rows) {
      const sku = cleanText(row.cells[4]);
      if (!sku || sku === '/' || normalizeText(sku).includes('sku')) continue;

      const name = cleanText(row.cells[1]) || cleanText(row.cells[3]) || sku;
      const description = cleanText(row.cells[3]) || undefined;
      const weight = toNumber(row.cells[7]);
      this.addProduct(parsed, productKeys, {
        name,
        description,
        weight: weight ?? undefined,
        sku,
      });
    }
  }

  private parseStoreOrders(
    sheet: WorkbookSheet,
    parsed: ParsedImport,
    productKeys: Set<string>,
  ) {
    let index = 0;

    while (index < sheet.rows.length) {
      const row = sheet.rows[index];
      const headers = this.extractStoreHeader(row);

      if (!headers) {
        index += 1;
        continue;
      }

      const titleRow = this.findTitleRow(sheet.rows, index);
      const invoiceReference = this.extractInvoiceReference(titleRow);
      const invoiceDate = parseDateLike(invoiceReference);
      let subtotal = 0;
      let refunds = 0;
      let adjustments = 0;
      const orders = new Map<string, ParsedOrder>();
      let lastOrderNumber = '';
      let lastTrackingNumber = '';
      let totalRowNumber = row.rowNumber;
      index += 1;

      while (index < sheet.rows.length) {
        const dataRow = sheet.rows[index];

        if (this.extractStoreHeader(dataRow)) {
          break;
        }

        if (isTotalAmountRow(dataRow)) {
          totalRowNumber = dataRow.rowNumber;
          const explicitTotal = toNumber(dataRow.cells[10]);
          if (explicitTotal !== null) {
            subtotal = explicitTotal;
          }
          index += 1;
          break;
        }

        const sku = cleanText(dataRow.cells[headers.sku]);
        const quantity = toNumber(dataRow.cells[headers.quantity]) ?? 0;
        const totalCost = toNumber(dataRow.cells[headers.totalCost]) ?? 0;

        if (!sku || (quantity === 0 && totalCost === 0)) {
          index += 1;
          continue;
        }

        const orderNumber =
          cleanText(dataRow.cells[headers.orderNumber]) || lastOrderNumber;
        const trackingNumber =
          cleanText(dataRow.cells[headers.trackingNumber]) || lastTrackingNumber;

        if (!orderNumber) {
          parsed.warnings.push({
            sourceSheet: sheet.name,
            sourceRow: dataRow.rowNumber,
            severity: 'warning',
            message: 'Skipped order line without order number context.',
          });
          index += 1;
          continue;
        }

        lastOrderNumber = orderNumber;
        if (trackingNumber) lastTrackingNumber = trackingNumber;

        const productCost = toNumber(dataRow.cells[headers.productCost]) ?? 0;
        const shippingCost = toNumber(dataRow.cells[headers.shippingCost]) ?? 0;
        const handlingCost = toNumber(dataRow.cells[headers.handlingCost]) ?? 0;
        const orderDate = parseDateLike(dataRow.cells[headers.time]);
        const orderKey = `${orderNumber}|${invoiceReference}`;
        const order =
          orders.get(orderKey) ??
          ({
            storeName: sheet.name,
            externalOrderNumber: orderNumber,
            orderDate,
            invoiceReference,
            sourceSheet: sheet.name,
            sourceRow: dataRow.rowNumber,
            lines: [],
            shipments: [],
          } satisfies ParsedOrder);

        order.lines.push({
          sku,
          quantity,
          productCost,
          shippingCost,
          handlingCost,
          totalCost,
          sourceSheet: sheet.name,
          sourceRow: dataRow.rowNumber,
        });

        if (trackingNumber) {
          order.shipments.push({
            trackingNumber,
            sourceSheet: sheet.name,
            sourceRow: dataRow.rowNumber,
          });
        }

        if (totalCost < 0 || this.rowText(dataRow).includes('refund')) {
          refunds += totalCost;
        } else if (this.rowText(dataRow).match(/correction|adjust|modify/)) {
          adjustments += totalCost;
        }

        this.addProduct(parsed, productKeys, {
          name: sku,
          sku,
          storeName: sheet.name,
        });
        orders.set(orderKey, order);
        index += 1;
      }

      parsed.orders.push(...orders.values());
      parsed.invoices.push({
        storeName: sheet.name,
        invoiceReference,
        invoiceDate,
        subtotal,
        refunds,
        adjustments,
        total: subtotal,
        sourceSheet: sheet.name,
        sourceRow: totalRowNumber,
      });
    }
  }

  private parseStockInvoices(
    sheet: WorkbookSheet,
    parsed: ParsedImport,
    productKeys: Set<string>,
  ) {
    let index = 0;

    while (index < sheet.rows.length) {
      const row = sheet.rows[index];
      const header = this.extractStockInvoiceHeader(row);

      if (!header) {
        index += 1;
        continue;
      }

      const titleRow = this.findTitleRow(sheet.rows, index);
      const purchaseDate = parseDateLike(this.extractInvoiceReference(titleRow));
      index += 1;

      while (index < sheet.rows.length) {
        const dataRow = sheet.rows[index];
        if (this.extractStockInvoiceHeader(dataRow)) break;
        if (this.rowText(dataRow).includes('total cost')) {
          index += 1;
          break;
        }

        const sku = cleanText(dataRow.cells[header.sku]);
        const quantity = toNumber(dataRow.cells[header.quantity]) ?? 0;
        const totalCost =
          toNumber(dataRow.cells[header.totalCost]) ??
          toNumber(dataRow.cells[header.productCost]) ??
          0;

        if (!sku || quantity === 0 || totalCost === 0) {
          index += 1;
          continue;
        }

        this.addProduct(parsed, productKeys, { name: sku, sku });
        parsed.stockPurchases.push({
          sku,
          productName: sku,
          purchaseDate,
          quantity,
          unitCost: quantity ? totalCost / quantity : undefined,
          totalCost,
          sourceSheet: sheet.name,
          sourceRow: dataRow.rowNumber,
        });
        index += 1;
      }
    }
  }

  private parseStockList(
    sheet: WorkbookSheet,
    parsed: ParsedImport,
    productKeys: Set<string>,
  ) {
    const productByColumn = new Map<number, string>();
    const headerRow = sheet.rows[0];

    if (headerRow) {
      for (const [column, value] of Object.entries(headerRow.cells)) {
        const productName = cleanText(value);
        if (productName) {
          productByColumn.set(Number(column), productName);
          this.addProduct(parsed, productKeys, { name: productName });
        }
      }
    }

    for (const [cellRef, comment] of Object.entries(sheet.comments)) {
      const rowNumber = Number(cellRef.match(/\d+/)?.[0] ?? 0);
      const column = columnToNumber(cellRef);
      const movementDate = parseDateLike(comment) ?? parseDateLike(rowNumber);
      const quantity = extractFirstNumber(comment) ?? 0;
      const productName =
        this.findProductForStockColumn(productByColumn, column) ?? undefined;

      parsed.inventoryMovements.push({
        productName,
        movementDate,
        movementType: classifyMovement(comment),
        quantity,
        reference: cellRef,
        comment,
        sourceSheet: sheet.name,
        sourceRow: rowNumber,
      });
    }

    for (const row of sheet.rows.slice(2)) {
      for (const [columnText, value] of Object.entries(row.cells)) {
        const quantity = toNumber(value);
        if (quantity === null || quantity === 0) continue;
        const column = Number(columnText);
        const productName = this.findProductForStockColumn(productByColumn, column);
        if (!productName) continue;

        const label = normalizeText(sheet.rows[1]?.cells[column]);
        if (!['stock', 'used', 'left'].includes(label)) continue;

        parsed.inventoryMovements.push({
          productName,
          movementDate: parseDateLike(row.cells[column - 1]) ?? undefined,
          movementType: label === 'used' ? 'consumption' : label,
          quantity,
          reference: cleanText(row.cells[column - 1]) || undefined,
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
        });
      }
    }
  }

  private parsePaymentBalance(
    sheet: WorkbookSheet,
    parsed: ParsedImport,
    storeNames: Set<string>,
  ) {
    for (const row of sheet.rows) {
      if (normalizeText(row.cells[1]) === 'date') continue;
      if (normalizeText(row.cells[1]) === 'sum') continue;

      const storeName = cleanText(row.cells[3]);
      const invoiceReference = cleanText(row.cells[4]);
      const invoiceAmount = toNumber(row.cells[5]);
      const depositAmount = toNumber(row.cells[2]);
      const runningBalance = toNumber(row.cells[6]);

      if (!storeName && invoiceAmount === null && depositAmount === null) {
        continue;
      }

      if (storeName) {
        const isBrandOwner = this.isBrandOwnerName(storeName);
        if (isBrandOwner) {
          parsed.brandName = storeName;
        }

        const store = this.toStore(storeName);
        if (!isBrandOwner && !storeNames.has(store.normalizedName)) {
          parsed.stores.push(store);
          storeNames.add(store.normalizedName);
        }
      }

      const transactionStoreName =
        storeName && !this.isBrandOwnerName(storeName) ? storeName : undefined;

      if (depositAmount !== null) {
        parsed.walletTransactions.push({
          storeName: transactionStoreName,
          transactionDate: parseDateLike(row.cells[1]) ?? undefined,
          transactionType: 'deposit',
          invoiceReference,
          amount: depositAmount,
          runningBalance: runningBalance ?? undefined,
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
        });
      }

      if (invoiceAmount !== null) {
        parsed.walletTransactions.push({
          storeName: transactionStoreName,
          transactionDate: parseDateLike(row.cells[1]) ?? undefined,
          transactionType: this.classifyWalletTransaction(transactionStoreName ?? ''),
          invoiceReference,
          amount: -Math.abs(invoiceAmount),
          runningBalance: runningBalance ?? undefined,
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
        });
      }
    }
  }

  private async findDuplicateRecords(parsed: ParsedImport) {
    const duplicates: string[] = [];

    const existingBatch = await this.prisma.importBatch
      .findUnique({
        where: { fileHash: parsed.fileHash },
        select: { fileName: true },
      })
      .catch(() => null);

    if (existingBatch) {
      duplicates.push(`File already imported as ${existingBatch.fileName}.`);
    }

    for (const invoice of parsed.invoices.slice(0, 100)) {
      const existing = await this.prisma.fulfillmentInvoice
        .findFirst({
          where: {
            invoiceReference: invoice.invoiceReference,
            store: { normalizedName: normalizeStoreName(invoice.storeName) },
          },
          select: { id: true },
        })
        .catch(() => null);

      if (existing) {
        duplicates.push(
          `${invoice.storeName} invoice ${invoice.invoiceReference} already exists.`,
        );
      }
    }

    return duplicates;
  }

  private async ensureDatabaseReady() {
    try {
      await this.prisma.importBatch.findFirst({ select: { id: true } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('Authentication failed') || message.includes('P1000')) {
        throw new BadRequestException(
          'Cannot confirm import because DATABASE_URL credentials are invalid. Fix backend/.env before confirming the import.',
        );
      }

      if (
        message.includes('does not exist') ||
        message.includes('table') ||
        message.includes('relation')
      ) {
        throw new BadRequestException(
          'Cannot confirm import because the Excel import tables do not exist yet. Open Supabase SQL Editor and run backend/prisma/excel_import_tables.sql. Do not run prisma migrate reset or prisma db push on this existing database.',
        );
      }

      throw new BadRequestException(
        `Cannot confirm import because the database is not ready: ${message}`,
      );
    }
  }

  private async saveLocalImport(parsed: ParsedImport, preview: ImportPreview) {
    const outputDir = resolve(process.cwd(), 'local-imports');
    await mkdir(outputDir, { recursive: true });
    const outputPath = resolve(outputDir, `${parsed.fileHash}.json.gz`);
    const payload = JSON.stringify({
      importedAt: new Date().toISOString(),
      parsed,
      preview,
    });
    await writeFile(outputPath, await gzipAsync(payload));

    return {
      importBatchId: parsed.fileHash,
      storage: 'local',
      summary: preview,
    };
  }

  private buildPreview(
    token: string,
    parsed: ParsedImport,
    duplicateRecords: string[],
  ): ImportPreview {
    const lineTotals = parsed.orders.flatMap((order) => order.lines);
    const shipments = parsed.orders.reduce(
      (total, order) => total + order.shipments.length,
      0,
    );
    const currentBalance = [...parsed.walletTransactions]
      .reverse()
      .find((transaction) => transaction.runningBalance !== null)?.runningBalance;

    return {
      token,
      fileName: parsed.fileName,
      fileHash: parsed.fileHash,
      detectedSheets: parsed.sheets,
      stores: parsed.stores,
      counts: {
        orders: parsed.orders.length,
        invoices: parsed.invoices.length,
        shipments,
        refunds: parsed.invoices.filter((invoice) => invoice.refunds < 0).length,
        stockPurchases: parsed.stockPurchases.length,
        stockMovements: parsed.inventoryMovements.length,
        walletTransactions: parsed.walletTransactions.length,
        warnings: parsed.warnings.length,
        duplicateRecords: duplicateRecords.length,
      },
      totals: {
        productCosts: sum(lineTotals, 'productCost'),
        shippingCosts: sum(lineTotals, 'shippingCost'),
        handlingCosts: sum(lineTotals, 'handlingCost'),
        invoiceCosts: sum(parsed.invoices, 'total'),
        refunds: sum(parsed.invoices, 'refunds'),
        currentBalance: currentBalance ?? null,
      },
      duplicateRecords,
      warnings: parsed.warnings.slice(0, 50),
    };
  }

  private extractStoreHeader(row: WorkbookRow): HeaderMap | null {
    const headers = this.headerMap(row);
    if (
      headers.orderNumber &&
      headers.trackingNumber &&
      headers.sku &&
      headers.totalCost
    ) {
      return headers;
    }

    return null;
  }

  private extractStockInvoiceHeader(row: WorkbookRow): HeaderMap | null {
    const headers = this.headerMap(row);
    if (headers.sku && headers.quantity && headers.totalCost) {
      return headers;
    }

    return null;
  }

  private headerMap(row: WorkbookRow): HeaderMap {
    const headers: HeaderMap = {};

    for (const [columnText, value] of Object.entries(row.cells)) {
      const column = Number(columnText);
      const label = normalizeText(value);

      if (label.includes('order no') || label.includes('order number')) {
        headers.orderNumber = column;
      } else if (label.includes('tracking')) {
        headers.trackingNumber = column;
      } else if (label === 'sku' || label.includes('product sku')) {
        headers.sku = column;
      } else if (label.includes('lineitem quantity') || label === 'quantity') {
        headers.quantity = column;
      } else if (label.includes('product cost')) {
        headers.productCost = column;
      } else if (label.includes('shipping cost')) {
        headers.shippingCost = column;
      } else if (label.includes('handle') || label.includes('handling')) {
        headers.handlingCost = column;
      } else if (label.includes('total cost')) {
        headers.totalCost = column;
      } else if (label === 'country') {
        headers.country = column;
      } else if (label.includes('time')) {
        headers.time = column;
      }
    }

    return headers;
  }

  private findTitleRow(rows: WorkbookRow[], headerIndex: number) {
    for (let index = headerIndex - 1; index >= Math.max(0, headerIndex - 3); index -= 1) {
      if (Object.keys(rows[index]?.cells ?? {}).length > 0) {
        return rows[index];
      }
    }

    return rows[headerIndex];
  }

  private extractInvoiceReference(row: WorkbookRow | undefined) {
    if (!row) return 'unknown';

    for (const column of [3, 4, 2, 1]) {
      const value = cleanText(row.cells[column]);
      if (value && normalizeText(value) !== 'marcus') {
        return value;
      }
    }

    return `row-${row.rowNumber}`;
  }

  private addProduct(
    parsed: ParsedImport,
    productKeys: Set<string>,
    product: ParsedProduct,
  ) {
    const key = `${product.name}|${product.sku ?? ''}|${product.storeName ?? ''}`;
    if (productKeys.has(key)) return;
    productKeys.add(key);
    parsed.products.push(product);
  }

  private toStore(name: string): ParsedStore {
    const normalizedName = normalizeStoreName(name);
    const country = this.extractCountry(name);
    const platform = name.toLowerCase().includes('woo') ? 'WooCommerce' : undefined;

    return { name, normalizedName, country, platform };
  }

  private isBrandOwnerName(name: string | undefined) {
    return normalizeStoreName(name ?? '') === 'marcus';
  }

  private extractCountry(name: string) {
    const lower = name.toLowerCase();
    if (lower.includes('-de') || lower.includes('.de')) return 'Germany';
    if (lower.includes('-dk')) return 'Denmark';
    if (lower.includes('-it')) return 'Italy';
    if (lower.includes('-se')) return 'Sweden';
    if (lower.includes('-fr') || lower.includes('.fr')) return 'France';
    if (lower.includes('-es')) return 'Spain';
    return undefined;
  }

  private rowText(row: WorkbookRow) {
    return Object.values(row.cells).map(cleanText).join(' ').toLowerCase();
  }

  private hasStoreOrderHeader(value: string) {
    const text = normalizeText(value);
    return (
      (text.includes('order no') || text.includes('order number')) &&
      text.includes('tracking') &&
      text.includes('sku') &&
      text.includes('total cost')
    );
  }

  private classifyWalletTransaction(storeName: string) {
    const normalized = normalizeStoreName(storeName);
    if (normalized === 'stock') return 'stock_purchase';
    if (normalized === 'tax') return 'tax';
    return 'store_invoice';
  }

  private findProductForStockColumn(
    productByColumn: Map<number, string>,
    column: number,
  ) {
    return [...productByColumn.entries()]
      .filter(([productColumn]) => productColumn <= column)
      .sort(([left], [right]) => right - left)[0]?.[1];
  }

  private lookupStoreId(storeIds: Map<string, string>, storeName: string) {
    return storeIds.get(storeName) ?? storeIds.get(normalizeStoreName(storeName));
  }

  private requireStoreId(storeIds: Map<string, string>, storeName: string) {
    const storeId = this.lookupStoreId(storeIds, storeName);
    if (!storeId) {
      throw new BadRequestException(`Unknown store: ${storeName}`);
    }
    return storeId;
  }

  private previewSummary(preview: ImportPreview) {
    return {
      counts: preview.counts,
      totals: preview.totals,
      detectedSheets: preview.detectedSheets,
    };
  }

  private clearExpiredPreviews() {
    const now = Date.now();
    for (const [token, entry] of previewStore.entries()) {
      if (now - entry.createdAt > previewTtlMs) {
        previewStore.delete(token);
      }
    }
  }
}

function cleanText(value: unknown) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function normalizeText(value: unknown) {
  return cleanText(value).toLowerCase();
}

function normalizeStoreName(value: string) {
  const normalized = normalizeText(value);
  if (normalized === 'stock') return 'stock';
  if (normalized === 'tax') return 'tax';
  return normalized.replace(/\s+/g, ' ');
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = cleanText(value).replace(/[$€,]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateLike(value: unknown): Date | undefined {
  const numeric = toNumber(value);
  if (numeric !== null && numeric > 20000 && numeric < 70000) {
    return new Date(Date.UTC(1899, 11, 30 + Math.floor(numeric)));
  }

  const text = cleanText(value);
  const dateMatch = text.match(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}/);
  if (dateMatch) {
    const date = new Date(dateMatch[0].replace(/\//g, '-'));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  return undefined;
}

function isTotalAmountRow(row: WorkbookRow) {
  return Object.values(row.cells).some(
    (value) => normalizeText(value) === 'total amount',
  );
}

function sum<T extends Record<K, number>, K extends keyof T>(
  values: T[],
  key: K,
) {
  return Number(values.reduce((total, item) => total + item[key], 0).toFixed(2));
}

function classifyMovement(comment: string) {
  const text = normalizeText(comment);
  if (text.includes('return')) return 'return';
  if (text.includes('transfer')) return 'transfer';
  if (text.includes('arrive') || text.includes('warehouse')) return 'arrival';
  if (text.includes('adjust') || text.includes('fix')) return 'adjustment';
  return 'movement';
}

function extractFirstNumber(value: string) {
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function columnToNumber(ref: string) {
  const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase();
  if (!letters) return 0;
  return [...letters].reduce(
    (total, letter) => total * 26 + letter.charCodeAt(0) - 64,
    0,
  );
}
