import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { gzip } from 'node:zlib';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PrismaService } from '../prisma.service';
import {
  ParsedWorkbook,
  WorkbookImage,
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
  ParsedOrderLine,
  ParsedProduct,
  ParsedStockPurchase,
  ParsedStore,
  ParsedWalletTransaction,
  SheetType,
  SourceRef,
} from './import.types';

type UploadedExcelFile = {
  originalname: string;
  buffer?: Buffer;
  path?: string;
  size: number;
};

type HeaderMap = Record<string, number>;
type RelationType = 'alias' | 'variant' | 'component';
type StockProductMatch = {
  stockName: string;
  stockSku?: string;
  dateColumn?: number;
  productName?: string;
  relationType: RelationType;
  quantityPerProduct: number;
  confidence: number;
};

const knownStockLinks: Array<{
  stockName: string;
  productName: string;
  relationType: RelationType;
  quantityPerProduct?: number;
}> = [
  {
    stockName: 'Glassbrush',
    productName: 'Old Glass-brush',
    relationType: 'alias',
  },
  {
    stockName: 'CarPlay3-in-1-Apple',
    productName: 'CarPlay 3-in-1-Apple/Android(black/silver)',
    relationType: 'variant',
  },
  {
    stockName: 'CarPlay3-in-1-Android',
    productName: 'CarPlay 3-in-1-Apple/Android(black/silver)',
    relationType: 'variant',
  },
  {
    stockName: 'CarPlay3-in-1-Android/Apple',
    productName: 'CarPlay 3-in-1-Apple/Android(black/silver)',
    relationType: 'variant',
  },
  {
    stockName: 'Rags',
    productName: 'Clip Hydromax+2 Rags',
    relationType: 'component',
    quantityPerProduct: 2,
  },
  {
    stockName: 'knee pads',
    productName: 'Black (knee pads + elbow pads)-Strap',
    relationType: 'component',
  },
];

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

    return this.preview({
      originalname: safeName,
      buffer,
      size: buffer.length,
    });
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

    try {
      this.ensureTransactionCompatibleDatabaseUrl();
      await this.ensureDatabaseReady();

      const existingBatch = await this.prisma.importBatch.findUnique({
        where: { fileHash: entry.parsed.fileHash },
        select: { id: true, fileName: true },
      });

      if (existingBatch) {
        previewStore.delete(token);
        return {
          importBatchId: existingBatch.id,
          summary: entry.preview,
          ignored: true,
          message: `An identical copy of ${existingBatch.fileName} was already imported. No data was added.`,
        };
      }
    } catch (error) {
      this.throwConfirmImportError(error);
    }

    let result: { importBatchId: string; summary: ImportPreview };

    try {
      const confirmStartedAt = Date.now();
      let phaseStartedAt = confirmStartedAt;
      const logPhase = (phase: string) => {
        const now = Date.now();
        console.info(
          `[excel-import] confirm ${phase}: ${now - phaseStartedAt}ms (${now - confirmStartedAt}ms total)`,
        );
        phaseStartedAt = now;
      };

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
          logPhase('batch');

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
          logPhase(`stores ${entry.parsed.stores.length}`);

          const { productIds, skuProductIds } =
            await this.resolveImportedProducts(
              tx,
              entry.parsed.products,
              storeIds,
            );
          logPhase(`products ${entry.parsed.products.length}`);

          await this.createManyInChunks(
            tx.fulfillmentInvoice,
            entry.parsed.invoices.map((invoice) => {
              const storeId = this.requireStoreId(storeIds, invoice.storeName);
              return {
                importBatchId: batch.id,
                storeId,
                invoiceReference: invoice.invoiceReference,
                invoiceDate: invoice.invoiceDate,
                subtotal: invoice.subtotal,
                refunds: invoice.refunds,
                adjustments: invoice.adjustments,
                otherCost: invoice.otherCost,
                total: invoice.total,
                sourceSheet: invoice.sourceSheet,
                sourceRow: invoice.sourceRow,
              };
            }),
            true,
          );
          logPhase(`invoices ${entry.parsed.invoices.length}`);

          const orderRecords = entry.parsed.orders.map((order) => {
            const storeId = this.requireStoreId(storeIds, order.storeName);
            return {
              id: randomUUID(),
              order,
              data: {
                importBatchId: batch.id,
                storeId,
                externalOrderNumber: order.externalOrderNumber,
                orderDate: order.orderDate,
                invoiceReference: order.invoiceReference,
                country: order.country,
                status: order.status,
                sourceSheet: order.sourceSheet,
                sourceRow: order.sourceRow,
              },
            };
          });

          await this.createManyInChunks(
            tx.order,
            orderRecords.map((record) => ({
              id: record.id,
              ...record.data,
            })),
            true,
          );
          logPhase(`orders ${orderRecords.length}`);

          const persistedOrderIds = new Set<string>();
          for (const chunk of this.chunk(
            orderRecords.map((record) => record.id),
            1000,
          )) {
            const rows = await tx.order.findMany({
              where: { id: { in: chunk } },
              select: { id: true },
            });
            for (const row of rows) {
              persistedOrderIds.add(row.id);
            }
          }
          logPhase(`order lookup ${persistedOrderIds.size}`);

          const shipmentRows: Array<Record<string, unknown>> = [];
          const orderLineRows: Array<Record<string, unknown>> = [];

          for (const { id: orderId, order } of orderRecords) {
            if (!persistedOrderIds.has(orderId)) {
              continue;
            }

            const seenTracking = new Set<string>();
            for (const shipment of order.shipments) {
              if (seenTracking.has(shipment.trackingNumber)) {
                continue;
              }
              seenTracking.add(shipment.trackingNumber);
              shipmentRows.push({
                orderId,
                trackingNumber: shipment.trackingNumber,
                sourceSheet: shipment.sourceSheet,
                sourceRow: shipment.sourceRow,
              });
            }

            for (const line of order.lines) {
              orderLineRows.push({
                orderId,
                productId: this.lookupSkuProductId(skuProductIds, line.sku),
                sku: line.sku,
                quantity: line.quantity,
                productCost: line.productCost,
                shippingCost: line.shippingCost,
                handlingCost: line.handlingCost,
                totalCost: line.totalCost,
                lineType: line.lineType,
                sourceSheet: line.sourceSheet,
                sourceRow: line.sourceRow,
              });
            }
          }

          await this.createManyInChunks(tx.shipment, shipmentRows, true);
          await this.createManyInChunks(tx.orderLine, orderLineRows);
          logPhase(
            `shipments ${shipmentRows.length}, order lines ${orderLineRows.length}`,
          );

          await this.createManyInChunks(
            tx.stockPurchase,
            entry.parsed.stockPurchases.map((purchase) => ({
              importBatchId: batch.id,
              productId: purchase.productName
                ? this.lookupProductId(productIds, purchase.productName)
                : purchase.sku
                  ? this.lookupSkuProductId(skuProductIds, purchase.sku)
                  : undefined,
              purchaseDate: purchase.purchaseDate,
              sku: purchase.sku,
              quantity: purchase.quantity,
              unitCost: purchase.unitCost,
              totalCost: purchase.totalCost,
              sourceSheet: purchase.sourceSheet,
              sourceRow: purchase.sourceRow,
            })),
          );
          logPhase(`stock purchases ${entry.parsed.stockPurchases.length}`);

          await this.createManyInChunks(
            tx.inventoryMovement,
            entry.parsed.inventoryMovements.map((movement) => ({
              importBatchId: batch.id,
              productId: movement.productName
                ? this.lookupProductId(productIds, movement.productName)
                : undefined,
              storeId: movement.storeName
                ? this.lookupStoreId(storeIds, movement.storeName)
                : undefined,
              stockName: movement.stockName,
              movementDate: movement.movementDate,
              movementType: movement.movementType,
              quantity: movement.quantity,
              reference: movement.reference,
              comment: movement.comment,
              sourceSheet: movement.sourceSheet,
              sourceRow: movement.sourceRow,
            })),
          );
          logPhase(`inventory movements ${entry.parsed.inventoryMovements.length}`);

          await this.persistInventoryProductMatches(
            tx,
            batch.id,
            entry.parsed.inventoryMovements,
            productIds,
          );
          logPhase('inventory product matches');

          await this.createManyInChunks(
            tx.walletTransaction,
            entry.parsed.walletTransactions.map((transaction) => ({
              importBatchId: batch.id,
              storeId: transaction.storeName
                ? this.lookupStoreId(storeIds, transaction.storeName)
                : undefined,
              transactionDate: transaction.transactionDate,
              transactionType: transaction.transactionType,
              invoiceReference: transaction.invoiceReference,
              amount: transaction.amount,
              runningBalance: transaction.runningBalance,
              exchangeRate: transaction.exchangeRate,
              sourceSheet: transaction.sourceSheet,
              sourceRow: transaction.sourceRow,
            })),
          );
          logPhase(`wallet transactions ${entry.parsed.walletTransactions.length}`);

          await this.createManyInChunks(
            tx.anomaly,
            entry.parsed.warnings
              .filter((item) => item.severity !== 'info')
              .map((warning) => ({
                importBatchId: batch.id,
                severity: warning.severity,
                message: warning.message,
                sourceSheet: warning.sourceSheet,
                sourceRow: warning.sourceRow,
              })),
          );
          logPhase(`anomalies ${entry.parsed.warnings.length}`);

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

  async removeImportBatch(importBatchId: string) {
    if (!importBatchId) {
      throw new BadRequestException('Import batch ID is required.');
    }

    if (process.env.EXCEL_IMPORT_STORAGE !== 'prisma') {
      throw new BadRequestException(
        'Import batch removal is only available when EXCEL_IMPORT_STORAGE=prisma.',
      );
    }

    try {
      this.ensureTransactionCompatibleDatabaseUrl();
      await this.ensureDatabaseReady();

      const existingBatch = await this.prisma.importBatch.findUnique({
        where: { id: importBatchId },
        select: { id: true, fileName: true, fileHash: true },
      });

      if (!existingBatch) {
        throw new NotFoundException('Import batch was not found.');
      }

      const result = await this.prisma.$transaction(
        async (tx) => {
          // Raise the per-statement timeout for this transaction: Supabase's
          // pooled connections apply a default statement_timeout that can be
          // shorter than the interactive-transaction timeout below, which
          // would abort a large cascade delete partway through.
          await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 280000');

          // excel_order_lines.orderId and excel_shipments.orderId both have
          // ON DELETE CASCADE back to excel_orders, so deleting orders by
          // importBatchId below removes them too. Do NOT also delete them
          // here by collecting every order id into an IN (...) list first —
          // for a batch with thousands of orders that single statement is
          // what was timing out (canceling statement due to statement
          // timeout, Postgres error 57014), since deleting by importBatchId
          // is a plain indexed-equality filter instead of a huge parameter
          // list.
          const inventoryItemIds = (
            await tx.inventoryItem.findMany({
              where: { importBatchId },
              select: { id: true },
            })
          ).map((item) => item.id);
          if (inventoryItemIds.length > 0) {
            await tx.inventoryProductLink.deleteMany({
              where: { inventoryItemId: { in: inventoryItemIds } },
            });
            await tx.inventoryItem.deleteMany({ where: { importBatchId } });
          }

          const [
            deletedAnomalies,
            deletedWalletTransactions,
            deletedInventoryMovements,
            deletedStockPurchases,
            deletedInvoices,
            deletedOrders,
          ] = await Promise.all([
            tx.anomaly.deleteMany({ where: { importBatchId } }),
            tx.walletTransaction.deleteMany({ where: { importBatchId } }),
            tx.inventoryMovement.deleteMany({ where: { importBatchId } }),
            tx.stockPurchase.deleteMany({ where: { importBatchId } }),
            tx.fulfillmentInvoice.deleteMany({ where: { importBatchId } }),
            tx.order.deleteMany({ where: { importBatchId } }),
          ]);

          const deletedImportBatch = await tx.importBatch.delete({
            where: { id: importBatchId },
            select: { id: true, fileHash: true },
          });
          const remainingImportBatches = await tx.importBatch.count();
          const orphanProducts = await this.cleanupOrphanProducts(
            tx,
            remainingImportBatches,
          );

          return {
            importBatchId,
            fileName: existingBatch.fileName,
            removedFileHash: deletedImportBatch.fileHash,
            deleted: {
              importBatches: 1,
              orders: deletedOrders.count,
              invoices: deletedInvoices.count,
              stockPurchases: deletedStockPurchases.count,
              inventoryMovements: deletedInventoryMovements.count,
              walletTransactions: deletedWalletTransactions.count,
              anomalies: deletedAnomalies.count,
              orphanProducts: orphanProducts.products,
              orphanSkuAliases: orphanProducts.aliases,
            },
          };
        },
        {
          maxWait: 20000,
          timeout: 300000,
        },
      );

      return result;
    } catch (error) {
      this.throwConfirmImportError(error);
    }
  }

  async replaceImportBatch(importBatchId: string, token: string) {
    await this.removeImportBatch(importBatchId);
    return this.confirm(token);
  }

  async listImportBatches() {
    if (process.env.EXCEL_IMPORT_STORAGE !== 'prisma') {
      return [];
    }

    try {
      this.ensureTransactionCompatibleDatabaseUrl();
      await this.ensureDatabaseReady();

      const batches = await this.prisma.importBatch.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          fileName: true,
          fileHash: true,
          status: true,
          summary: true,
          warnings: true,
          duplicates: true,
          createdAt: true,
        },
      });

      const rows = await Promise.all(
        batches.map(async (batch) => {
          const [
            orderCount,
            invoiceCount,
            stockPurchaseCount,
            inventoryMovementCount,
            walletTransactionCount,
            anomalyCount,
            productCount,
          ] = await Promise.all([
            this.prisma.order.count({ where: { importBatchId: batch.id } }),
            this.prisma.fulfillmentInvoice.count({
              where: { importBatchId: batch.id },
            }),
            this.prisma.stockPurchase.count({
              where: { importBatchId: batch.id },
            }),
            this.prisma.inventoryMovement.count({
              where: { importBatchId: batch.id },
            }),
            this.prisma.walletTransaction.count({
              where: { importBatchId: batch.id },
            }),
            this.prisma.anomaly.count({ where: { importBatchId: batch.id } }),
            this.countProductsForImportBatch(batch.id),
          ]);

          return {
            id: batch.id,
            fileName: batch.fileName,
            fileHash: batch.fileHash,
            fileHashStatus: batch.fileHash ? 'Registered' : 'Missing',
            status: batch.status,
            importedAt: batch.createdAt,
            orders: orderCount,
            invoices: invoiceCount,
            products: productCount,
            stockPurchases: stockPurchaseCount,
            inventoryMovements: inventoryMovementCount,
            walletTransactions: walletTransactionCount,
            warnings: Array.isArray(batch.warnings)
              ? batch.warnings.length
              : anomalyCount,
            anomalies: anomalyCount,
            duplicates: Array.isArray(batch.duplicates)
              ? batch.duplicates.length
              : 0,
            summary: batch.summary,
          };
        }),
      );

      return rows;
    } catch (error) {
      this.throwConfirmImportError(error);
    }
  }

  private async countProductsForImportBatch(importBatchId: string) {
    const [lineProducts, purchaseProducts, movementProducts] =
      await Promise.all([
        this.prisma.orderLine.findMany({
          where: { order: { importBatchId }, productId: { not: null } },
          select: { productId: true },
          distinct: ['productId'],
        }),
        this.prisma.stockPurchase.findMany({
          where: { importBatchId, productId: { not: null } },
          select: { productId: true },
          distinct: ['productId'],
        }),
        this.prisma.inventoryMovement.findMany({
          where: { importBatchId, productId: { not: null } },
          select: { productId: true },
          distinct: ['productId'],
        }),
      ]);

    const productIds = new Set<string>();
    for (const row of [
      ...lineProducts,
      ...purchaseProducts,
      ...movementProducts,
    ]) {
      if (row.productId) productIds.add(row.productId);
    }

    return productIds.size;
  }

  private async resolveImportedProducts(
    tx: any,
    products: ParsedProduct[],
    storeIds: Map<string, string>,
  ) {
    const productIds = new Map<string, string>();
    const skuProductIds = new Map<string, string>();
    const productRows = await tx.product.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        weight: true,
        quotation: true,
        imageUrl: true,
      },
    });
    const aliasRows = await tx.productSkuAlias.findMany({
      select: {
        sku: true,
        storeId: true,
        productId: true,
        product: {
          select: {
            id: true,
            name: true,
            description: true,
            weight: true,
            quotation: true,
            imageUrl: true,
          },
        },
      },
    });
    const productsById = new Map(
      productRows.map((product) => [product.id, product]),
    );
    const productsByName = new Map<string, any>();
    const aliasesBySku = new Map<string, any>();

    for (const product of productRows) {
      const key = normalizeProductName(product.name);
      if (!productsByName.has(key)) {
        productsByName.set(key, product);
      }
      this.rememberProductId(productIds, product.name, product.id);
    }

    for (const alias of aliasRows) {
      aliasesBySku.set(alias.sku, alias);
      this.rememberSkuProductId(skuProductIds, alias.sku, alias.productId);
      this.rememberProductId(productIds, alias.sku, alias.productId);
    }

    const orderedProducts = [...products].sort((left, right) => {
      return this.productSourceRank(left) - this.productSourceRank(right);
    });

    for (const product of orderedProducts) {
      const sku = product.sku ? cleanText(product.sku) : '';
      const normalizedName = normalizeProductName(product.name);
      const existingAlias = sku
        ? (aliasesBySku.get(sku) ?? aliasesBySku.get(canonicalSkuKey(sku)))
        : null;
      let saved = existingAlias?.product ?? productsByName.get(normalizedName);

      if (
        existingAlias?.product &&
        this.shouldPromoteFallbackProduct(existingAlias.product, product)
      ) {
        const nameMatch = productsByName.get(normalizedName);
        if (nameMatch && nameMatch.id !== existingAlias.productId) {
          await this.mergeProduct(tx, existingAlias.productId, nameMatch.id);
          saved = await this.updateProductMetadata(
            tx,
            nameMatch.id,
            product,
            false,
            nameMatch.quotation,
          );
        } else {
          saved = await this.updateProductMetadata(
            tx,
            existingAlias.productId,
            product,
            true,
            existingAlias.product.quotation,
          );
        }
      } else if (saved) {
        saved = await this.updateProductMetadata(
          tx,
          saved.id,
          product,
          false,
          saved.quotation,
        );
      } else {
        saved = await tx.product.create({
          data: {
            name: product.name,
            description: product.description,
            weight: product.weight,
            quotation: product.quotation,
            imageUrl: product.imageUrl,
          },
        });
      }

      productsById.set(saved.id, saved);
      productsByName.set(normalizeProductName(saved.name), saved);
      this.rememberProductId(productIds, product.name, saved.id);

      if (sku) {
        this.rememberProductId(productIds, sku, saved.id);
        this.rememberSkuProductId(skuProductIds, sku, saved.id);
        const storeId = product.storeName
          ? this.lookupStoreId(storeIds, product.storeName)
          : undefined;
        const aliasStoreId = existingAlias?.storeId ?? storeId;

        await tx.productSkuAlias.upsert({
          where: { sku },
          update: {
            productId: saved.id,
            storeId: aliasStoreId,
          },
          create: {
            productId: saved.id,
            storeId: aliasStoreId,
            sku,
          },
        });

        aliasesBySku.set(sku, {
          sku,
          storeId: aliasStoreId,
          productId: saved.id,
          product: saved,
        });
        aliasesBySku.set(canonicalSkuKey(sku), {
          sku,
          storeId: aliasStoreId,
          productId: saved.id,
          product: saved,
        });
      }
    }

    return { productIds, skuProductIds };
  }

  private productSourceRank(product: ParsedProduct) {
    if (product.source === 'quotation') return 0;
    if (product.source === 'stock_header') return 1;
    return 2;
  }

  private shouldPromoteFallbackProduct(
    existing: { name: string },
    product: ParsedProduct,
  ) {
    if (product.source !== 'quotation') return false;
    if (!product.sku) return false;
    return (
      normalizeProductName(existing.name) === normalizeProductName(product.sku)
    );
  }

  private async updateProductMetadata(
    tx: any,
    productId: string,
    product: ParsedProduct,
    updateName = false,
    existingQuotation?: ParsedProduct['quotation'],
  ) {
    const data: Record<string, unknown> = {};
    if (updateName) data.name = product.name;
    if (product.description) data.description = product.description;
    if (typeof product.weight === 'number') data.weight = product.weight;
    if (product.quotation) {
      // A product with several SKU aliases is saved once per alias; merge
      // with the stored quotation so a later alias with partial data does
      // not wipe rows contributed by earlier ones.
      data.quotation =
        mergeProductQuotation(
          existingQuotation,
          product.quotation,
        ) ?? product.quotation;
    }
    if (product.imageUrl) data.imageUrl = product.imageUrl;

    if (Object.keys(data).length === 0) {
      return tx.product.findUnique({ where: { id: productId } });
    }

    return tx.product.update({
      where: { id: productId },
      data,
    });
  }

  private async mergeProduct(
    tx: any,
    sourceProductId: string,
    targetProductId: string,
  ) {
    if (sourceProductId === targetProductId) return;

    await tx.orderLine.updateMany({
      where: { productId: sourceProductId },
      data: { productId: targetProductId },
    });
    await tx.stockPurchase.updateMany({
      where: { productId: sourceProductId },
      data: { productId: targetProductId },
    });
    await tx.inventoryMovement.updateMany({
      where: { productId: sourceProductId },
      data: { productId: targetProductId },
    });
    await tx.productSkuAlias.updateMany({
      where: { productId: sourceProductId },
      data: { productId: targetProductId },
    });
    await tx.product
      .delete({ where: { id: sourceProductId } })
      .catch(() => undefined);
  }

  private async cleanupOrphanProducts(tx: any, remainingImportBatches: number) {
    const orphanCandidates = await tx.product.findMany({
      where: {
        orderLines: { none: {} },
        stockPurchases: { none: {} },
        inventoryMovements: { none: {} },
        aliases: { none: {} },
        inventoryLinks: { none: {} },
      },
      select: {
        id: true,
        description: true,
        weight: true,
        quotation: true,
        imageUrl: true,
        _count: { select: { skuAliases: true } },
      },
    });
    const orphanProducts = orphanCandidates.filter((product) => {
      if (remainingImportBatches === 0) return true;
      return (
        product._count.skuAliases === 0 && !hasActiveProductDetails(product)
      );
    });
    const productIds = orphanProducts.map((product) => product.id);
    if (productIds.length === 0) return { products: 0, aliases: 0 };

    const deletedAliases = await tx.productSkuAlias.deleteMany({
      where: { productId: { in: productIds } },
    });
    const deletedProducts = await tx.product.deleteMany({
      where: { id: { in: productIds } },
    });

    return {
      products: deletedProducts.count,
      aliases: deletedAliases.count,
    };
  }

  private rememberProductId(
    productIds: Map<string, string>,
    nameOrSku: string | undefined,
    productId: string,
  ) {
    if (!nameOrSku) return;
    productIds.set(nameOrSku, productId);
    productIds.set(normalizeProductName(nameOrSku), productId);
    const canonicalSku = canonicalSkuKey(nameOrSku);
    productIds.set(canonicalSku, productId);
    productIds.set(normalizeProductName(canonicalSku), productId);
  }

  private lookupProductId(
    productIds: Map<string, string>,
    nameOrSku: string | undefined,
  ) {
    if (!nameOrSku) return undefined;
    const canonicalSku = canonicalSkuKey(nameOrSku);
    return (
      productIds.get(nameOrSku) ??
      productIds.get(normalizeProductName(nameOrSku)) ??
      productIds.get(canonicalSku) ??
      productIds.get(normalizeProductName(canonicalSku))
    );
  }

  private rememberSkuProductId(
    skuProductIds: Map<string, string>,
    sku: string,
    productId: string,
  ) {
    skuProductIds.set(sku, productId);
    skuProductIds.set(canonicalSkuKey(sku), productId);
  }

  private lookupSkuProductId(
    skuProductIds: Map<string, string>,
    sku: string | undefined,
  ) {
    if (!sku) return undefined;
    return skuProductIds.get(sku) ?? skuProductIds.get(canonicalSkuKey(sku));
  }

  private async persistInventoryProductMatches(
    tx: any,
    importBatchId: string,
    movements: ParsedInventoryMovement[],
    productIds: Map<string, string>,
  ) {
    const stockItems = new Map<
      string,
      {
        stockName: string;
        stockSku?: string;
        normalizedName: string;
        sourceSheet?: string;
        productName?: string;
        relationType: RelationType;
        quantityPerProduct: number;
        confidence: number;
      }
    >();

    for (const movement of movements) {
      const stockName = cleanText(movement.stockName ?? movement.productName);
      if (!stockName) continue;
      const normalizedName = normalizeInventoryName(stockName);
      const existing = stockItems.get(normalizedName);
      if (existing && existing.confidence >= (movement.confidence ?? 0)) {
        continue;
      }
      stockItems.set(normalizedName, {
        stockName,
        stockSku: cleanText(movement.stockSku) || undefined,
        normalizedName,
        sourceSheet: movement.sourceSheet,
        productName: movement.productName,
        relationType: movement.relationType ?? 'alias',
        quantityPerProduct: movement.quantityPerProduct ?? 1,
        confidence: movement.confidence ?? 0,
      });
    }

    if (stockItems.size === 0) return;

    const savedAliases = await tx.productAlias.findMany({
      where: { normalizedName: { in: [...stockItems.keys()] } },
      select: {
        normalizedName: true,
        productId: true,
        confidence: true,
        confirmedByAdmin: true,
        product: { select: { name: true } },
      },
    });
    const savedAliasByName = new Map<
      string,
      {
        productId: string;
        confidence: number;
        confirmedByAdmin: boolean;
      }
    >(
      savedAliases.map((alias: any) => [alias.normalizedName, alias]),
    );

    for (const item of stockItems.values()) {
      const savedAlias = savedAliasByName.get(item.normalizedName);
      const productId =
        savedAlias?.productId ??
        this.lookupProductId(productIds, item.productName) ??
        this.lookupProductId(productIds, item.stockName);
      const inventoryItem = await tx.inventoryItem.upsert({
        where: {
          importBatchId_normalizedName: {
            importBatchId,
            normalizedName: item.normalizedName,
          },
        },
        update: {
          stockName: item.stockName,
          stockSku: item.stockSku,
          sourceSheet: item.sourceSheet,
        },
        create: {
          importBatchId,
          stockName: item.stockName,
          stockSku: item.stockSku,
          normalizedName: item.normalizedName,
          sourceSheet: item.sourceSheet,
        },
      });

      await tx.inventoryProductLink.create({
        data: {
          inventoryItemId: inventoryItem.id,
          productId,
          relationType: item.relationType,
          quantityPerProduct: item.quantityPerProduct,
          confidence: savedAlias?.confirmedByAdmin
            ? Math.max(savedAlias.confidence ?? 1, item.confidence)
            : item.confidence,
          confirmedByAdmin: Boolean(savedAlias?.confirmedByAdmin),
        },
      });
    }
  }

  private async createManyInChunks(
    delegate: { createMany: (args: any) => Promise<unknown> },
    data: Array<Record<string, unknown>>,
    skipDuplicates = false,
  ) {
    for (const chunk of this.chunk(data, 500)) {
      if (chunk.length === 0) {
        continue;
      }

      await delegate.createMany({ data: chunk, skipDuplicates });
    }
  }

  private chunk<T>(items: T[], size: number) {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

  private ensureTransactionCompatibleDatabaseUrl() {
    const databaseUrl = process.env.DATABASE_URL ?? '';
    const usesTransactionPooler =
      databaseUrl.includes('pgbouncer=true') || databaseUrl.includes(':6543');

    if (usesTransactionPooler) {
      throw new BadRequestException(
        'Cannot confirm import with a Supabase transaction pooler/PgBouncer DATABASE_URL. Use the Supabase session pooler URL ending in :5432, or the direct connection URL if your network supports IPv6 or your project has the IPv4 add-on. Restart the backend, preview the Excel file again, then confirm the import.',
      );
    }
  }

  private throwConfirmImportError(error: unknown): never {
    if (
      error instanceof BadRequestException ||
      error instanceof NotFoundException
    ) {
      throw error;
    }

    const details =
      error instanceof Error
        ? `${error.message} ${JSON.stringify((error as { code?: string; meta?: unknown }).meta ?? {})}`
        : String(error);

    if (
      details.includes('P2028') ||
      details.includes('Transaction not found')
    ) {
      throw new BadRequestException(
        'Cannot confirm import because Prisma lost the database transaction. Use the Supabase session pooler URL ending in :5432, or the direct connection URL if your network supports IPv6 or your project has the IPv4 add-on. Restart the backend, preview the file again, and confirm.',
      );
    }

    if (
      details.includes('P1001') ||
      details.includes("Can't reach database server") ||
      details.includes('ECONNREFUSED') ||
      details.includes('ETIMEDOUT') ||
      details.includes('ENOTFOUND')
    ) {
      throw new BadRequestException(
        'Cannot access the import database. Check DATABASE_URL and Supabase connectivity, restart the backend, preview the Excel file again, and retry the import.',
      );
    }

    if (details.includes('TLS') || details.includes('sslmode')) {
      throw new BadRequestException(
        'Cannot access the import database because Prisma could not open a TLS connection to Supabase. Confirm DATABASE_URL includes sslmode=require, restart the backend, preview the Excel file again, then retry the import. If sslmode=require is already set, check the local Windows TLS/security credentials for this Node process.',
      );
    }

    if (
      details.includes('EMAXCONNSESSION') ||
      details.includes('max clients reached')
    ) {
      throw new BadRequestException(
        'Cannot access the import database because the Supabase session pooler client limit was reached. Add connection_limit=1 to DATABASE_URL, restart the backend, preview the Excel file again, then retry the import.',
      );
    }

    if (details.includes('does not exist') || details.includes('relation')) {
      throw new BadRequestException(
        'Cannot access the import database because the Excel import tables do not exist yet. Run backend/prisma/excel_import_tables.sql in Supabase SQL Editor.',
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
    const skuDecoderSheets: WorkbookSheet[] = [];

    for (const sheet of workbook.sheets) {
      const type = this.detectSheetType(sheet);
      const beforeInvoiceCount = parsed.invoices.length;

      if (type === 'quotation') {
        this.parseQuotation(sheet, parsed, productKeys);
      } else if (type === 'sku_decoder') {
        skuDecoderSheets.push(sheet);
      } else if (type === 'store_orders') {
        const store = this.toStore(sheet.name);
        if (
          !this.isBrandOwnerName(sheet.name) &&
          !storeNames.has(store.normalizedName)
        ) {
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

    for (const sheet of skuDecoderSheets) {
      this.parseSkuDecoder(sheet, parsed, productKeys);
    }

    this.addParsedImportWarnings(parsed);

    return parsed;
  }

  private addParsedImportWarnings(parsed: ParsedImport) {
    const knownStores = new Set(
      parsed.stores.map((store) => store.normalizedName),
    );
    const warnUnknownStore = (
      storeName: string | undefined,
      source: SourceRef,
    ) => {
      if (!storeName || this.isBrandOwnerName(storeName)) return;
      if (knownStores.has(normalizeStoreName(storeName))) return;
      parsed.warnings.push({
        sourceSheet: source.sourceSheet,
        sourceRow: source.sourceRow,
        severity: 'warning',
        message: `Unknown store reference: ${storeName}`,
      });
    };

    for (const order of parsed.orders) warnUnknownStore(order.storeName, order);
    for (const invoice of parsed.invoices)
      warnUnknownStore(invoice.storeName, invoice);
    for (const transaction of parsed.walletTransactions) {
      warnUnknownStore(transaction.storeName, transaction);
    }
    for (const movement of parsed.inventoryMovements) {
      warnUnknownStore(movement.storeName, movement);
    }

    const quotationSkus = new Set(
      parsed.products
        .filter((product) => product.source === 'quotation' && product.sku)
        .flatMap((product) => {
          const sku = product.sku as string;
          return [sku, canonicalSkuKey(sku)];
        }),
    );
    const unmatchedFallbacks = parsed.products.filter((product) => {
      return (
        product.source === 'fallback' &&
        product.sku &&
        normalizeProductName(product.name) ===
          normalizeProductName(product.sku) &&
        !quotationSkus.has(product.sku) &&
        !quotationSkus.has(canonicalSkuKey(product.sku))
      );
    });

    for (const product of unmatchedFallbacks.slice(0, 50)) {
      parsed.warnings.push({
        sourceSheet: 'Products',
        sourceRow: 1,
        severity: 'warning',
        message: `Unmatched SKU-only product kept as fallback: ${product.sku}`,
      });
    }
    if (unmatchedFallbacks.length > 50) {
      parsed.warnings.push({
        sourceSheet: 'Products',
        sourceRow: 1,
        severity: 'warning',
        message: `${unmatchedFallbacks.length - 50} more unmatched SKU-only products were kept as fallbacks.`,
      });
    }
  }

  private detectSheetType(sheet: WorkbookSheet): SheetType {
    const name = normalizeText(sheet.name);
    const rowsText = sheet.rows
      .slice(0, 30)
      .map((row) => this.rowText(row))
      .join(' ');

    if (name.includes('quotation')) return 'quotation';
    if (name.includes('sku decoder')) return 'sku_decoder';
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
    let lastProductName = '';
    let lastProductImageUrl: string | undefined;
    let skipAlternateLayout = false;
    let currentGroup = '';
    const seenSkuNames = new Map<string, string>();
    const deliveryTimeByRow = this.mergedDeliveryTimesByRow(sheet);
    const imageByRow =
      sheet.name === 'Quotation-NEW'
        ? this.quotationImagesByRow(sheet.images)
        : new Map<number, string>();

    if (sheet.name === 'Quotation-NEW') {
      for (const warning of sheet.imageWarnings) {
        parsed.warnings.push({
          sourceSheet: sheet.name,
          sourceRow: warning.sourceRow ?? 1,
          severity: 'warning',
          message: warning.message,
        });
      }
    }

    for (const row of sheet.rows) {
      if (row.rowNumber <= 4) continue;

      const headerLayout = this.quotationHeaderLayout(row);
      if (headerLayout) {
        skipAlternateLayout = headerLayout === 'alternate';
        if (skipAlternateLayout) {
          parsed.warnings.push({
            sourceSheet: sheet.name,
            sourceRow: row.rowNumber,
            severity: 'warning',
            message: `Skipped secondary quotation table starting at row ${row.rowNumber} because its columns do not match the main quotation layout.`,
          });
        }
        continue;
      }
      if (skipAlternateLayout) continue;

      const skus = splitSkuAliases(row.cells[4]);
      // Column B is the picture column, but some variant rows carry their
      // label there instead of columns A/C (e.g. "1 Arme-Trainer-box+ ...").
      const rawName =
        cleanText(row.cells[1]) ||
        cleanText(row.cells[3]) ||
        cleanText(row.cells[2]);
      const nameInfo = cleanQuotationProductName(rawName);
      const quotation = extractQuotationData(
        row,
        nameInfo,
        sheet.name,
        deliveryTimeByRow.get(row.rowNumber),
      );
      const hasUsefulQuotation = hasUsefulQuotationData(quotation);

      // Column A ("No.") labels each product block, e.g. "[CarPlay] 2" or
      // "High-pressure car wash nozzles". Keep the full label (brackets
      // removed, stock/MOQ noise stripped) so "[CarPlay]", "[CarPlay] 2" and
      // "[CarPlay] 3" stay separate groups.
      const groupLabel = quotationGroupLabel(row.cells[1]);
      if (groupLabel) {
        currentGroup = groupLabel;
      }
      if (currentGroup) {
        quotation.productGroup = currentGroup;
      }
      // A bracket-only label in column A (e.g. "[CarPlay]") is a group label,
      // not a product identity — several blocks can share it. Prefer the
      // Details column for the product name when it provides one.
      let resolvedName = nameInfo.name;
      if (nameInfo.name && nameInfo.bracketOnly && cleanText(row.cells[1])) {
        const detailsInfo = cleanQuotationProductName(row.cells[3]);
        if (detailsInfo.name) {
          resolvedName = detailsInfo.name;
        }
      }
      const name =
        resolvedName ||
        ((skus.length === 0 || !rawName) && lastProductName
          ? lastProductName
          : '') ||
        skus[0] ||
        '';
      const rowImageUrl = imageByRow.get(row.rowNumber);
      const imageUrl = rowImageUrl ?? lastProductImageUrl;

      if (nameInfo.warning && !isNumericText(rawName)) {
        parsed.warnings.push({
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
          severity: 'warning',
          message: `Ignored invalid quotation product name: ${rawName}`,
        });
      }

      if (!name) {
        continue;
      }

      const description = cleanQuotationDescription(row.cells[3], name);
      const weight = quotation.weight ?? toNumber(row.cells[7]);
      const invalidDeliveryValue = cleanText(row.cells[17]);
      if (
        invalidDeliveryValue &&
        toNumber(invalidDeliveryValue) !== null &&
        !looksLikeDeliveryTime(invalidDeliveryValue)
      ) {
        parsed.warnings.push({
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
          severity: 'warning',
          message: isPastedLandedCostPricing(row)
            ? `Ignored landed cost pasted into the delivery-time column: ${invalidDeliveryValue}`
            : `Invalid delivery-time value treated as selling price: ${invalidDeliveryValue}`,
        });
      }

      if (nameInfo.name || skus.length > 0) {
        lastProductName = name;
        if (rowImageUrl) {
          lastProductImageUrl = rowImageUrl;
        }
      }

      for (const sku of skus) {
        const existingName = seenSkuNames.get(sku);
        if (
          existingName &&
          normalizeProductName(existingName) !== normalizeProductName(name)
        ) {
          parsed.warnings.push({
            sourceSheet: sheet.name,
            sourceRow: row.rowNumber,
            severity: 'warning',
            message: `Duplicate SKU alias ${sku} appears under both ${existingName} and ${name}.`,
          });
        }
        seenSkuNames.set(sku, name);
        this.addProduct(parsed, productKeys, {
          name,
          description,
          weight: weight ?? undefined,
          sku,
          imageUrl,
          quotation,
          source: 'quotation',
        });
      }

      if (skus.length === 0 && hasUsefulQuotation) {
        this.addProduct(parsed, productKeys, {
          name,
          description,
          weight: weight ?? undefined,
          imageUrl,
          quotation,
          source: 'quotation',
        });
      }
    }
  }

  private parseSkuDecoder(
    sheet: WorkbookSheet,
    parsed: ParsedImport,
    productKeys: Set<string>,
  ) {
    for (const row of sheet.rows) {
      const sku = cleanText(row.cells[1]);
      const productText = cleanText(row.cells[2]);

      if (!sku || !productText || !isDecoderSkuCode(sku)) {
        continue;
      }

      const product = this.findDecodedProduct(parsed.products, productText);
      if (!product) {
        parsed.warnings.push({
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
          severity: 'warning',
          message: `SKU decoder alias ${sku} did not match a quotation product.`,
        });
        continue;
      }

      this.addProduct(parsed, productKeys, {
        name: product.name,
        description: product.description,
        weight: product.weight,
        sku,
        imageUrl: product.imageUrl,
        quotation: product.quotation,
        source: 'quotation',
      });
    }
  }

  private findDecodedProduct(products: ParsedProduct[], productText: string) {
    const haystack = normalizeDecoderText(productText);
    return products.find((product) => {
      if (product.source !== 'quotation') return false;
      const candidates = [product.sku, product.name, product.description]
        .map((value) => normalizeDecoderText(value))
        .filter((value) => value.length >= 4);

      return candidates.some(
        (candidate) =>
          haystack.includes(candidate) || candidate.includes(haystack),
      );
    });
  }

  private quotationHeaderLayout(
    row: WorkbookRow,
  ): 'standard' | 'alternate' | null {
    if (
      normalizeText(row.cells[1]) !== 'no.' ||
      normalizeText(row.cells[2]) !== 'picture' ||
      normalizeText(row.cells[3]) !== 'details'
    ) {
      return null;
    }

    const standard =
      normalizeText(row.cells[12]).includes('service fee') &&
      normalizeText(row.cells[13]).includes('total cost');
    return standard ? 'standard' : 'alternate';
  }

  // The Delivery date column (Q) uses merged cells spanning each product
  // block; Excel stores the value only in the top-left cell, so propagate it
  // to every row the merge covers.
  private mergedDeliveryTimesByRow(sheet: WorkbookSheet) {
    const deliveryByRow = new Map<number, string>();
    const rowsByNumber = new Map(sheet.rows.map((row) => [row.rowNumber, row]));

    for (const merge of sheet.merges) {
      if (merge.startColumn !== 17 || merge.endColumn !== 17) continue;

      const anchorValue = cleanText(
        rowsByNumber.get(merge.startRow)?.cells[17],
      );
      if (!anchorValue || !looksLikeDeliveryTime(anchorValue)) continue;

      for (let row = merge.startRow; row <= merge.endRow; row += 1) {
        deliveryByRow.set(row, anchorValue);
      }
    }

    return deliveryByRow;
  }

  // Product pictures live in column B, but some are anchored one column off
  // (e.g. an image whose top-left corner starts in column A). Accept columns
  // A-C and prefer the column B anchor when a row has several images.
  private quotationImagesByRow(images: WorkbookImage[]) {
    const imageByRow = new Map<number, { column: number; dataUrl: string }>();
    for (const image of images) {
      if (image.sourceColumn < 1 || image.sourceColumn > 3) {
        continue;
      }
      const existing = imageByRow.get(image.sourceRow);
      if (existing && (existing.column === 2 || image.sourceColumn !== 2)) {
        continue;
      }
      imageByRow.set(image.sourceRow, {
        column: image.sourceColumn,
        dataUrl: image.dataUrl,
      });
    }
    return new Map(
      [...imageByRow].map(([row, image]) => [row, image.dataUrl]),
    );
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
      const invoiceDate = parseInvoiceDate(titleRow);
      let subtotal = 0;
      const orders = new Map<string, ParsedOrder>();
      let lastOrderNumber = '';
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

        let sku = cleanText(dataRow.cells[headers.sku]);
        const quantity = toNumber(dataRow.cells[headers.quantity]) ?? 0;
        const totalCost = toNumber(dataRow.cells[headers.totalCost]) ?? 0;

        // Refund rows have no Order No. cell but reference their order in a
        // label like "1220-refund". Attach them to that order (reusing its
        // product SKU) when it exists anywhere in this store's sheet;
        // otherwise create a standalone refund order under that number.
        const explicitOrderNumber = cleanText(
          dataRow.cells[headers.orderNumber],
        );
        const refundLabelNumber = explicitOrderNumber
          ? ''
          : (this.rowText(dataRow).match(/#?(\d{2,})\s*[-–]?\s*refund/i)?.[1] ??
            '');
        const refundOrderNumber = refundLabelNumber;
        let refundSourceSku = '';
        if (refundLabelNumber) {
          const referencedOrder =
            orders.get(`${refundLabelNumber}|${invoiceReference}`) ??
            this.findStoreOrder(parsed.orders, sheet.name, refundLabelNumber);
          if (referencedOrder) {
            refundSourceSku =
              referencedOrder.lines.find((line) => line.lineType === 'product')
                ?.sku ?? '';
          } else {
            parsed.warnings.push({
              sourceSheet: sheet.name,
              sourceRow: dataRow.rowNumber,
              severity: 'info',
              message: `Refund references order ${refundLabelNumber} which has no other rows in this sheet; kept as a standalone refund order.`,
            });
          }
        }

        if (!sku && (quantity !== 0 || totalCost !== 0)) {
          sku = refundSourceSku || 'UNSPECIFIED';
          if (sku === 'UNSPECIFIED') {
            parsed.warnings.push({
              sourceSheet: sheet.name,
              sourceRow: dataRow.rowNumber,
              severity: 'warning',
              message: 'Order line has quantity or cost but no SKU.',
            });
          }
        }

        if (!sku || (quantity === 0 && totalCost === 0)) {
          index += 1;
          continue;
        }

        const orderNumber =
          explicitOrderNumber || refundOrderNumber || lastOrderNumber;
        const trackingNumber = cleanText(dataRow.cells[headers.trackingNumber]);

        if (!orderNumber) {
          parsed.warnings.push({
            sourceSheet: sheet.name,
            sourceRow: dataRow.rowNumber,
            severity: 'warning',
            message:
              'Continuation row has product data but no previous order context.',
          });
          index += 1;
          continue;
        }

        if (!refundOrderNumber) {
          lastOrderNumber = orderNumber;
        }

        const productCost = toNumber(dataRow.cells[headers.productCost]) ?? 0;
        const shippingCost = toNumber(dataRow.cells[headers.shippingCost]) ?? 0;
        const handlingCost = toNumber(dataRow.cells[headers.handlingCost]) ?? 0;
        const country = headers.country
          ? cleanText(dataRow.cells[headers.country])
          : '';
        const orderDate = parseDateLike(dataRow.cells[headers.time]);
        const estimatedDelivery = headers.deliveryTime
          ? parseDateLike(dataRow.cells[headers.deliveryTime])
          : undefined;
        if (headers.time && dataRow.cells[headers.time] && !orderDate) {
          parsed.warnings.push({
            sourceSheet: sheet.name,
            sourceRow: dataRow.rowNumber,
            severity: 'warning',
            message: `Invalid order date value: ${cleanText(dataRow.cells[headers.time])}`,
          });
        }

        const lineType = classifyOrderLine(this.rowText(dataRow), totalCost);
        const componentTotal = roundMoney(
          productCost + shippingCost + handlingCost,
        );
        if (
          lineType === 'product' &&
          Math.abs(componentTotal - totalCost) > 0.05
        ) {
          parsed.warnings.push({
            sourceSheet: sheet.name,
            sourceRow: dataRow.rowNumber,
            severity: 'warning',
            message: `Order ${orderNumber} line total mismatch: components ${componentTotal.toFixed(
              2,
            )}, total cost ${totalCost.toFixed(2)}.`,
          });
        }
        const orderKey = `${orderNumber}|${invoiceReference}`;
        const order =
          orders.get(orderKey) ??
          ({
            storeName: sheet.name,
            externalOrderNumber: orderNumber,
            orderDate,
            invoiceReference,
            country: country || undefined,
            status: 'PENDING_TRACKING',
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
          lineType,
          sourceSheet: sheet.name,
          sourceRow: dataRow.rowNumber,
        });

        if (isRealTrackingNumber(trackingNumber)) {
          order.status = 'CONFIRMED';
          order.shipments.push({
            trackingNumber,
            estimatedDelivery,
            sourceSheet: sheet.name,
            sourceRow: dataRow.rowNumber,
          });
        }

        this.addProduct(parsed, productKeys, {
          name: sku,
          sku,
          storeName: sheet.name,
          source: 'fallback',
        });
        orders.set(orderKey, order);
        index += 1;
      }

      parsed.orders.push(...orders.values());
      for (const order of orders.values()) {
        const isRefundOnly = order.lines.every(
          (line) => line.lineType === 'refund',
        );
        if (order.shipments.length === 0 && !isRefundOnly) {
          parsed.warnings.push({
            sourceSheet: order.sourceSheet,
            sourceRow: order.sourceRow,
            severity: 'warning',
            message: `Order ${order.externalOrderNumber} is missing tracking and was marked PENDING_TRACKING.`,
          });
        }
      }

      const invoiceLines = [...orders.values()].flatMap((order) => order.lines);
      const normalTotal = sumLineTotals(
        invoiceLines.filter((line) => line.lineType === 'product'),
      );
      const refunds = sumLineTotals(
        invoiceLines.filter((line) => line.lineType === 'refund'),
      );
      const adjustments = sumLineTotals(
        invoiceLines.filter((line) => line.lineType === 'adjustment'),
      );
      const reconciledTotal = normalTotal + refunds + adjustments;
      const otherCost = roundMoney(subtotal - reconciledTotal);

      if (Math.abs(otherCost) > 0.05) {
        parsed.warnings.push({
          sourceSheet: sheet.name,
          sourceRow: totalRowNumber,
          severity: 'warning',
          message: `Invoice ${invoiceReference} total mismatch: total ${subtotal.toFixed(
            2,
          )}, classified ${reconciledTotal.toFixed(
            2,
          )}, unclassified ${otherCost.toFixed(2)}.`,
        });
      }

      parsed.invoices.push({
        storeName: sheet.name,
        invoiceReference,
        invoiceDate,
        subtotal,
        refunds,
        adjustments,
        otherCost,
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
      const purchaseDate = parseDateLike(
        this.extractInvoiceReference(titleRow),
      );
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
          null;

        if (!sku || quantity === 0 || totalCost === null) {
          if (sku && quantity !== 0) {
            parsed.warnings.push({
              sourceSheet: sheet.name,
              sourceRow: dataRow.rowNumber,
              severity: 'warning',
              message: `Stock purchase row for SKU "${sku}" has no cost value and was skipped.`,
            });
          }
          index += 1;
          continue;
        }

        this.addProduct(parsed, productKeys, {
          name: sku,
          sku,
          source: 'fallback',
        });
        parsed.stockPurchases.push({
          sku,
          productName: sku,
          purchaseDate,
          quantity,
          unitCost: quantity > 0 ? totalCost / quantity : undefined,
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
    const productByColumn = new Map<number, StockProductMatch>();
    const headerRow = sheet.rows[0];
    const labelRowIndex = this.findStockListLabelRowIndex(sheet.rows);
    const labelRow = sheet.rows[labelRowIndex];

    if (headerRow) {
      for (const [column, value] of Object.entries(headerRow.cells)) {
        const rawProductName = cleanText(value);
        const productName =
          cleanQuotationProductName(rawProductName).name || rawProductName;
        if (productName && isUsefulQuotationProductName(productName)) {
          const headerColumn = Number(column);
          const stockSku = this.findStockSkuForHeader(
            sheet.rows,
            headerColumn,
            labelRowIndex,
          );
          const dateColumn = this.findStockDateColumn(labelRow, headerColumn);
          const match = this.matchStockProduct(
            parsed.products,
            productName,
            stockSku,
          );
          match.dateColumn = dateColumn;
          productByColumn.set(headerColumn, match);
          if (match.productName) {
            this.addProduct(parsed, productKeys, {
              name: match.productName,
              sku: stockSku,
              source: 'stock_header',
            });
          }
          if (!match.productName || match.confidence < 0.8) {
            parsed.warnings.push({
              sourceSheet: sheet.name,
              sourceRow: headerRow.rowNumber,
              severity: 'warning',
              message: `Stock item "${productName}" needs product matching review.`,
            });
          }
        } else if (rawProductName) {
          parsed.warnings.push({
            sourceSheet: sheet.name,
            sourceRow: headerRow.rowNumber,
            severity: 'warning',
            message: `Ignored invalid stock product header: ${rawProductName}`,
          });
        }
      }
    }

    const usedCommentCells = new Set<string>();

    for (const row of sheet.rows.slice(labelRowIndex + 1)) {
      for (const [columnText, value] of Object.entries(row.cells)) {
        const column = Number(columnText);
        const productColumn = this.findProductForStockColumn(
          productByColumn,
          column,
        );
        if (!productColumn) continue;

        const label = normalizeText(labelRow?.cells[column]);
        if (!['stock', 'used', 'left'].includes(label)) continue;

        const quantity = toNumber(value);
        if (quantity === null || (quantity === 0 && label !== 'left')) continue;

        const cellRef = `${numberToColumn(column)}${row.rowNumber}`;
        const comment = sheet.comments[cellRef];
        if (comment) {
          usedCommentCells.add(cellRef);
        }
        const movementType =
          label === 'left'
            ? 'snapshot'
            : label === 'used'
              ? 'consumption'
              : comment?.toLowerCase().includes('return')
                ? 'return_to_stock'
                : 'inbound';

        parsed.inventoryMovements.push({
          stockName: productColumn.stockName,
          stockSku: productColumn.stockSku,
          productName: productColumn.productName,
          movementDate:
            parseDateLike(
              row.cells[productColumn.dateColumn ?? productColumn.headerColumn - 1],
            ) ??
            undefined,
          movementType,
          quantity,
          reference: comment
            ? cellRef
            : cleanText(row.cells[column - 1]) || undefined,
          comment,
          relationType: productColumn.relationType,
          quantityPerProduct: productColumn.quantityPerProduct,
          confidence: productColumn.confidence,
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
        });
      }
    }

    for (const [cellRef, comment] of Object.entries(sheet.comments)) {
      if (usedCommentCells.has(cellRef)) continue;

      const column = columnToNumber(cellRef);
      const rowNumber = Number(cellRef.match(/\d+/)?.[0] ?? 0);
      const productColumn = this.findProductForStockColumn(
        productByColumn,
        column,
      );
      const productName = productColumn?.productName ?? undefined;
      const movementType = classifyMovement(comment);
      const quantity = extractFirstNumber(comment);

      if (!productName || quantity === null || movementType === 'unsupported') {
        parsed.warnings.push({
          sourceSheet: sheet.name,
          sourceRow: rowNumber,
          severity: 'warning',
          message: `Unsupported stock comment at ${cellRef}: ${cleanText(comment)}`,
        });
        continue;
      }

      parsed.inventoryMovements.push({
        stockName: productColumn?.stockName ?? productName,
        stockSku: productColumn?.stockSku,
        productName,
        movementDate: parseDateLike(comment) ?? undefined,
        movementType,
        quantity: Math.abs(quantity),
        reference: cellRef,
        comment,
        relationType: productColumn?.relationType ?? 'alias',
        quantityPerProduct: productColumn?.quantityPerProduct ?? 1,
        confidence: productColumn?.confidence ?? (productName ? 0.8 : 0),
        sourceSheet: sheet.name,
        sourceRow: rowNumber,
      });
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
      const invoiceReference = formatInvoiceReference(cleanText(row.cells[4]));
      const rawDeposit = row.cells[2];
      const rawInvoice = row.cells[5];
      const depositAmount = toNumber(rawDeposit);
      const invoiceAmount = toNumber(rawInvoice);
      const runningBalance = toNumber(row.cells[6]);
      const exchangeRate = toNumber(row.cells[7]) ?? undefined;

      if (rawDeposit != null && rawDeposit !== '' && depositAmount === null) {
        parsed.warnings.push({
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
          severity: 'warning',
          message: `Non-numeric deposit amount skipped: ${String(rawDeposit)}`,
        });
      }
      if (rawInvoice != null && rawInvoice !== '' && invoiceAmount === null) {
        parsed.warnings.push({
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
          severity: 'warning',
          message: `Non-numeric invoice amount skipped: ${String(rawInvoice)}`,
        });
      }

      if (!storeName && invoiceAmount === null && depositAmount === null) {
        continue;
      }

      if (storeName) {
        const isBrandOwner = this.isBrandOwnerName(storeName);
        const isTransactionCategory = ['stock', 'tax'].includes(
          normalizeStoreName(storeName),
        );
        if (isBrandOwner) {
          parsed.brandName = storeName;
        }

        const store = this.toStore(storeName);
        if (
          !isBrandOwner &&
          !isTransactionCategory &&
          !storeNames.has(store.normalizedName)
        ) {
          parsed.stores.push(store);
          storeNames.add(store.normalizedName);
        }
      }

      const transactionStoreName =
        storeName && !this.isBrandOwnerName(storeName) ? storeName : undefined;

      const depositDate = parseDateLike(row.cells[1]) ?? undefined;
      if (depositAmount !== null && depositDate) {
        parsed.walletTransactions.push({
          storeName: transactionStoreName,
          transactionDate: depositDate,
          transactionType: 'deposit',
          invoiceReference,
          amount: depositAmount,
          runningBalance: runningBalance ?? undefined,
          exchangeRate,
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
        });
      } else if (depositAmount !== null) {
        parsed.warnings.push({
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
          severity: 'info',
          message: `Numeric amount without a deposit date skipped: ${depositAmount}`,
        });
      }

      const balanceNote = cleanText(row.cells[6]);
      const isFixedPriceContract =
        invoiceAmount === 0 && balanceNote.toLowerCase().includes('fixed');

      if (invoiceAmount !== null && !isFixedPriceContract) {
        parsed.walletTransactions.push({
          storeName: transactionStoreName,
          transactionDate: parseDateLike(row.cells[1]) ?? undefined,
          transactionType: this.classifyWalletTransaction(
            transactionStoreName ?? '',
          ),
          invoiceReference,
          amount: -Math.abs(invoiceAmount),
          runningBalance: runningBalance ?? undefined,
          exchangeRate,
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
        });
      } else if (isFixedPriceContract) {
        parsed.warnings.push({
          sourceSheet: sheet.name,
          sourceRow: row.rowNumber,
          severity: 'info',
          message: `Fixed-price contract row skipped for ${storeName || 'unknown store'}: ${balanceNote}`,
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
      parsed.warnings.push({
        sourceSheet: parsed.sheets[0]?.name ?? parsed.fileName,
        sourceRow: 1,
        severity: 'warning',
        message:
          'This exact Excel file was already imported. Confirming will ignore it and no data will be added.',
      });
      return duplicates;
    }

    const invoiceOccurrences = new Map<
      string,
      { invoice: ParsedFulfillmentInvoice; count: number }
    >();

    for (const invoice of parsed.invoices) {
      const key = `${normalizeStoreName(invoice.storeName)}|${invoice.invoiceReference}`;
      const existing = invoiceOccurrences.get(key);
      invoiceOccurrences.set(key, {
        invoice: existing?.invoice ?? invoice,
        count: (existing?.count ?? 0) + 1,
      });
    }

    for (const { invoice, count } of invoiceOccurrences.values()) {
      if (count <= 1) {
        continue;
      }

      const message = `${invoice.storeName} invoice ${invoice.invoiceReference} appears ${count} times in this Excel file.`;
      duplicates.push(message);
      parsed.warnings.push({
        sourceSheet: invoice.sourceSheet,
        sourceRow: invoice.sourceRow,
        severity: 'warning',
        message: `Duplicate invoice reference: ${message}`,
      });
    }

    return duplicates;
  }

  private async ensureDatabaseReady() {
    try {
      await this.prisma.importBatch.findFirst({ select: { id: true } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (
        message.includes('Authentication failed') ||
        message.includes('P1000')
      ) {
        throw new BadRequestException(
          'Cannot access the import database because DATABASE_URL credentials are invalid. Fix backend/.env before retrying the import.',
        );
      }

      if (
        message.includes('does not exist') ||
        message.includes('table') ||
        message.includes('relation')
      ) {
        throw new BadRequestException(
          'Cannot access the import database because the Excel import tables do not exist yet. Open Supabase SQL Editor and run backend/prisma/excel_import_tables.sql. Do not run prisma migrate reset or prisma db push on this existing database.',
        );
      }

      if (
        message.includes("Can't reach database server") ||
        message.includes('connect ETIMEDOUT') ||
        message.includes('ENETUNREACH')
      ) {
        throw new BadRequestException(
          'Cannot access the import database because DATABASE_URL is not reachable. If this is a Supabase direct URL like db.<project>.supabase.co:5432, your network must support IPv6 or the project must have the IPv4 add-on. Otherwise use the Supabase session pooler URL ending in :5432, restart the backend, preview the Excel file again, then retry the import.',
        );
      }

      if (message.includes('TLS') || message.includes('sslmode')) {
        throw new BadRequestException(
          'Cannot access the import database because Prisma could not open a TLS connection to Supabase. Confirm DATABASE_URL includes sslmode=require, restart the backend, preview the Excel file again, then retry the import. If sslmode=require is already set, check the local Windows TLS/security credentials for this Node process.',
        );
      }

      if (
        message.includes('EMAXCONNSESSION') ||
        message.includes('max clients reached')
      ) {
        throw new BadRequestException(
          'Cannot access the import database because the Supabase session pooler client limit was reached. Add connection_limit=1 to DATABASE_URL, restart the backend, preview the Excel file again, then retry the import.',
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
    const alreadyExists = await access(outputPath)
      .then(() => true)
      .catch(() => false);

    if (alreadyExists) {
      return {
        importBatchId: parsed.fileHash,
        storage: 'local',
        summary: preview,
        ignored: true,
        message: `An identical copy of ${parsed.fileName} was already imported. No data was added.`,
      };
    }

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
    const productLines = lineTotals.filter(
      (line) => line.lineType === 'product',
    );
    const shipments = new Set(
      parsed.orders.flatMap((order) =>
        order.shipments.map((shipment) => shipment.trackingNumber),
      ),
    ).size;
    const currentBalance = [...parsed.walletTransactions]
      .reverse()
      .find(
        (transaction) => transaction.runningBalance !== null,
      )?.runningBalance;

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
        refunds: lineTotals.filter((line) => line.lineType === 'refund').length,
        stockPurchases: parsed.stockPurchases.length,
        stockMovements: parsed.inventoryMovements.length,
        walletTransactions: parsed.walletTransactions.length,
        warnings: parsed.warnings.length,
        duplicateRecords: duplicateRecords.length,
      },
      totals: {
        productCosts: sum(productLines, 'productCost'),
        shippingCosts: sum(productLines, 'shippingCost'),
        handlingCosts: sum(productLines, 'handlingCost'),
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
      } else if (
        label.includes('delivery time') ||
        label.includes('delivery date')
      ) {
        headers.deliveryTime = column;
      } else if (label === 'country') {
        headers.country = column;
      } else if (label.includes('time')) {
        headers.time = column;
      }
    }

    return headers;
  }

  // Loose product-name match: squashed containment ("glassbrush" in
  // "oldglassbrush") or every header token appearing in the squashed
  // candidate name ("carplay3", "android", "apple" all inside
  // "carplay3in1appleandroidblacksilver"). Prefers the shortest candidate.
  private findQuotationProductByLooseName(
    products: ParsedProduct[],
    name: string,
  ) {
    const target = squashProductName(name);
    const tokens = looseNameTokens(name);
    if (target.length < 4 || tokens.length === 0) return undefined;

    const candidates = products.filter((product) => {
      if (product.source !== 'quotation') return false;
      const candidate = squashProductName(product.name);
      if (candidate.length < 4) return false;
      if (candidate.includes(target) || target.includes(candidate)) {
        return true;
      }
      return tokens.every((token) => candidate.includes(token));
    });

    return candidates.sort(
      (left, right) =>
        squashProductName(left.name).length -
        squashProductName(right.name).length,
    )[0];
  }

  private findStoreOrder(
    parsedOrders: ParsedOrder[],
    storeName: string,
    orderNumber: string,
  ) {
    for (let index = parsedOrders.length - 1; index >= 0; index -= 1) {
      const order = parsedOrders[index];
      if (
        order.storeName === storeName &&
        order.externalOrderNumber === orderNumber
      ) {
        return order;
      }
    }
    return undefined;
  }

  private findTitleRow(rows: WorkbookRow[], headerIndex: number) {
    for (
      let index = headerIndex - 1;
      index >= Math.max(0, headerIndex - 3);
      index -= 1
    ) {
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
        return formatInvoiceReference(value);
      }
    }

    return `row-${row.rowNumber}`;
  }

  private addProduct(
    parsed: ParsedImport,
    productKeys: Set<string>,
    product: ParsedProduct,
  ) {
    const sku = product.sku ? cleanText(product.sku) : '';
    const existingBySku = sku
      ? parsed.products.find((item) => item.sku === sku)
      : undefined;

    if (existingBySku) {
      existingBySku.quotation = mergeProductQuotation(
        existingBySku.quotation,
        product.quotation,
      );
      existingBySku.imageUrl = existingBySku.imageUrl ?? product.imageUrl;
      if (
        product.source === 'quotation' &&
        normalizeProductName(existingBySku.name) === normalizeProductName(sku)
      ) {
        existingBySku.name = product.name;
        existingBySku.description =
          product.description ?? existingBySku.description;
        existingBySku.weight = product.weight ?? existingBySku.weight;
        existingBySku.source = 'quotation';
      }
      return;
    }

    const existingByName = parsed.products.find(
      (item) =>
        normalizeProductName(item.name) === normalizeProductName(product.name),
    );

    if (existingByName && !sku) {
      existingByName.description =
        existingByName.description ?? product.description;
      existingByName.weight = existingByName.weight ?? product.weight;
      existingByName.quotation = mergeProductQuotation(
        existingByName.quotation,
        product.quotation,
      );
      existingByName.imageUrl = existingByName.imageUrl ?? product.imageUrl;
      return;
    }

    const key = `${normalizeProductName(product.name)}|${sku}|${product.storeName ?? ''}`;
    if (productKeys.has(key)) return;
    productKeys.add(key);
    parsed.products.push(product);
  }

  private toStore(name: string): ParsedStore {
    const normalizedName = normalizeStoreName(name);
    const country = this.extractCountry(name);
    const platform = name.toLowerCase().includes('woo')
      ? 'WooCommerce'
      : undefined;

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

  private matchStockProduct(
    products: ParsedProduct[],
    stockName: string,
    stockSku?: string,
  ): StockProductMatch {
    const sku = cleanText(stockSku);
    if (sku) {
      const skuMatch = products.find((product) => product.sku === sku);
      if (skuMatch) {
        return {
          stockName,
          stockSku: sku,
          productName: skuMatch.name,
          relationType: 'alias',
          quantityPerProduct: 1,
          confidence: 0.99,
        };
      }
    }

    const known = knownStockLinks.find(
      (item) =>
        normalizeInventoryName(item.stockName) ===
        normalizeInventoryName(stockName),
    );
    const quotationProducts = products.filter(
      (product) => product.source === 'quotation',
    );
    const findKnownProduct = (name: string) =>
      quotationProducts.find(
        (product) =>
          normalizeInventoryName(product.name) === normalizeInventoryName(name),
      ) ?? this.findQuotationProductByLooseName(products, name);

    if (known) {
      const product = findKnownProduct(known.productName);
      return {
        stockName,
        stockSku: sku || undefined,
        productName: product?.name ?? known.productName,
        relationType: known.relationType,
        quantityPerProduct: known.quantityPerProduct ?? 1,
        confidence: product ? 0.99 : 0.85,
      };
    }

    const normalizedStock = normalizeInventoryName(stockName);
    const exact = quotationProducts.find(
      (product) => normalizeInventoryName(product.name) === normalizedStock,
    );
    if (exact) {
      return {
        stockName,
        stockSku: sku || undefined,
        productName: exact.name,
        relationType: 'alias',
        quantityPerProduct: 1,
        confidence: 0.95,
      };
    }

    const component = this.findComponentProduct(quotationProducts, stockName);
    if (component) {
      return {
        stockName,
        stockSku: sku || undefined,
        productName: component.name,
        relationType: 'component',
        quantityPerProduct: inferQuantityPerProduct(stockName, component.name),
        confidence: 0.82,
      };
    }

    const fuzzy = this.findQuotationProductByLooseName(products, stockName);
    if (fuzzy) {
      return {
        stockName,
        stockSku: sku || undefined,
        productName: fuzzy.name,
        relationType: 'variant',
        quantityPerProduct: 1,
        confidence: 0.72,
      };
    }

    return {
      stockName,
      stockSku: sku || undefined,
      relationType: 'alias',
      quantityPerProduct: 1,
      confidence: 0,
    };
  }

  private findComponentProduct(products: ParsedProduct[], stockName: string) {
    const tokens = looseNameTokens(stockName).filter((token) => token.length > 2);
    if (tokens.length === 0) return undefined;

    return products
      .filter((product) => {
        const candidate = looseNameTokens(product.name);
        return tokens.every((token) => candidate.includes(token));
      })
      .sort((left, right) => right.name.length - left.name.length)[0];
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
    productByColumn: Map<number, StockProductMatch>,
    column: number,
  ) {
    const match = [...productByColumn.entries()]
      .filter(([productColumn]) => productColumn <= column)
      .sort(([left], [right]) => right - left)[0];

    return match ? { headerColumn: match[0], ...match[1] } : undefined;
  }

  private findStockListLabelRowIndex(rows: WorkbookRow[]) {
    let bestIndex = 1;
    let bestScore = 0;

    for (let index = 1; index < Math.min(rows.length, 5); index += 1) {
      const score = Object.values(rows[index]?.cells ?? {}).filter((value) => {
        const label = normalizeText(value);
        return label === 'stock' || label === 'used' || label === 'left';
      }).length;

      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    return bestIndex;
  }

  private findStockSkuForHeader(
    rows: WorkbookRow[],
    headerColumn: number,
    labelRowIndex: number,
  ) {
    for (let index = 1; index < labelRowIndex; index += 1) {
      const sku = cleanText(rows[index]?.cells[headerColumn]);
      if (sku) return sku;
    }

    return undefined;
  }

  private findStockDateColumn(
    labelRow: WorkbookRow | undefined,
    headerColumn: number,
  ) {
    for (let column = headerColumn; column <= headerColumn + 6; column += 1) {
      const label = normalizeText(labelRow?.cells[column]);
      if (label === 'stock' || label === 'used') {
        return column - 1;
      }
    }

    return headerColumn - 1;
  }

  private lookupStoreId(storeIds: Map<string, string>, storeName: string) {
    return (
      storeIds.get(storeName) ?? storeIds.get(normalizeStoreName(storeName))
    );
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

function normalizeProductName(value: string) {
  return normalizeText(value).replace(/\s+/g, ' ');
}

function normalizeDecoderText(value: unknown) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[\[\]()+/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function squashProductName(value: string) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '');
}

function looseNameTokens(value: string) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function normalizeInventoryName(value: unknown) {
  return cleanText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[-/()_[\]+]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function inferQuantityPerProduct(stockName: string, productName: string) {
  const stockTokens = looseNameTokens(stockName);
  for (const token of stockTokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const before = productName.match(new RegExp(`(\\d+)\\s*${escaped}`, 'i'));
    if (before) return Number(before[1]);
    const after = productName.match(new RegExp(`${escaped}\\s*\\+\\s*(\\d+)`, 'i'));
    if (after) return Number(after[1]);
  }
  return 1;
}

function canonicalSkuKey(value: unknown) {
  const sku = cleanText(value);
  // Only treat long trailing digit codes as canonical (e.g. 12848-12765 ->
  // 12765); short suffixes like Boltwave-PRO-001 / Hydromax-KIT-001 would
  // collide on "001" and merge unrelated products.
  const match = sku.match(/-(\d{4,})\s*$/);
  return match?.[1] ?? sku;
}

function isDecoderSkuCode(value: string) {
  const sku = cleanText(value);
  if (/^product id$|^sku$/i.test(sku)) return false;
  if (sku.includes(' ')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/.test(sku);
}

function splitSkuAliases(value: unknown) {
  if (value === null || value === undefined) return [];
  return String(value)
    .split(/\r?\n|,|;/)
    .map((item) => cleanText(item))
    .filter(
      (item) => item && item !== '/' && !normalizeText(item).includes('sku'),
    );
}

type QuotationData = NonNullable<ParsedProduct['quotation']>;

type QuotationNameInfo = {
  name?: string;
  bracketOnly?: boolean;
  warning?: boolean;
  moq?: string;
  retired?: boolean;
  notes: string[];
  stockNotes: string[];
};

function cleanQuotationProductName(value: unknown): QuotationNameInfo {
  const text = cleanText(value);
  const info: QuotationNameInfo = { notes: [], stockNotes: [] };
  if (!text) return info;
  if (isQuotationContinuationQuantityLabel(text)) return info;

  const candidates: string[] = [];
  const bracketCandidates: string[] = [];
  for (const rawLine of String(value).split(/\r?\n/)) {
    let line = cleanText(rawLine);
    if (!line) continue;

    for (const match of line.matchAll(/\[([^\]]+)\]/g)) {
      const bracketName = cleanText(match[1]);
      if (isUsefulQuotationProductName(bracketName)) {
        bracketCandidates.push(bracketName);
      }
    }

    const moq = extractMoqText(line);
    if (moq) {
      info.moq = moq;
    }
    if (/will\s+removed|will\s+be\s+removed|removed/i.test(line)) {
      info.retired = true;
      info.notes.push(line);
    }
    if (/stock|warehouse/i.test(line)) {
      info.stockNotes.push(line);
    }

    line = line.replace(/\[[^\]]+\]/g, ' ');
    line = line.replace(/MOQ\s*\d+\s*pcs?\s*[:：-]?/gi, ' ');
    line = line.replace(/factory\s+have\s+prepare\s+stock/gi, ' ');
    line = line.replace(/have\s+prepare\s+stock/gi, ' ');
    line = line.replace(/have\s+stock/gi, ' ');
    line = line.replace(/stock\s+at\s+warehouse/gi, ' ');
    line = cleanText(line.replace(/[：:]+$/g, ''));

    if (isUsefulQuotationProductName(line)) {
      candidates.push(line);
    } else if (line && !isNumericText(line)) {
      info.notes.push(line);
    }
  }

  if (candidates.length > 0) {
    info.name = candidates.join(' ');
  } else if (bracketCandidates.length > 0) {
    info.name = bracketCandidates.join(' ');
    info.bracketOnly = true;
  } else {
    info.warning = !isNumericText(text);
  }

  return info;
}

function quotationGroupLabel(value: unknown) {
  for (const rawLine of String(value ?? '').split(/\r?\n/)) {
    let line = cleanText(rawLine);
    if (!line) continue;

    line = line.replace(/\[([^\]]+)\]/g, '$1');
    line = line.replace(/MOQ\s*\d+\s*pcs?\s*[:：-]?/gi, ' ');
    line = line.replace(/factory\s+have\s+prepare\s+stock/gi, ' ');
    line = line.replace(/have\s+prepare\s+stock/gi, ' ');
    line = line.replace(/have\s+stock/gi, ' ');
    line = line.replace(/stock\s+at\s+warehouse/gi, ' ');
    line = line.replace(/will\s+(be\s+)?removed/gi, ' ');
    line = cleanText(line.replace(/[：:]+$/g, ''));

    if (
      line &&
      !isNumericText(line) &&
      !isQuotationContinuationQuantityLabel(line)
    ) {
      return line;
    }
  }
  return '';
}

function cleanQuotationDescription(value: unknown, productName: string) {
  const text = cleanText(value);
  if (
    !text ||
    normalizeProductName(text) === normalizeProductName(productName)
  ) {
    return undefined;
  }
  return isUsefulQuotationProductName(text) ? text : undefined;
}

function extractQuotationData(
  row: WorkbookRow,
  nameInfo: QuotationNameInfo,
  sheetName: string,
  mergedDeliveryTime?: string,
): QuotationData {
  const quotation: QuotationData = {};
  const quantity = toNumber(row.cells[5]);
  const unitPrice = toNumber(row.cells[6]);
  const weight = toNumber(row.cells[7]);
  const weightText = cleanText(row.cells[7]);
  const serviceFee = toNumber(row.cells[12]);
  const landedCost = toNumber(row.cells[13]);
  // When the GB/USA landed costs were pasted into columns Q/R, ignore the
  // delivery-time copy (Q) but keep column R: it is the Selling price column
  // and its value is what the sheet displays as selling price.
  const pastedLandedCost = isPastedLandedCostPricing(row);
  const deliveryOrSelling = pastedLandedCost
    ? (mergedDeliveryTime ?? '')
    : cleanText(row.cells[17]) || (mergedDeliveryTime ?? '');
  const explicitSellingPrice = toNumber(row.cells[18]);
  const notes = [...nameInfo.notes];
  const stockNotes = [...nameInfo.stockNotes];
  const quantityText = quotationQuantityText(row);
  const quantityLabel = quantityText;
  const extraNotes = cleanText(row.cells[19]);
  const rowOnlyNotes = [
    isQuotationNoteText(weightText) ? weightText : '',
    extraNotes,
    nameInfo.retired ? 'will removed' : '',
    ...nameInfo.notes,
    ...nameInfo.stockNotes,
  ];
  const rowNotes = uniqueStrings([...rowOnlyNotes]);
  const quotationRow = {
    sourceKey: `${sheetName}:${row.rowNumber}`,
    sourceSheet: sheetName,
    sourceRow: row.rowNumber,
    quantityLabel: quantityLabel || undefined,
    quantity: quantityText || nameInfo.moq || undefined,
    unitPrice: rawOfferValue(row.cells[6]),
    weight: isQuotationNoteText(weightText)
      ? undefined
      : rawOfferValue(row.cells[7]),
    freightFR: rawOfferValue(row.cells[8]),
    freightDE: rawOfferValue(row.cells[9]),
    freightGB: rawOfferValue(row.cells[10]),
    freightUSA: rawOfferValue(row.cells[11]),
    serviceFee: rawOfferValue(row.cells[12]),
    totalCostFR: rawOfferValue(row.cells[13]),
    totalCostDE: rawOfferValue(row.cells[14]),
    totalCostGB: rawOfferValue(row.cells[15]),
    totalCostUSA: rawOfferValue(row.cells[16]),
    deliveryTime: looksLikeDeliveryTime(deliveryOrSelling)
      ? deliveryOrSelling
      : undefined,
    sellingPrice:
      rawOfferValue(row.cells[18]) ||
      (!looksLikeDeliveryTime(deliveryOrSelling)
        ? deliveryOrSelling || undefined
        : undefined),
    notes: rowNotes.join('; ') || undefined,
  };

  if (quantity !== null) quotation.quantity = quantity;
  if (unitPrice !== null) quotation.unitPrice = unitPrice;
  if (weight !== null) quotation.weight = weight;
  if (serviceFee !== null) quotation.serviceFee = serviceFee;
  if (landedCost !== null) quotation.landedCost = landedCost;
  if (nameInfo.moq) quotation.moq = nameInfo.moq;
  if (nameInfo.retired) quotation.retired = true;

  const moq = extractMoqText(quantityText);
  if (moq) {
    quotation.moq = moq;
    notes.push(quantityText);
  } else if (quantityText && !isNumericText(quantityText)) {
    quotation.quantityConditions = [quantityText];
  }

  if (weightText && weight === null) {
    stockNotes.push(weightText);
  }

  const freightByCountry = [
    countryAmount('FR', row.cells[8]),
    countryAmount('DE', row.cells[9]),
    countryAmount('GB', row.cells[10]),
    countryAmount('USA', row.cells[11]),
  ].filter((item): item is { country: string; amount: number } =>
    Boolean(item),
  );
  if (freightByCountry.length > 0) {
    quotation.freightByCountry = freightByCountry;
  }

  const landedCostByCountry = [
    countryAmount('FR', row.cells[13]),
    countryAmount('DE', row.cells[14]),
    countryAmount('GB', row.cells[15]),
    countryAmount('USA', row.cells[16]),
  ].filter((item): item is { country: string; amount: number } =>
    Boolean(item),
  );
  if (landedCostByCountry.length > 0) {
    quotation.landedCostByCountry = landedCostByCountry;
  }

  if (deliveryOrSelling) {
    if (looksLikeDeliveryTime(deliveryOrSelling)) {
      quotation.deliveryTime = deliveryOrSelling;
    } else {
      const numeric = toNumber(deliveryOrSelling);
      if (numeric !== null) {
        quotation.sellingPrice = numeric;
      } else {
        notes.push(deliveryOrSelling);
      }
    }
  }

  if (explicitSellingPrice !== null) {
    quotation.sellingPrice = explicitSellingPrice;
  }

  if (extraNotes) {
    notes.push(extraNotes);
  }
  if (stockNotes.length > 0) {
    quotation.stockNotes = uniqueStrings(stockNotes);
  }
  if (notes.length > 0) {
    quotation.notes = uniqueStrings(notes);
  }
  if (
    quantity !== null ||
    unitPrice !== null ||
    landedCost !== null ||
    quotation.sellingPrice !== undefined
  ) {
    quotation.priceTiers = [
      {
        quantity: quantity ?? undefined,
        unitPrice: unitPrice ?? undefined,
        landedCost: landedCost ?? undefined,
        sellingPrice: quotation.sellingPrice,
      },
    ];
  }
  if (hasQuotationOfferValues(quotationRow)) {
    quotation.quotationRows = [quotationRow];
  }

  return quotation;
}

function countryAmount(country: string, value: unknown) {
  const amount = toNumber(value);
  return amount === null ? null : { country, amount };
}

function rawOfferValue(value: unknown) {
  const text = cleanText(value);
  return text || undefined;
}

function quotationQuantityText(row: WorkbookRow) {
  const quantityText = cleanText(row.cells[5]);
  if (quantityText) return quantityText;

  const continuationLabel = cleanText(row.cells[1]);
  return isQuotationContinuationQuantityLabel(continuationLabel)
    ? continuationLabel
    : '';
}

function isQuotationContinuationQuantityLabel(value: string) {
  const text = normalizeText(value);
  return /^(\d+|\d+\s*pcs?|per\s+pcs?|per\s+pieces?|per\s+order)$/.test(text);
}

function isQuotationNoteText(value: string) {
  const lower = normalizeText(value);
  return Boolean(
    lower &&
    (lower.includes('stock at warehouse') ||
      lower.includes('warehouse') ||
      lower.includes('ship only') ||
      lower.includes('per order') ||
      lower.includes('will removed') ||
      lower.includes('will be removed')),
  );
}

function hasQuotationOfferValues(value: Record<string, unknown>) {
  return Object.entries(value).some(([key, item]) => {
    if (key === 'sourceKey' || key === 'sourceSheet' || key === 'sourceRow') {
      return false;
    }
    return item !== undefined && item !== null && item !== '';
  });
}

function hasUsefulQuotationData(value: QuotationData | undefined) {
  if (!value) return false;
  return Object.values(value).some((item) => {
    if (Array.isArray(item)) return item.length > 0;
    return item !== undefined && item !== null && item !== '';
  });
}

function hasActiveProductDetails(product: {
  description?: string | null;
  weight?: number | null;
  quotation?: unknown;
  imageUrl?: string | null;
}) {
  if (cleanText(product.description)) return true;
  if (cleanText(product.imageUrl)) return true;
  if (typeof product.weight === 'number' && Number.isFinite(product.weight)) {
    return true;
  }
  return hasCatalogData(product.quotation);
}

function hasCatalogData(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'string') return cleanText(value).length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some((item) => hasCatalogData(item));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) =>
      hasCatalogData(item),
    );
  }
  return false;
}

function mergeProductQuotation(
  existing: ParsedProduct['quotation'],
  next: ParsedProduct['quotation'],
): ParsedProduct['quotation'] {
  if (!existing) return next;
  if (!next) return existing;

  // First row wins for scalar fields (base offer, usually quantity 1);
  // later quantity-tier rows only fill gaps and extend the arrays below.
  const merged: QuotationData = { ...next, ...existing };
  merged.quantityConditions = uniqueStrings([
    ...(existing.quantityConditions ?? []),
    ...(next.quantityConditions ?? []),
  ]);
  merged.freightByCountry = uniqueObjects([
    ...(existing.freightByCountry ?? []),
    ...(next.freightByCountry ?? []),
  ]);
  merged.landedCostByCountry = uniqueObjects([
    ...(existing.landedCostByCountry ?? []),
    ...(next.landedCostByCountry ?? []),
  ]);
  merged.stockNotes = uniqueStrings([
    ...(existing.stockNotes ?? []),
    ...(next.stockNotes ?? []),
  ]);
  merged.notes = uniqueStrings([
    ...(existing.notes ?? []),
    ...(next.notes ?? []),
  ]);
  merged.quotationRows = uniqueObjects([
    ...(existing.quotationRows ?? []),
    ...(next.quotationRows ?? []),
  ]);
  merged.priceTiers = uniqueObjects([
    ...(existing.priceTiers ?? []),
    ...(next.priceTiers ?? []),
  ]);
  merged.retired = Boolean(existing.retired || next.retired) || undefined;

  for (const key of [
    'quantityConditions',
    'freightByCountry',
    'landedCostByCountry',
    'stockNotes',
    'notes',
    'quotationRows',
    'priceTiers',
  ] as const) {
    if (Array.isArray(merged[key]) && merged[key]?.length === 0) {
      delete merged[key];
    }
  }

  return hasUsefulQuotationData(merged) ? merged : undefined;
}

function isUsefulQuotationProductName(value: string) {
  const text = cleanText(value);
  const lower = normalizeText(text);
  if (!text || text === '/' || isNumericText(text)) return false;
  if (/^\[[^\]]+\]$/.test(text)) return false;
  if (
    lower.includes('stock at warehouse') ||
    /^\d+\s*pcs?$/.test(lower) ||
    lower.includes('per pcs') ||
    lower.includes('per order') ||
    lower.includes('ship only') ||
    lower.includes('factory have prepare stock') ||
    lower.includes('will removed') ||
    lower.includes('will be removed') ||
    lower === 'total' ||
    lower.includes('total cost') ||
    lower === 'sku' ||
    lower === 'details' ||
    lower === 'picture'
  ) {
    return false;
  }
  return true;
}

function extractMoqText(value: string) {
  const match = cleanText(value).match(/MOQ\s*\d+\s*pcs?/i);
  return match?.[0];
}

// Some quotation rows have the GB/USA landed costs pasted into the
// Delivery date (Q) and Selling price (R) columns. When both values exactly
// mirror the row's own landed costs they are copies, not a selling price.
function isPastedLandedCostPricing(row: WorkbookRow) {
  const deliveryText = cleanText(row.cells[17]);
  if (!deliveryText || looksLikeDeliveryTime(deliveryText)) return false;

  const deliveryValue = toNumber(deliveryText);
  const sellingValue = toNumber(row.cells[18]);
  const landedCostGB = toNumber(row.cells[15]);
  const landedCostUSA = toNumber(row.cells[16]);

  return (
    deliveryValue !== null &&
    sellingValue !== null &&
    landedCostGB !== null &&
    landedCostUSA !== null &&
    deliveryValue === landedCostGB &&
    sellingValue === landedCostUSA
  );
}

function looksLikeDeliveryTime(value: string) {
  const lower = normalizeText(value);
  return (
    /\d/.test(lower) && /(day|days|week|weeks|month|months|working)/.test(lower)
  );
}

function isNumericText(value: string) {
  if (!value) return false;
  return toNumber(value) !== null;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function uniqueObjects<T>(values: T[]) {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
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
    const wholeDays = Math.floor(numeric);
    const fractionalDay = numeric - wholeDays;
    const milliseconds = Math.round(fractionalDay * 86400000);
    return new Date(Date.UTC(1899, 11, 30 + wholeDays) + milliseconds);
  }

  const text = cleanText(value);
  const dateMatch = text.match(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}/);
  if (dateMatch) {
    const date = new Date(dateMatch[0].replace(/\//g, '-'));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  return undefined;
}

function formatInvoiceReference(value: string) {
  const normalized = cleanText(value);
  const writtenDate = normalized.match(
    /^(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(.*)$/,
  );
  if (writtenDate) {
    const [, year, month, day, suffix] = writtenDate;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}${suffix}`;
  }

  const numeric = toNumber(value);
  if (numeric === null || numeric < 40000 || numeric > 60000) {
    return normalized;
  }

  const date = parseDateLike(value);
  return date ? date.toISOString().slice(0, 10) : normalized;
}

function parseInvoiceDate(row: WorkbookRow | undefined): Date | undefined {
  if (!row) return undefined;

  for (const column of [3, 4, 2, 1]) {
    const date = parseDateLike(row.cells[column]);
    if (date) return date;
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
  return Number(
    values.reduce((total, item) => total + item[key], 0).toFixed(2),
  );
}

function sumLineTotals(lines: ParsedOrderLine[]) {
  return roundMoney(
    lines.reduce((total, line) => total + line.totalCost, 0),
  );
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function classifyOrderLine(rowText: string, totalCost: number) {
  if (rowText.includes('refund') || totalCost < 0) return 'refund';
  if (rowText.match(/correction|adjust|modify|difference|redeliver/)) {
    return 'adjustment';
  }
  return 'product';
}

function isRealTrackingNumber(value: string) {
  const normalized = normalizeText(value);
  return Boolean(
    normalized &&
    normalized !== '/' &&
    normalized !== '-' &&
    normalized !== 'n/a' &&
    normalized !== 'na',
  );
}

function classifyMovement(comment: string) {
  const text = normalizeText(comment);
  if (text.includes('return')) return 'return_to_stock';
  if (text.includes('transfer')) return 'transfer';
  if (text.includes('arrive') || text.includes('warehouse')) return 'arrival';
  if (text.includes('adjust') || text.includes('fix')) return 'adjustment';
  if (
    text.includes('stock') ||
    text.includes('receive') ||
    text.includes('inbound')
  ) {
    return 'inbound';
  }
  if (text.includes('used') || text.includes('consum')) return 'consumption';
  return 'unsupported';
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

function numberToColumn(column: number) {
  let value = column;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}
