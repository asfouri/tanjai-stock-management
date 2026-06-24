import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { PrismaService } from './prisma.service';

const gunzipAsync = promisify(gunzip);

type ChartPoint = {
  label: string;
  total: number;
};

type ActivityItem = {
  id: string;
  type: string;
  title: string;
  createdAt: string | null;
};

type AttentionItem = {
  label: string;
  total: number;
};

type DashboardFilters = {
  brand?: string;
  store?: string;
  dateFrom?: string;
  dateTo?: string;
  sku?: string;
  invoice?: string;
  orderNumber?: string;
  trackingNumber?: string;
};

type DashboardSummary = {
  totalOrders: number;
  totalShipments: number;
  totalInvoices: number;
  totalCosts: number;
  productCosts: number;
  shippingCosts: number;
  handlingCosts: number;
  refunds: number;
  currentBalance: number;
  stockStatus: number;
  totalRequests: number;
  anomaliesDetected: number;
  pendingOrders: number;
  ordersOverTime: ChartPoint[];
  costsByDate: ChartPoint[];
  ordersByStore: ChartPoint[];
  costsByStore: ChartPoint[];
  costDistribution: ChartPoint[];
  stockByProduct: ChartPoint[];
  ordersByStatus: ChartPoint[];
  requestsOverview: ChartPoint[];
  anomaliesBySeverity: ChartPoint[];
  recentActivity: ActivityItem[];
  attentionRequired: AttentionItem[];
  filterOptions: {
    brands: string[];
    stores: string[];
    skus: string[];
    invoices: string[];
    orderNumbers: string[];
    trackingNumbers: string[];
    dates: string[];
  };
  debugCounts?: DashboardDebugCounts;
};

type DashboardDebugCounts = {
  orders: number;
  shipments: number;
  invoices: number;
  stockPurchases: number;
  inventoryMovements: number;
  walletTransactions: number;
  products: number;
  importBatches: number;
  databaseHost: string;
  storage: string;
};

type DashboardSection = {
  title: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string | number | string[] | Record<string, unknown> | null>>;
};

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async getDashboardSection(section: string): Promise<DashboardSection> {
    switch (section) {
      case 'products':
        return this.getProductsSection();
      case 'orders':
        return this.getOrdersSection();
      case 'inventory':
        return this.getInventorySection();
      case 'stores':
        return this.getStoresSection();
      case 'invoices':
        return this.getInvoicesSection();
      case 'payments':
        return this.getPaymentsSection();
      default:
        return { title: 'Dashboard', columns: [], rows: [] };
    }
  }

  async getDashboardSummary(
    filters: DashboardFilters = {},
  ): Promise<DashboardSummary> {
    const normalizedFilters = this.normalizeDashboardFilters(filters);

    if (process.env.EXCEL_IMPORT_STORAGE !== 'prisma') {
      const localSummary = await this.getLocalImportDashboardSummary(normalizedFilters);
      if (localSummary) {
        return localSummary;
      }
    }

    return this.getErpDashboardSummary(normalizedFilters);
  }

  private async getLocalImportDashboardSummary(
    filters: DashboardFilters,
  ): Promise<DashboardSummary | null> {
    try {
      const importDir = resolve(process.cwd(), 'local-imports');
      const files = (await readdir(importDir)).filter((file) =>
        file.endsWith('.json.gz'),
      );

      if (files.length === 0) {
        return null;
      }

      const imports = await Promise.all(
        files.map(async (file) => {
          const compressed = await readFile(resolve(importDir, file));
          return JSON.parse((await gunzipAsync(compressed)).toString('utf8'));
        }),
      );
      const parsedImports = imports.map((item) => item.parsed);
      const orders = parsedImports.flatMap((item) => item.orders ?? []);
      const invoices = parsedImports.flatMap((item) => item.invoices ?? []);
      const movements = parsedImports.flatMap(
        (item) => item.inventoryMovements ?? [],
      );
      const warnings = parsedImports.flatMap((item) => item.warnings ?? []);
      const lines = orders.flatMap((order) =>
        (order.lines ?? []).map((line) => ({ ...line, order })),
      );
      const brandNames = [
        ...new Set(
          parsedImports
            .map((item) => item.brandName)
            .filter((value): value is string => Boolean(value)),
        ),
      ].sort();
      const stores = [
        ...new Set(
          parsedImports.flatMap(
            (item) =>
              item.stores
                ?.map((store) => store.name)
                .filter((name) => !isBrandOwnerName(name)) ?? [],
          ),
        ),
      ].sort();
      const skus = [...new Set(lines.map((line) => line.sku).filter(Boolean))]
        .sort()
        .slice(0, 500);
      const invoiceRefs = [
        ...new Set(invoices.map((invoice) => invoice.invoiceReference).filter(Boolean)),
      ].slice(0, 500);
      const orderNumbers = [
        ...new Set(
          orders
            .map((order) => order.externalOrderNumber)
            .filter(Boolean)
            .map(String),
        ),
      ]
        .sort()
        .slice(0, 500);
      const trackingNumbers = [
        ...new Set(
          orders.flatMap((order) =>
            (order.shipments ?? [])
              .map((shipment) => shipment.trackingNumber)
              .filter(Boolean)
              .map(String),
          ),
        ),
      ]
        .sort()
        .slice(0, 500);
      const dates = [
        ...new Set(
          [
            ...orders.map((order) => order.orderDate),
            ...invoices.map((invoice) => invoice.invoiceDate),
          ]
            .map((value) => this.toDateOption(value))
            .filter((value): value is string => Boolean(value)),
        ),
      ].sort();
      const filteredOrders = orders.filter((order) => {
        if (filters.store && !sameText(order.storeName, filters.store)) return false;
        if (
          filters.orderNumber &&
          !String(order.externalOrderNumber)
            .toLowerCase()
            .includes(filters.orderNumber.toLowerCase())
        ) {
          return false;
        }
        if (
          filters.invoice &&
          !String(order.invoiceReference)
            .toLowerCase()
            .includes(filters.invoice.toLowerCase())
        ) {
          return false;
        }
        if (
          filters.sku &&
          !(order.lines ?? []).some((line) =>
            String(line.sku).toLowerCase().includes(filters.sku!.toLowerCase()),
          )
        ) {
          return false;
        }
        if (
          filters.trackingNumber &&
          !(order.shipments ?? []).some((shipment) =>
            String(shipment.trackingNumber)
              .toLowerCase()
              .includes(filters.trackingNumber!.toLowerCase()),
          )
        ) {
          return false;
        }
        return this.isInDateRange(order.orderDate, filters);
      });
      const filteredInvoices = invoices.filter((invoice) => {
        if (filters.store && !sameText(invoice.storeName, filters.store)) return false;
        if (
          filters.invoice &&
          !String(invoice.invoiceReference)
            .toLowerCase()
            .includes(filters.invoice.toLowerCase())
        ) {
          return false;
        }
        return this.isInDateRange(invoice.invoiceDate, filters);
      });
      const filteredLines = filteredOrders.flatMap((order) =>
        (order.lines ?? []).map((line) => ({ ...line, order })),
      );
      const productLines = filteredLines.filter(
        (line) => (line.lineType ?? 'product') === 'product',
      );
      const uniqueTrackingNumbers = new Set(
        filteredOrders.flatMap((order) =>
          (order.shipments ?? [])
            .map((shipment) => shipment.trackingNumber)
            .filter(Boolean),
        ),
      );
      const latestWallet = parsedImports
        .flatMap((item) => item.walletTransactions ?? [])
        .reverse()
        .find((transaction) => typeof transaction.runningBalance === 'number');
      const productCosts = this.round(
        productLines.reduce((total, line) => total + line.productCost, 0),
      );
      const shippingCosts = this.round(
        productLines.reduce((total, line) => total + line.shippingCost, 0),
      );
      const handlingCosts = this.round(
        productLines.reduce((total, line) => total + line.handlingCost, 0),
      );
      const totalCosts = this.round(
        filteredInvoices.reduce((total, invoice) => total + invoice.total, 0),
      );
      const refunds = this.round(
        filteredInvoices.reduce((total, invoice) => total + invoice.refunds, 0),
      );

      return {
        totalOrders: filteredOrders.length,
        totalShipments: uniqueTrackingNumbers.size,
        totalInvoices: filteredInvoices.length,
        totalCosts,
        productCosts,
        shippingCosts,
        handlingCosts,
        refunds,
        currentBalance: latestWallet?.runningBalance ?? 0,
        stockStatus: this.round(
          movements.reduce((total, movement) => {
            const sign =
              movement.movementType === 'consumption' ||
              movement.movementType === 'used'
                ? -1
                : 1;
            if (movement.movementType === 'snapshot') return total;
            return total + movement.quantity * sign;
          }, 0),
        ),
        totalRequests: 0,
        anomaliesDetected: warnings.length,
        pendingOrders: 0,
        ordersOverTime: this.groupLocalOrdersByDate(filteredOrders),
        costsByDate: this.groupLocalCostsByDate(filteredLines),
        ordersByStore: this.groupCountByLabel(
          filteredOrders.map((order) => order.storeName),
        ),
        costsByStore: this.groupLocalCostsByStore(filteredLines),
        costDistribution: [
          { label: 'Product', total: productCosts },
          { label: 'Shipping', total: shippingCosts },
          { label: 'Handling', total: handlingCosts },
          { label: 'Refunds', total: Math.abs(refunds) },
          {
            label: 'Other',
            total: Math.abs(
              this.round(
                filteredInvoices.reduce(
                  (total, invoice) => total + (invoice.otherCost ?? 0),
                  0,
                ),
              ),
            ),
          },
        ].filter((item) => item.total > 0),
        stockByProduct: this.groupCountByLabel(
          movements.map((movement) => movement.productName ?? 'Unknown product'),
        ),
        ordersByStatus: [],
        requestsOverview: [],
        anomaliesBySeverity: this.groupCountByLabel(
          warnings.map((warning) => warning.severity ?? 'warning'),
        ),
        recentActivity: filteredOrders.slice(0, 5).map((order) => ({
          id: `order-${order.externalOrderNumber}-${order.invoiceReference}`,
          type: 'Order',
          title: `Order ${order.externalOrderNumber}`,
          createdAt: order.orderDate ?? null,
        })),
        attentionRequired: warnings.slice(0, 5).map((warning) => ({
          label: warning.message,
          total: 1,
        })),
        filterOptions: {
          brands: brandNames.length > 0 ? brandNames : ['TanjAI'],
          stores,
          skus,
          invoices: invoiceRefs,
          orderNumbers,
          trackingNumbers,
          dates,
        },
      };
    } catch {
      return null;
    }
  }

  private async getErpDashboardSummary(
    filters: DashboardFilters,
  ): Promise<DashboardSummary> {
    try {
      const debugCounts = await this.getDashboardDebugCounts();
      const dashboardRowLimit = 25000;
      const dateFilter = this.dateFilter(filters.dateFrom, filters.dateTo);
      const brands = await this.prisma.brand.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      const stores = await this.prisma.store.findMany({
        select: { id: true, name: true, normalizedName: true, brandId: true },
        orderBy: { name: 'asc' },
      });
      const brandIds = filters.brand
        ? new Set(
            brands
              .filter((brand) => sameText(brand.name, filters.brand as string))
              .map((brand) => brand.id),
          )
        : null;
      const restrictStores = Boolean(filters.store || filters.brand);
      const allowedStores = stores.filter((store) => {
        if (
          filters.store &&
          !sameText(store.name, filters.store) &&
          store.normalizedName !== this.normalizeStoreName(filters.store)
        ) {
          return false;
        }
        if (brandIds && !brandIds.has(store.brandId)) {
          return false;
        }
        return true;
      });
      const allowedStoreIds = allowedStores.map((store) => store.id);
      const storeNameById = new Map(
        stores.map((store) => [store.id, store.name]),
      );

      const baseOrderWhere: Record<string, unknown> = {
        ...(restrictStores ? { storeId: { in: allowedStoreIds } } : {}),
        ...(dateFilter ? { orderDate: dateFilter } : {}),
        ...(filters.orderNumber
          ? {
              externalOrderNumber: {
                contains: filters.orderNumber,
                mode: 'insensitive' as const,
              },
            }
          : {}),
        ...(filters.invoice
          ? {
              invoiceReference: {
                contains: filters.invoice,
                mode: 'insensitive' as const,
              },
            }
          : {}),
      };

      const orderIdSets: string[][] = [];
      if (filters.sku) {
        const matchingLines = await this.prisma.orderLine.findMany({
          where: {
            sku: { contains: filters.sku, mode: 'insensitive' as const },
          },
          select: { orderId: true },
          take: 10000,
        });
        orderIdSets.push(matchingLines.map((line) => line.orderId));
      }
      if (filters.trackingNumber) {
        const matchingShipments = await this.prisma.shipment.findMany({
          where: {
            trackingNumber: {
              contains: filters.trackingNumber,
              mode: 'insensitive' as const,
            },
          },
          select: { orderId: true },
          take: 10000,
        });
        orderIdSets.push(matchingShipments.map((shipment) => shipment.orderId));
      }

      const filteredOrderIds = this.intersectIdSets(orderIdSets);
      const orderWhere: Record<string, unknown> = {
        ...baseOrderWhere,
        ...(filteredOrderIds ? { id: { in: filteredOrderIds } } : {}),
      };
      const invoiceWhere: Record<string, unknown> = {
        ...(restrictStores ? { storeId: { in: allowedStoreIds } } : {}),
        ...(dateFilter ? { invoiceDate: dateFilter } : {}),
        ...(filters.invoice
          ? {
              invoiceReference: {
                contains: filters.invoice,
                mode: 'insensitive' as const,
              },
            }
          : {}),
      };

      const orders = await this.prisma.order.findMany({
        where: orderWhere,
        select: {
          id: true,
          externalOrderNumber: true,
          orderDate: true,
          createdAt: true,
          storeId: true,
          status: true,
        },
        orderBy: { createdAt: 'desc' },
        take: dashboardRowLimit,
      });
      const invoices = await this.prisma.fulfillmentInvoice.findMany({
        where: invoiceWhere,
        select: {
          invoiceReference: true,
          invoiceDate: true,
          total: true,
          refunds: true,
          adjustments: true,
          otherCost: true,
          storeId: true,
        },
        take: dashboardRowLimit,
      });
      const anomalies = await this.prisma.anomaly.findMany({
        select: { id: true, severity: true, createdAt: true, message: true },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      });
      const aliases = await this.prisma.productSkuAlias.findMany({
        select: { sku: true },
        orderBy: { sku: 'asc' },
        take: 500,
      });

      const orderIds = orders.map((order) => order.id);
      const relatedOrderWhere =
        orderIds.length > 0 ? { orderId: { in: orderIds } } : { orderId: '__none__' };
      const movementWhere: Record<string, unknown> = {
        ...(restrictStores ? { storeId: { in: allowedStoreIds } } : {}),
        ...(dateFilter ? { movementDate: dateFilter } : {}),
      };
      const walletWhere: Record<string, unknown> = {
        ...(restrictStores ? { storeId: { in: allowedStoreIds } } : {}),
        ...(dateFilter ? { transactionDate: dateFilter } : {}),
      };

      const shipments = await this.prisma.shipment.findMany({
        where: relatedOrderWhere,
        select: { trackingNumber: true },
        take: dashboardRowLimit,
      });
      const lines = await this.prisma.orderLine.findMany({
        where: {
          ...relatedOrderWhere,
          ...(filters.sku
            ? { sku: { contains: filters.sku, mode: 'insensitive' as const } }
            : {}),
        },
        select: {
          sku: true,
          lineType: true,
          productCost: true,
          shippingCost: true,
          handlingCost: true,
          totalCost: true,
          orderId: true,
        },
        take: dashboardRowLimit,
      });
      const stockMovements = await this.prisma.inventoryMovement.findMany({
        where: movementWhere,
        select: {
          quantity: true,
          movementType: true,
          product: { select: { name: true } },
        },
        take: dashboardRowLimit,
      });
      const walletTransactions = await this.prisma.walletTransaction.findMany({
        where: walletWhere,
        orderBy: { createdAt: 'desc' },
        take: dashboardRowLimit,
        select: { runningBalance: true, amount: true },
      });
      const shipmentRecords = await this.prisma.shipment.findMany({
        where: relatedOrderWhere,
        select: { trackingNumber: true },
        orderBy: { trackingNumber: 'asc' },
        take: 500,
      });
      debugCounts.orders = Math.max(debugCounts.orders, orders.length);
      debugCounts.invoices = Math.max(debugCounts.invoices, invoices.length);
      debugCounts.inventoryMovements = Math.max(
        debugCounts.inventoryMovements,
        stockMovements.length,
      );
      debugCounts.walletTransactions = Math.max(
        debugCounts.walletTransactions,
        walletTransactions.length,
      );

      const orderById = new Map<string, (typeof orders)[number]>(
        orders.map((order) => [order.id, order]),
      );
      const linesWithOrder = lines.map((line) => {
        const order = orderById.get(line.orderId);
        return {
          ...line,
          order: {
            orderDate: order?.orderDate ?? null,
            store: { name: storeNameById.get(order?.storeId ?? '') ?? 'Unknown store' },
          },
        };
      });
      const productLines = lines.filter(
        (line) => (line.lineType ?? 'product') === 'product',
      );
      const uniqueTrackingNumbers = new Set(
        shipments.map((shipment) => shipment.trackingNumber).filter(Boolean),
      );
      const productCosts = this.round(
        productLines.reduce((total, line) => total + line.productCost, 0),
      );
      const shippingCosts = this.round(
        productLines.reduce((total, line) => total + line.shippingCost, 0),
      );
      const handlingCosts = this.round(
        productLines.reduce((total, line) => total + line.handlingCost, 0),
      );
      const totalCosts = this.round(
        invoices.reduce((total, invoice) => total + invoice.total, 0),
      );
      const refunds = this.round(
        invoices.reduce((total, invoice) => total + invoice.refunds, 0),
      );
      const latestRunningBalance = walletTransactions.find(
        (transaction) => typeof transaction.runningBalance === 'number',
      )?.runningBalance;
      const currentBalance =
        typeof latestRunningBalance === 'number'
          ? latestRunningBalance
          : this.round(
              walletTransactions.reduce(
                (total, transaction) => total + transaction.amount,
                0,
              ),
            );
      const stockStatus = this.round(
        stockMovements.reduce((total, movement) => {
          const sign =
            movement.movementType === 'consumption' ||
            movement.movementType === 'used'
              ? -1
              : 1;
          if (movement.movementType === 'snapshot') return total;
          return total + movement.quantity * sign;
        }, 0),
      );

      return {
        totalOrders: orders.length,
        totalShipments: uniqueTrackingNumbers.size,
        totalInvoices: invoices.length,
        totalCosts,
        productCosts,
        shippingCosts,
        handlingCosts,
        refunds,
        currentBalance,
        stockStatus,
        totalRequests: 0,
        anomaliesDetected: anomalies.length,
        pendingOrders: orders.filter((order) => order.status === 'PENDING_TRACKING').length,
        ordersOverTime: this.groupRecordsByDate(
          orders.map((order) => ({ date: order.orderDate })),
        ),
        costsByDate: this.groupCostByDate(linesWithOrder),
        ordersByStore: this.groupCountByLabel(
          orders.map((order) => storeNameById.get(order.storeId) ?? 'Unknown store'),
        ),
        costsByStore: this.groupCostByStore(linesWithOrder),
        costDistribution: [
          { label: 'Product', total: productCosts },
          { label: 'Shipping', total: shippingCosts },
          { label: 'Handling', total: handlingCosts },
          { label: 'Refunds', total: Math.abs(refunds) },
          {
            label: 'Other',
            total: Math.abs(
              this.round(
                invoices.reduce(
                  (total, invoice) => total + (invoice.otherCost ?? 0),
                  0,
                ),
              ),
            ),
          },
        ].filter((item) => item.total > 0),
        stockByProduct: this.groupStockByProduct(stockMovements),
        ordersByStatus: [],
        requestsOverview: [],
        anomaliesBySeverity: this.groupBySeverity(anomalies),
        recentActivity: [
          ...orders.slice(0, 5).map((order) => ({
            id: `order-${order.id}`,
            type: 'Order',
            title: `Order ${order.externalOrderNumber}`,
            createdAt: order.createdAt.toISOString(),
          })),
          ...anomalies.slice(0, 5).map((anomaly) => ({
            id: `anomaly-${anomaly.id}`,
            type: 'Anomaly',
            title: anomaly.message,
            createdAt: anomaly.createdAt.toISOString(),
          })),
        ]
          .sort((first, second) => {
            return (
              new Date(second.createdAt ?? 0).getTime() -
              new Date(first.createdAt ?? 0).getTime()
            );
          })
          .slice(0, 5),
        attentionRequired: anomalies.slice(0, 5).map((anomaly) => ({
          label: anomaly.message,
          total: 1,
        })),
        filterOptions: {
          brands: brands.map((brand) => brand.name),
          stores: stores.map((store) => store.name),
          skus: aliases.map((alias) => alias.sku),
          invoices: this.uniqueOptions(
            invoices.map((invoice) => invoice.invoiceReference),
          ),
          orderNumbers: this.uniqueOptions(
            orders.map((order) => order.externalOrderNumber),
          ),
          trackingNumbers: this.uniqueOptions(
            shipmentRecords.map((shipment) => shipment.trackingNumber),
          ),
          dates: [
            ...new Set(
              [
                ...orders.map((order) => order.orderDate),
                ...invoices.map((invoice) => invoice.invoiceDate),
              ]
                .map((value) => this.toDateOption(value))
                .filter((value): value is string => Boolean(value)),
            ),
          ].sort(),
        },
        debugCounts,
      };
    } catch (error) {
      console.error('Dashboard ERP summary failed', error);
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        `Dashboard summary failed: ${message}`,
      );
    }
  }

  private async getDashboardDebugCounts(): Promise<DashboardDebugCounts> {
    const orders = await this.safeCount(this.prisma.order);
    const shipments = await this.safeCount(this.prisma.shipment);
    const invoices = await this.safeCount(this.prisma.fulfillmentInvoice);
    const stockPurchases = await this.safeCount(this.prisma.stockPurchase);
    const inventoryMovements = await this.safeCount(this.prisma.inventoryMovement);
    const walletTransactions = await this.safeCount(this.prisma.walletTransaction);
    const products = await this.safeCount(this.prisma.product);
    const importBatches = await this.safeCount(this.prisma.importBatch);

    const debugCounts = {
      orders,
      shipments,
      invoices,
      stockPurchases,
      inventoryMovements,
      walletTransactions,
      products,
      importBatches,
      databaseHost: this.databaseHost(),
      storage: process.env.EXCEL_IMPORT_STORAGE ?? '',
    };

    return debugCounts;
  }

  private async safeCount(delegate: { count: () => Promise<number> }) {
    try {
      return await delegate.count();
    } catch {
      return 0;
    }
  }

  private databaseHost() {
    try {
      return process.env.DATABASE_URL
        ? new URL(process.env.DATABASE_URL).host
        : '';
    } catch {
      return '';
    }
  }

  private intersectIdSets(idSets: string[][]) {
    if (idSets.length === 0) return null;
    return [
      ...idSets
        .slice(1)
        .reduce(
          (intersection, ids) => {
            const current = new Set(ids);
            return new Set([...intersection].filter((id) => current.has(id)));
          },
          new Set(idSets[0]),
        ),
    ];
  }

  private async getProductsSection(): Promise<DashboardSection> {
    try {
      return await this.loadProductsSection(true);
    } catch (error) {
      if (this.isMissingProductQuotationColumn(error)) {
        return this.loadProductsSection(false);
      }
      throw error;
    }
  }

  private async loadProductsSection(includeQuotation: boolean): Promise<DashboardSection> {
    const select: Record<string, unknown> = {
      id: true,
      name: true,
      description: true,
      weight: true,
      imageUrl: true,
      skuAliases: {
        select: { sku: true, store: { select: { name: true } } },
        orderBy: { sku: 'asc' },
      },
      inventoryMovements: {
        select: { quantity: true, movementType: true },
        take: 1000,
      },
      _count: {
        select: {
          orderLines: true,
          stockPurchases: true,
          inventoryMovements: true,
        },
      },
    };

    if (includeQuotation) {
      select.quotation = true;
    }

    const products = await this.prisma.product.findMany({
      orderBy: { name: 'asc' },
      take: 5000,
      select,
    });
    const catalogProducts = products.filter((product) =>
      this.isCatalogProduct(product, includeQuotation),
    );

    return {
      title: 'Products',
      columns: [
        { key: 'name', label: 'Product' },
        { key: 'skus', label: 'SKUs' },
        { key: 'weight', label: 'Weight' },
        { key: 'orderLines', label: 'Order lines' },
        { key: 'stockPurchases', label: 'Stock purchases' },
      ],
      rows: catalogProducts.map((product) => ({
        id: product.id,
        name: product.name,
        description: product.description ?? '',
        imageUrl: product.imageUrl ?? null,
        skuAliases: product.skuAliases.map((alias) => alias.sku),
        quotation:
          includeQuotation && 'quotation' in product
            ? this.normalizeQuotationForResponse(product.quotation) ?? null
            : null,
        stores: [
          ...new Set(
            product.skuAliases
              .map((alias) => alias.store?.name)
              .filter((store): store is string => Boolean(store)),
          ),
        ],
        skus: product.skuAliases.map((alias) => alias.sku).join(', ') || '-',
        weight: product.weight ?? null,
        orderLines: product._count.orderLines,
        stockPurchases: product._count.stockPurchases,
        inventoryMovements: product._count.inventoryMovements,
        currentInventory: this.round(
          product.inventoryMovements.reduce((total, movement) => {
            if (movement.movementType === 'snapshot') return total;
            const sign =
              movement.movementType === 'consumption' ||
              movement.movementType === 'used'
                ? -1
                : 1;
            return total + movement.quantity * sign;
          }, 0),
        ),
      })),
    };
  }

  private normalizeQuotationForResponse(quotation: unknown) {
    if (!quotation || typeof quotation !== 'object' || Array.isArray(quotation)) {
      return quotation;
    }

    const record = quotation as Record<string, unknown>;
    if (!Array.isArray(record.quotationRows)) {
      return quotation;
    }

    let changed = false;
    const quotationRows = record.quotationRows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        return row;
      }

      const rowRecord = row as Record<string, unknown>;
      const existingQuantityLabel = rowRecord.quantityLabel;
      if (
        existingQuantityLabel !== null &&
        existingQuantityLabel !== undefined &&
        String(existingQuantityLabel).trim()
      ) {
        return row;
      }

      const quantity = rowRecord.quantity;
      if (quantity === null || quantity === undefined) {
        return row;
      }

      const quantityLabel = String(quantity).trim();
      if (!quantityLabel) {
        return row;
      }

      changed = true;
      return { ...rowRecord, quantityLabel };
    });

    return changed ? { ...record, quotationRows } : quotation;
  }

  private isCatalogProduct(product: any, includeQuotation: boolean) {
    const aliases = Array.isArray(product.skuAliases)
      ? product.skuAliases.map((alias: { sku?: string }) => alias.sku ?? '')
      : [];
    if (
      !this.isValidCatalogProductName(product.name) ||
      this.isSkuOnlyProductName(product.name, aliases)
    ) {
      return false;
    }

    if (includeQuotation && this.hasCatalogData(product.quotation)) {
      return true;
    }
    if (this.cleanCatalogText(product.description)) {
      return true;
    }
    if (this.cleanCatalogText(product.imageUrl)) {
      return true;
    }
    if (typeof product.weight === 'number' && Number.isFinite(product.weight)) {
      return true;
    }

    return aliases.length > 0;
  }

  private hasCatalogData(value: unknown): boolean {
    if (value === null || value === undefined || value === '') return false;
    if (typeof value === 'string') return this.cleanCatalogText(value).length > 0;
    if (typeof value === 'number' || typeof value === 'boolean') return true;
    if (Array.isArray(value)) return value.some((item) => this.hasCatalogData(item));
    if (typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).some((item) =>
        this.hasCatalogData(item),
      );
    }
    return false;
  }

  private isSkuOnlyProductName(name: string, aliases: string[]) {
    const normalizedName = this.cleanCatalogText(name).toLowerCase();
    if (!normalizedName) return true;
    if (aliases.some((alias) => this.cleanCatalogText(alias).toLowerCase() === normalizedName)) {
      return true;
    }
    if (/^\d+([_\-\s]\d+)*$/.test(normalizedName)) {
      return true;
    }
    if (/^[a-z0-9_-]+$/.test(normalizedName) && /\d/.test(normalizedName)) {
      return true;
    }
    return false;
  }

  private isValidCatalogProductName(name: string) {
    const normalizedName = this.cleanCatalogText(name).toLowerCase();
    if (!normalizedName || normalizedName === '/' || normalizedName === 'no.') {
      return false;
    }

    const knownCategoryLabels = new Set([
      'hydromax',
      'pant+pands',
      'pants',
    ]);
    if (knownCategoryLabels.has(normalizedName)) {
      return false;
    }

    if (
      normalizedName.includes('stock at warehouse') ||
      normalizedName.includes('factory have prepare stock') ||
      normalizedName.includes('will removed') ||
      normalizedName.includes('will be removed') ||
      normalizedName.includes('per pcs') ||
      normalizedName.includes('per order') ||
      normalizedName.includes('ship only')
    ) {
      return false;
    }

    return true;
  }

  private cleanCatalogText(value: unknown) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\s+/g, ' ').trim();
  }

  private isMissingProductQuotationColumn(error: unknown) {
    const message =
      error instanceof Error
        ? `${error.message} ${JSON.stringify((error as { code?: string; meta?: unknown }).meta ?? {})}`
        : String(error);

    return (
      message.includes('quotation') &&
      (message.includes('does not exist') ||
        message.includes('column') ||
        message.includes('P2022'))
    );
  }

  private async getOrdersSection(): Promise<DashboardSection> {
    const orders = await this.prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        externalOrderNumber: true,
        orderDate: true,
        invoiceReference: true,
        status: true,
        store: { select: { name: true } },
        _count: { select: { lines: true, shipments: true } },
      },
    });

    return {
      title: 'Orders',
      columns: [
        { key: 'orderNumber', label: 'Order number' },
        { key: 'store', label: 'Store' },
        { key: 'invoice', label: 'Invoice' },
        { key: 'status', label: 'Status' },
        { key: 'date', label: 'Date' },
        { key: 'lines', label: 'Lines' },
        { key: 'shipments', label: 'Shipments' },
      ],
      rows: orders.map((order) => ({
        orderNumber: order.externalOrderNumber,
        store: order.store.name,
        invoice: order.invoiceReference,
        status: this.formatLabel(order.status),
        date: this.formatDateValue(order.orderDate),
        lines: order._count.lines,
        shipments: order._count.shipments,
      })),
    };
  }

  private async getInventorySection(): Promise<DashboardSection> {
    const movements = await this.prisma.inventoryMovement.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        movementDate: true,
        movementType: true,
        quantity: true,
        reference: true,
        product: { select: { name: true } },
        store: { select: { name: true } },
      },
    });

    return {
      title: 'Inventory',
      columns: [
        { key: 'date', label: 'Date' },
        { key: 'product', label: 'Product' },
        { key: 'store', label: 'Store' },
        { key: 'type', label: 'Type' },
        { key: 'quantity', label: 'Quantity' },
        { key: 'reference', label: 'Reference' },
      ],
      rows: movements.map((movement) => ({
        date: this.formatDateValue(movement.movementDate),
        product: movement.product?.name ?? '-',
        store: movement.store?.name ?? '-',
        type: this.formatLabel(movement.movementType),
        quantity: movement.quantity,
        reference: movement.reference ?? '-',
      })),
    };
  }

  private async getStoresSection(): Promise<DashboardSection> {
    const stores = await this.prisma.store.findMany({
      orderBy: { name: 'asc' },
      take: 500,
      select: {
        name: true,
        country: true,
        platform: true,
        brand: { select: { name: true } },
        _count: {
          select: {
            orders: true,
            fulfillmentInvoices: true,
            walletTransactions: true,
            inventoryMovements: true,
          },
        },
      },
    });

    return {
      title: 'Stores',
      columns: [
        { key: 'name', label: 'Store' },
        { key: 'brand', label: 'Brand' },
        { key: 'country', label: 'Country' },
        { key: 'platform', label: 'Platform' },
        { key: 'orders', label: 'Orders' },
        { key: 'invoices', label: 'Invoices' },
      ],
      rows: stores.map((store) => ({
        name: store.name,
        brand: store.brand.name,
        country: store.country ?? '-',
        platform: store.platform ?? '-',
        orders: store._count.orders,
        invoices: store._count.fulfillmentInvoices,
      })),
    };
  }

  private async getInvoicesSection(): Promise<DashboardSection> {
    const invoices = await this.prisma.fulfillmentInvoice.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        invoiceReference: true,
        invoiceDate: true,
        subtotal: true,
        refunds: true,
        adjustments: true,
        otherCost: true,
        total: true,
        store: { select: { name: true } },
      },
    });

    return {
      title: 'Invoices',
      columns: [
        { key: 'invoice', label: 'Invoice' },
        { key: 'store', label: 'Store' },
        { key: 'date', label: 'Date' },
        { key: 'subtotal', label: 'Subtotal' },
        { key: 'refunds', label: 'Refunds' },
        { key: 'otherCost', label: 'Other' },
        { key: 'total', label: 'Total' },
      ],
      rows: invoices.map((invoice) => ({
        invoice: invoice.invoiceReference,
        store: invoice.store.name,
        date: this.formatDateValue(invoice.invoiceDate),
        subtotal: this.round(invoice.subtotal),
        refunds: this.round(invoice.refunds),
        otherCost: this.round(invoice.otherCost),
        total: this.round(invoice.total),
      })),
    };
  }

  private async getPaymentsSection(): Promise<DashboardSection> {
    const stores = await this.prisma.store.findMany({
      select: { id: true, name: true },
    });
    const storeNameById = new Map(stores.map((store) => [store.id, store.name]));
    const payments = await this.prisma.walletTransaction.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        transactionDate: true,
        transactionType: true,
        invoiceReference: true,
        amount: true,
        runningBalance: true,
        storeId: true,
      },
    });

    return {
      title: 'Payments',
      columns: [
        { key: 'date', label: 'Date' },
        { key: 'store', label: 'Store' },
        { key: 'type', label: 'Type' },
        { key: 'invoice', label: 'Invoice' },
        { key: 'amount', label: 'Amount' },
        { key: 'balance', label: 'Balance' },
      ],
      rows: payments.map((payment) => ({
        date: this.formatDateValue(payment.transactionDate),
        store: payment.storeId ? storeNameById.get(payment.storeId) ?? '-' : '-',
        type: this.formatLabel(payment.transactionType),
        invoice: payment.invoiceReference ?? '-',
        amount: this.round(payment.amount),
        balance:
          typeof payment.runningBalance === 'number'
            ? this.round(payment.runningBalance)
            : '-',
      })),
    };
  }

  private groupBySeverity(rows: Array<{ severity?: string | null }>): ChartPoint[] {
    const groups = rows.reduce<Record<string, number>>((totals, row) => {
      const label = this.formatLabel(row.severity || 'unknown');
      totals[label] = (totals[label] ?? 0) + 1;

      return totals;
    }, {});

    return Object.entries(groups).map(([label, total]) => ({ label, total }));
  }

  private formatLabel(value: string): string {
    return value
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  private dateFilter(dateFrom?: string, dateTo?: string) {
    const filter: { gte?: Date; lte?: Date } = {};
    if (dateFrom) filter.gte = new Date(dateFrom);
    if (dateTo) filter.lte = new Date(dateTo);
    return Object.keys(filter).length ? filter : null;
  }

  private normalizeDashboardFilters(filters: DashboardFilters) {
    return Object.fromEntries(
      Object.entries(filters).map(([key, value]) => {
        const normalizedValue = typeof value === 'string' ? value.trim() : value;
        return [
          key,
          this.isAllFilterValue(key, normalizedValue) ? '' : normalizedValue,
        ];
      }),
    ) as DashboardFilters;
  }

  private isAllFilterValue(key: string, value: unknown) {
    if (typeof value !== 'string') return false;
    const normalizedValue = value.trim().toLowerCase();
    return (
      normalizedValue === 'all' ||
      normalizedValue === `all ${key.toLowerCase()}s` ||
      (key === 'brand' && normalizedValue === 'all brands') ||
      (key === 'store' && normalizedValue === 'all stores')
    );
  }

  private normalizeStoreName(value: string) {
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private toDateOption(value: string | Date | null | undefined) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }

  private formatDateValue(value: string | Date | null | undefined) {
    return this.toDateOption(value) ?? '-';
  }

  private groupRecordsByDate(records: Array<{ date: Date | null }>) {
    const grouped = records.reduce<Record<string, number>>((totals, record) => {
      if (!record.date) return totals;
      const label = record.date.toISOString().slice(0, 10);
      totals[label] = (totals[label] ?? 0) + 1;
      return totals;
    }, {});

    return Object.entries(grouped)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, total]) => ({ label, total }))
      .slice(-30);
  }

  private groupCostByDate(
    lines: Array<{ totalCost: number; order: { orderDate: Date | null } }>,
  ) {
    const grouped = lines.reduce<Record<string, number>>((totals, line) => {
      if (!line.order.orderDate) return totals;
      const label = line.order.orderDate.toISOString().slice(0, 10);
      totals[label] = (totals[label] ?? 0) + line.totalCost;
      return totals;
    }, {});

    return Object.entries(grouped)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, total]) => ({ label, total: this.round(total) }))
      .slice(-30);
  }

  private groupCostByStore(
    lines: Array<{ totalCost: number; order: { store: { name: string } } }>,
  ) {
    const grouped = lines.reduce<Record<string, number>>((totals, line) => {
      const label = line.order.store.name;
      totals[label] = (totals[label] ?? 0) + line.totalCost;
      return totals;
    }, {});

    return Object.entries(grouped)
      .map(([label, total]) => ({ label, total: this.round(total) }))
      .sort((first, second) => second.total - first.total)
      .slice(0, 12);
  }

  private groupCountByLabel(labels: string[]) {
    const grouped = labels.reduce<Record<string, number>>((totals, label) => {
      totals[label] = (totals[label] ?? 0) + 1;
      return totals;
    }, {});

    return Object.entries(grouped)
      .map(([label, total]) => ({ label, total }))
      .sort((first, second) => second.total - first.total)
      .slice(0, 12);
  }

  private uniqueOptions(values: Array<string | number | null | undefined>) {
    return [
      ...new Set(
        values
          .filter((value): value is string | number => value !== null && value !== undefined)
          .map(String)
          .filter(Boolean),
      ),
    ]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 500);
  }

  private groupStockByProduct(
    movements: Array<{
      quantity: number;
      movementType: string;
      product: { name: string } | null;
    }>,
  ) {
    const grouped = movements.reduce<Record<string, number>>((totals, item) => {
      const label = item.product?.name ?? 'Unknown product';
      const sign =
        item.movementType === 'consumption' || item.movementType === 'used'
          ? -1
          : 1;
      if (item.movementType === 'snapshot') return totals;
      totals[label] = (totals[label] ?? 0) + item.quantity * sign;
      return totals;
    }, {});

    return Object.entries(grouped)
      .map(([label, total]) => ({ label, total: this.round(total) }))
      .sort((first, second) => second.total - first.total)
      .slice(0, 12);
  }

  private round(value: number) {
    return Number(value.toFixed(2));
  }

  private isInDateRange(value: string | Date | null | undefined, filters: DashboardFilters) {
    if (!value || (!filters.dateFrom && !filters.dateTo)) return true;
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return true;
    if (filters.dateFrom && time < new Date(filters.dateFrom).getTime()) return false;
    if (filters.dateTo && time > new Date(filters.dateTo).getTime()) return false;
    return true;
  }

  private groupLocalOrdersByDate(orders: Array<{ orderDate?: string | Date | null }>) {
    return this.groupRecordsByDate(
      orders.map((order) => ({
        date: order.orderDate ? new Date(order.orderDate) : null,
      })),
    );
  }

  private groupLocalCostsByDate(
    lines: Array<{ totalCost: number; order: { orderDate?: string | Date | null } }>,
  ) {
    const grouped = lines.reduce<Record<string, number>>((totals, line) => {
      if (!line.order.orderDate) return totals;
      const label = new Date(line.order.orderDate).toISOString().slice(0, 10);
      totals[label] = (totals[label] ?? 0) + line.totalCost;
      return totals;
    }, {});

    return Object.entries(grouped)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, total]) => ({ label, total: this.round(total) }))
      .slice(-30);
  }

  private groupLocalCostsByStore(
    lines: Array<{ totalCost: number; order: { storeName: string } }>,
  ) {
    const grouped = lines.reduce<Record<string, number>>((totals, line) => {
      const label = line.order.storeName;
      totals[label] = (totals[label] ?? 0) + line.totalCost;
      return totals;
    }, {});

    return Object.entries(grouped)
      .map(([label, total]) => ({ label, total: this.round(total) }))
      .sort((first, second) => second.total - first.total)
      .slice(0, 12);
  }
}

function sameText(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function isBrandOwnerName(name: string | undefined) {
  return (name ?? '').trim().toLowerCase() === 'marcus';
}
