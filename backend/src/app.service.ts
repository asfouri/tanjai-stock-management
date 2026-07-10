import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ChartPoint,
  DashboardDebugCounts,
  DashboardFilters,
  DashboardSection,
  DashboardSummary,
} from './app.types';
import { PrismaService } from './prisma.service';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async getDashboardSection(
    section: string,
    filters: DashboardFilters = {},
  ): Promise<DashboardSection> {
    const normalizedFilters = this.normalizeDashboardFilters(filters);

    switch (section) {
      case 'products':
        return this.getProductsSection();
      case 'orders':
        return this.getOrdersSection(normalizedFilters);
      case 'product-matching':
        return this.getProductMatchingSection();
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
    return this.getErpDashboardSummary(normalizedFilters);
  }

  private async getErpDashboardSummary(
    filters: DashboardFilters,
  ): Promise<DashboardSummary> {
    try {
      const debugCounts = await this.getDashboardDebugCounts();
      const dashboardRowLimit = 25000;
      const dateFilter = this.dateFilter(filters.dateFrom, filters.dateTo);
      const [brands, stores] = await Promise.all([
        this.prisma.brand.findMany({
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.store.findMany({
          select: { id: true, name: true, normalizedName: true, brandId: true },
          orderBy: { name: 'asc' },
        }),
      ]);
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
        ...(filters.country
          ? {
              country: {
                contains: filters.country,
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
      if (filters.orderSearch) {
        orderIdSets.push(await this.findOrderIdsForSearch(filters.orderSearch));
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

      const movementWhereEarly: Record<string, unknown> = {
        ...(restrictStores ? { storeId: { in: allowedStoreIds } } : {}),
        ...(dateFilter ? { movementDate: dateFilter } : {}),
      };
      const walletWhereEarly: Record<string, unknown> = {
        ...(restrictStores ? { storeId: { in: allowedStoreIds } } : {}),
        ...(dateFilter ? { transactionDate: dateFilter } : {}),
      };

      const [
        totalOrders,
        totalInvoices,
        pendingOrders,
        orders,
        invoices,
        anomalies,
        aliases,
        stockMovements,
        walletTransactionCount,
        shipmentRecords,
        totalShipments,
        costAgg,
        invoiceAgg,
        latestWithBalance,
      ] = await Promise.all([
        this.prisma.order.count({ where: orderWhere }),
        this.prisma.fulfillmentInvoice.count({ where: invoiceWhere }),
        this.prisma.order.count({
          where: { ...orderWhere, status: 'PENDING_TRACKING' },
        }),
        this.prisma.order.findMany({
          where: orderWhere,
          select: {
            id: true,
            externalOrderNumber: true,
            orderDate: true,
            country: true,
            createdAt: true,
            storeId: true,
            status: true,
          },
          orderBy: { createdAt: 'desc' },
          take: dashboardRowLimit,
        }),
        this.prisma.fulfillmentInvoice.findMany({
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
        }),
        this.prisma.anomaly.findMany({
          select: { id: true, severity: true, createdAt: true, message: true },
          orderBy: { createdAt: 'desc' },
          take: 1000,
        }),
        this.prisma.productSkuAlias.findMany({
          select: { sku: true },
          orderBy: { sku: 'asc' },
          take: 500,
        }),
        this.prisma.inventoryMovement.findMany({
          where: movementWhereEarly,
          select: {
            quantity: true,
            movementType: true,
            product: { select: { name: true } },
          },
          take: dashboardRowLimit,
        }),
        this.prisma.walletTransaction.count({ where: walletWhereEarly }),
        this.prisma.shipment.findMany({
          where: { order: orderWhere },
          select: { trackingNumber: true },
          orderBy: { trackingNumber: 'asc' },
          take: 500,
        }),
        this.prisma.shipment.count({ where: { order: orderWhere } }),
        this.prisma.orderLine.aggregate({
          where: {
            order: orderWhere,
            lineType: 'product',
            ...(filters.sku
              ? {
                  sku: { contains: filters.sku, mode: 'insensitive' as const },
                }
              : {}),
          },
          _sum: { productCost: true, shippingCost: true, handlingCost: true },
        }),
        this.prisma.fulfillmentInvoice.aggregate({
          where: invoiceWhere,
          _sum: { total: true, refunds: true, otherCost: true },
        }),
        this.prisma.walletTransaction.findFirst({
          where: {
            ...walletWhereEarly,
            runningBalance: { not: null },
          },
          orderBy: { transactionDate: 'desc' },
          select: { runningBalance: true },
        }),
      ]);

      const orderIds = orders.map((order) => order.id);
      const relatedOrderWhere =
        orderIds.length > 0
          ? { orderId: { in: orderIds } }
          : { orderId: '__none__' };
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
      const currentBalance =
        latestWithBalance?.runningBalance ??
        (await this.prisma.walletTransaction
          .aggregate({
            where: walletWhereEarly,
            _sum: { amount: true },
          })
          .then((result) => this.round(result._sum.amount ?? 0)));

      debugCounts.orders = Math.max(debugCounts.orders, totalOrders);
      debugCounts.invoices = Math.max(debugCounts.invoices, totalInvoices);
      debugCounts.inventoryMovements = Math.max(
        debugCounts.inventoryMovements,
        stockMovements.length,
      );
      debugCounts.walletTransactions = Math.max(
        debugCounts.walletTransactions,
        walletTransactionCount,
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
            store: {
              name: storeNameById.get(order?.storeId ?? '') ?? 'Unknown store',
            },
          },
        };
      });
      const productCosts = this.round(costAgg._sum.productCost ?? 0);
      const shippingCosts = this.round(costAgg._sum.shippingCost ?? 0);
      const handlingCosts = this.round(costAgg._sum.handlingCost ?? 0);
      const totalCosts = this.round(invoiceAgg._sum.total ?? 0);
      const refunds = this.round(invoiceAgg._sum.refunds ?? 0);
      const otherCosts = this.round(invoiceAgg._sum.otherCost ?? 0);
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
        totalOrders,
        totalShipments,
        totalInvoices,
        totalCosts,
        productCosts,
        shippingCosts,
        handlingCosts,
        refunds,
        currentBalance,
        stockStatus,
        totalRequests: 0,
        anomaliesDetected: anomalies.length,
        pendingOrders,
        ordersOverTime: this.groupRecordsByDate(
          orders.map((order) => ({ date: order.orderDate })),
        ),
        costsByDate: this.groupCostByDate(linesWithOrder),
        ordersByStore: this.groupCountByLabel(
          orders.map(
            (order) => storeNameById.get(order.storeId) ?? 'Unknown store',
          ),
        ),
        costsByStore: this.groupCostByStore(linesWithOrder),
        costDistribution: [
          { label: 'Product', total: productCosts },
          { label: 'Shipping', total: shippingCosts },
          { label: 'Handling', total: handlingCosts },
          { label: 'Refunds', total: Math.abs(refunds) },
          {
            label: 'Other',
            total: Math.abs(otherCosts),
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
          countries: this.uniqueOptions(orders.map((order) => order.country)),
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
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        `Dashboard summary failed: ${message}`,
      );
    }
  }

  private async getDashboardDebugCounts(): Promise<DashboardDebugCounts> {
    const [
      orders,
      shipments,
      invoices,
      stockPurchases,
      inventoryMovements,
      walletTransactions,
      products,
      importBatches,
    ] = await Promise.all([
      this.safeCount(this.prisma.order),
      this.safeCount(this.prisma.shipment),
      this.safeCount(this.prisma.fulfillmentInvoice),
      this.safeCount(this.prisma.stockPurchase),
      this.safeCount(this.prisma.inventoryMovement),
      this.safeCount(this.prisma.walletTransaction),
      this.safeCount(this.prisma.product),
      this.safeCount(this.prisma.importBatch),
    ]);

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
      ...idSets.slice(1).reduce((intersection, ids) => {
        const current = new Set(ids);
        return new Set([...intersection].filter((id) => current.has(id)));
      }, new Set(idSets[0])),
    ];
  }

  private async findOrderIdsForSearch(search: string) {
    const terms = this.orderSearchTerms(search);
    if (terms.length === 0) return [];
    const containsAnyTerm = terms.map((value) => ({
      contains: value,
      mode: 'insensitive' as const,
    }));

    const [orders, products, shipments] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          OR: containsAnyTerm.map((filter) => ({
            externalOrderNumber: filter,
          })),
        },
        select: { id: true },
        take: 10000,
      }),
      this.prisma.product.findMany({
        where: {
          OR: [
            ...containsAnyTerm.map((filter) => ({ name: filter })),
            ...containsAnyTerm.map((filter) => ({ description: filter })),
          ],
        },
        select: { id: true },
        take: 1000,
      }),
      this.prisma.shipment.findMany({
        where: {
          OR: containsAnyTerm.map((filter) => ({
            trackingNumber: filter,
          })),
        },
        select: { orderId: true },
        take: 10000,
      }),
    ]);
    const productIds = products.map((product) => product.id);
    const lineSearch: Record<string, unknown>[] = containsAnyTerm.map(
      (filter) => ({ sku: filter }),
    );

    if (productIds.length > 0) {
      lineSearch.push({ productId: { in: productIds } });
    }

    const lines = await this.prisma.orderLine.findMany({
      where: { OR: lineSearch },
      select: { orderId: true },
      take: 10000,
    });

    return [
      ...new Set([
        ...orders.map((order) => order.id),
        ...lines.map((line) => line.orderId),
        ...shipments.map((shipment) => shipment.orderId),
      ]),
    ];
  }

  private orderSearchTerms(search: string) {
    const value = search.trim();
    if (!value) return [];

    return [
      ...new Set(
        [
          value,
          ...value.split(/[\s,;|]+/),
        ]
          .map((term) => term.trim())
          .filter((term) => term.length >= 2)
          .slice(0, 50),
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

  private async loadProductsSection(
    includeQuotation: boolean,
  ): Promise<DashboardSection> {
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
        select: {
          movementDate: true,
          movementType: true,
          quantity: true,
          reference: true,
          comment: true,
        },
        orderBy: [
          { movementDate: { sort: 'desc' as const, nulls: 'last' as const } },
          { sourceRow: 'desc' as const },
        ],
        take: 300,
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

    const [products, movementTotals] = await Promise.all([
      this.prisma.product.findMany({
        orderBy: { name: 'asc' },
        take: 5000,
        select,
      }),
      this.prisma.inventoryMovement.groupBy({
        by: ['productId', 'movementType'],
        _sum: { quantity: true },
        where: { productId: { not: null } },
      }),
    ]);
    const inventoryByProduct = new Map<string, number>();
    for (const total of movementTotals) {
      if (!total.productId || total.movementType === 'snapshot') continue;
      const sign =
        total.movementType === 'consumption' || total.movementType === 'used'
          ? -1
          : 1;
      inventoryByProduct.set(
        total.productId,
        (inventoryByProduct.get(total.productId) ?? 0) +
          (total._sum.quantity ?? 0) * sign,
      );
    }
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
      rows: catalogProducts.map((product) =>
        this.productResponseRow(
          product,
          includeQuotation,
          inventoryByProduct.get((product as { id: string }).id) ?? 0,
        ),
      ),
    };
  }

  private productResponseRow(
    product: any,
    includeQuotation: boolean,
    currentInventory = 0,
  ) {
    return {
      id: product.id,
      name: product.name,
      description: product.description ?? '',
      imageUrl: product.imageUrl ?? null,
      skuAliases: product.skuAliases.map((alias: any) => alias.sku),
      quotation:
        includeQuotation && 'quotation' in product
          ? (this.normalizeQuotationForResponse(product.quotation) ?? null)
          : null,
      stores: [
        ...new Set(
          product.skuAliases
            .map((alias: any) => alias.store?.name)
            .filter((store: unknown): store is string => Boolean(store)),
        ),
      ],
      skus: product.skuAliases.map((alias: any) => alias.sku).join(', ') || '-',
      weight: product.weight ?? null,
      orderLines: product._count.orderLines,
      stockPurchases: product._count.stockPurchases,
      inventoryMovements: product._count.inventoryMovements,
      currentInventory: this.round(currentInventory),
      movements: (product.inventoryMovements ?? []).map((movement: any) => ({
        date: this.formatDateValue(movement.movementDate),
        type: this.formatLabel(movement.movementType),
        movementType: movement.movementType,
        quantity: movement.quantity,
        reference: movement.reference ?? '-',
        comment: movement.comment ?? '',
      })),
    };
  }

  private normalizeQuotationForResponse(quotation: unknown) {
    if (
      !quotation ||
      typeof quotation !== 'object' ||
      Array.isArray(quotation)
    ) {
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
    if (typeof value === 'string')
      return this.cleanCatalogText(value).length > 0;
    if (typeof value === 'number' || typeof value === 'boolean') return true;
    if (Array.isArray(value))
      return value.some((item) => this.hasCatalogData(item));
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
    if (
      aliases.some(
        (alias) =>
          this.cleanCatalogText(alias).toLowerCase() === normalizedName,
      )
    ) {
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

  private async getOrdersSection(
    filters: DashboardFilters = {},
  ): Promise<DashboardSection> {
    const dateFilter = this.dateFilter(filters.dateFrom, filters.dateTo);
    const invoiceDateFilter = this.dateFilter(
      filters.invoiceDateFrom,
      filters.invoiceDateTo,
    );
    const where: Prisma.OrderWhereInput = {
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
      ...(filters.country
        ? {
            country: {
              contains: filters.country,
              mode: 'insensitive' as const,
            },
          }
        : {}),
    };

    if (filters.store) {
      const stores = await this.prisma.store.findMany({
        select: { id: true, name: true, normalizedName: true },
      });
      const normalizedStore = this.normalizeStoreName(filters.store);
      const storeIds = stores
        .filter(
          (store) =>
            sameText(store.name, filters.store as string) ||
            store.normalizedName === normalizedStore,
        )
        .map((store) => store.id);

      where.storeId = { in: storeIds };
    }

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
    if (filters.orderSearch) {
      orderIdSets.push(await this.findOrderIdsForSearch(filters.orderSearch));
    }
    if (invoiceDateFilter) {
      const matchingInvoices = await this.prisma.fulfillmentInvoice.findMany({
        where: { invoiceDate: invoiceDateFilter },
        select: { storeId: true, invoiceReference: true },
        take: 10000,
      });

      if (matchingInvoices.length === 0) {
        orderIdSets.push([]);
      } else {
        const matchingInvoiceOrders = await this.prisma.order.findMany({
          where: {
            OR: matchingInvoices.map((invoice) => ({
              storeId: invoice.storeId,
              invoiceReference: invoice.invoiceReference,
            })),
          },
          select: { id: true },
          take: 10000,
        });
        orderIdSets.push(matchingInvoiceOrders.map((order) => order.id));
      }
    }

    const filteredOrderIds = this.intersectIdSets(orderIdSets);
    if (filteredOrderIds) {
      where.id = { in: filteredOrderIds };
    }
    const orderSort =
      filters.orderSort === 'asc' || filters.orderSort === 'desc'
        ? filters.orderSort
        : null;

    const pageSize = 100;
    const requestedPage = Number.parseInt(String(filters.orderPage ?? ''), 10);
    const page =
      Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const hasDateFilter = Boolean(dateFilter || invoiceDateFilter);
    const totalCostPromise = hasDateFilter
      ? this.prisma.orderLine.aggregate({
          where: { order: where },
          _sum: { totalCost: true },
        })
      : Promise.resolve(null);

    const [totalOrders, totalCostAggregate, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      totalCostPromise,
      this.prisma.order.findMany({
        where,
        // Imported rows share createdAt timestamps, so the default order
        // follows the Excel file (sheet, then row); id keeps pagination
        // stable as a final tiebreaker.
        orderBy: orderSort
          ? [
              { externalOrderNumber: orderSort },
              { createdAt: 'desc' },
              { id: 'desc' },
            ]
          : [{ sourceSheet: 'asc' }, { sourceRow: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          externalOrderNumber: true,
          orderDate: true,
          invoiceReference: true,
          country: true,
          status: true,
          sourceSheet: true,
          sourceRow: true,
          store: { select: { name: true } },
          lines: {
            orderBy: { sourceRow: 'asc' },
            select: {
              sku: true,
              quantity: true,
              productCost: true,
              shippingCost: true,
              handlingCost: true,
              totalCost: true,
              lineType: true,
              sourceSheet: true,
              sourceRow: true,
              product: {
                select: {
                  id: true,
                  name: true,
                  description: true,
                  weight: true,
                  imageUrl: true,
                  quotation: true,
                  skuAliases: {
                    select: { sku: true, store: { select: { name: true } } },
                    orderBy: { sku: 'asc' },
                  },
                  _count: {
                    select: {
                      orderLines: true,
                      stockPurchases: true,
                      inventoryMovements: true,
                    },
                  },
                },
              },
            },
          },
          shipments: {
            orderBy: { trackingNumber: 'asc' },
            select: { trackingNumber: true },
          },
        },
      }),
    ]);

    return {
      title: 'Order lines',
      totalRows: totalOrders,
      page,
      pageSize,
      meta: {
        hasDateFilter,
        totalCost: this.round(totalCostAggregate?._sum.totalCost ?? 0),
      },
      columns: [
        { key: 'orderNumber', label: 'Order number' },
        { key: 'store', label: 'Store' },
        { key: 'invoice', label: 'Invoice' },
        { key: 'country', label: 'Country' },
        { key: 'status', label: 'Status' },
        { key: 'date', label: 'Date' },
        { key: 'trackingNumbers', label: 'Tracking' },
        { key: 'sku', label: 'Product' },
        { key: 'quantity', label: 'Quantity' },
        { key: 'productCost', label: 'Product cost' },
        { key: 'shippingCost', label: 'Shipping cost' },
        { key: 'handlingCost', label: 'Handling cost' },
        { key: 'totalCost', label: 'Total cost' },
        { key: 'lineType', label: 'Line type' },
        { key: 'sourceSheet', label: 'Source sheet' },
        { key: 'sourceRow', label: 'Source row' },
      ],
      rows: orders.flatMap((order) => {
        const trackingNumbers =
          order.shipments
            .map((shipment) => shipment.trackingNumber)
            .join(', ') || '-';
        const baseRow = {
          orderNumber: order.externalOrderNumber,
          store: order.store.name,
          invoice: order.invoiceReference,
          country: order.country ?? '-',
          status: this.formatLabel(order.status),
          date: this.formatDateValue(order.orderDate),
          trackingNumbers,
          refunded: order.lines.some((line) => line.lineType === 'refund'),
        };

        if (order.lines.length === 0) {
          return [
            {
              ...baseRow,
              sku: '-',
              quantity: 0,
              productCost: 0,
              shippingCost: 0,
              handlingCost: 0,
              totalCost: 0,
              lineType: '-',
              sourceSheet: order.sourceSheet,
              sourceRow: order.sourceRow,
            },
          ];
        }

        return order.lines.map((line) => ({
          ...baseRow,
          sku: line.sku,
          quantity: line.quantity,
          productCost: this.round(line.productCost),
          shippingCost: this.round(line.shippingCost),
          handlingCost: this.round(line.handlingCost),
          totalCost: this.round(line.totalCost),
          lineType: this.formatLabel(line.lineType),
          sourceSheet: line.sourceSheet,
          sourceRow: line.sourceRow,
          product: line.product
            ? this.productSummaryResponseRow(line.product)
            : {
                name: line.sku,
                description:
                  'No linked product details were found for this SKU.',
                imageUrl: null,
                skuAliases: [line.sku],
                stores: [order.store.name],
                skus: line.sku,
                weight: null,
                orderLines: 0,
                stockPurchases: 0,
                inventoryMovements: 0,
                currentInventory: 0,
                quotation: null,
              },
        }));
      }),
    };
  }

  private productSummaryResponseRow(product: any) {
    return {
      id: product.id,
      name: product.name,
      description: product.description ?? '',
      imageUrl: product.imageUrl ?? null,
      skuAliases: product.skuAliases.map((alias: any) => alias.sku),
      stores: [
        ...new Set(
          product.skuAliases
            .map((alias: any) => alias.store?.name)
            .filter((store: unknown): store is string => Boolean(store)),
        ),
      ],
      skus: product.skuAliases.map((alias: any) => alias.sku).join(', ') || '-',
      weight: product.weight ?? null,
      orderLines: product._count.orderLines,
      stockPurchases: product._count.stockPurchases,
      inventoryMovements: product._count.inventoryMovements,
      quotation: this.normalizeQuotationForResponse(product.quotation) ?? null,
    };
  }

  private async getProductMatchingSection(): Promise<DashboardSection> {
    const links = await this.prisma.inventoryProductLink.findMany({
      orderBy: [
        { confirmedByAdmin: 'asc' },
        { confidence: 'asc' },
        { createdAt: 'desc' },
      ],
      take: 500,
      select: {
        id: true,
        relationType: true,
        quantityPerProduct: true,
        confidence: true,
        confirmedByAdmin: true,
        inventoryItem: {
          select: {
            stockName: true,
            sourceSheet: true,
            importBatch: { select: { fileName: true } },
          },
        },
        product: { select: { id: true, name: true } },
      },
    });

    return {
      title: 'Product Matching Review',
      columns: [
        { key: 'stockItemName', label: 'Stock item name' },
        { key: 'suggestedProduct', label: 'Suggested product' },
        { key: 'relationType', label: 'Relation type' },
        { key: 'confidenceScore', label: 'Confidence score' },
        { key: 'quantityPerProduct', label: 'Quantity per product' },
        { key: 'confirmedByAdmin', label: 'Confirmed' },
      ],
      rows: links.map((link) => ({
        id: link.id,
        stockItemName: link.inventoryItem.stockName,
        suggestedProduct: link.product?.name ?? '-',
        suggestedProductId: link.product?.id ?? null,
        relationType: link.relationType,
        confidenceScore: this.round(link.confidence),
        quantityPerProduct: link.quantityPerProduct,
        confirmedByAdmin: link.confirmedByAdmin,
        sourceSheet: link.inventoryItem.sourceSheet ?? '-',
        importFile: link.inventoryItem.importBatch.fileName,
      })),
    };
  }

  async updateProductMatch(
    matchId: string,
    action: 'confirm' | 'reject' | 'edit',
    data: {
      productName?: string;
      relationType?: string;
      quantityPerProduct?: number;
    } = {},
  ) {
    if (!matchId) {
      throw new Error('Product match ID is required.');
    }

    if (action === 'reject') {
      return this.prisma.inventoryProductLink.update({
        where: { id: matchId },
        data: {
          productId: null,
          confidence: 0,
          confirmedByAdmin: false,
        },
      });
    }

    const current = await this.prisma.inventoryProductLink.findUnique({
      where: { id: matchId },
      select: {
        productId: true,
        relationType: true,
        quantityPerProduct: true,
        inventoryItem: {
          select: {
            stockName: true,
            normalizedName: true,
            sourceSheet: true,
          },
        },
      },
    });
    if (!current) {
      throw new Error('Product match was not found.');
    }

    const product = data.productName
      ? await this.prisma.product.findFirst({
          where: {
            name: { contains: data.productName, mode: 'insensitive' as const },
          },
          select: { id: true },
        })
      : current.productId
        ? { id: current.productId }
        : null;
    if (!product) {
      throw new Error('A matching catalog product is required.');
    }

    const relationType = this.normalizeRelationType(
      data.relationType ?? current.relationType,
    );
    const quantityPerProduct =
      Number(data.quantityPerProduct ?? current.quantityPerProduct) || 1;

    await this.prisma.productAlias.upsert({
      where: { normalizedName: current.inventoryItem.normalizedName },
      update: {
        productId: product.id,
        aliasName: current.inventoryItem.stockName,
        sourceSheet: current.inventoryItem.sourceSheet,
        confidence: 1,
        confirmedByAdmin: true,
      },
      create: {
        productId: product.id,
        aliasName: current.inventoryItem.stockName,
        normalizedName: current.inventoryItem.normalizedName,
        sourceSheet: current.inventoryItem.sourceSheet,
        confidence: 1,
        confirmedByAdmin: true,
      },
    });

    return this.prisma.inventoryProductLink.update({
      where: { id: matchId },
      data: {
        productId: product.id,
        relationType,
        quantityPerProduct,
        confidence: 1,
        confirmedByAdmin: true,
      },
    });
  }

  private normalizeRelationType(value: string) {
    return ['alias', 'variant', 'component'].includes(value)
      ? value
      : 'alias';
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
    const storeNameById = new Map(
      stores.map((store) => [store.id, store.name]),
    );
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
        store: payment.storeId
          ? (storeNameById.get(payment.storeId) ?? '-')
          : '-',
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

  private groupBySeverity(
    rows: Array<{ severity?: string | null }>,
  ): ChartPoint[] {
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
    const filter: { gte?: Date; lt?: Date } = {};
    if (dateFrom) filter.gte = new Date(dateFrom);
    if (dateTo) {
      // Order dates carry a time of day, so include the whole "to" day by
      // bounding at the start of the next day (exclusive).
      const endExclusive = new Date(dateTo);
      endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
      filter.lt = endExclusive;
    }
    return Object.keys(filter).length ? filter : null;
  }

  private normalizeDashboardFilters(filters: DashboardFilters) {
    return Object.fromEntries(
      Object.entries(filters).map(([key, value]) => {
        const normalizedValue =
          typeof value === 'string' ? value.trim() : value;
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
          .filter(
            (value): value is string | number =>
              value !== null && value !== undefined,
          )
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
}

function sameText(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
