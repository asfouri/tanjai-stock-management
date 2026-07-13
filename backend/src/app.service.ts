import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ChartPoint,
  DashboardDebugCounts,
  DashboardFilters,
  NotificationItem,
  DashboardSection,
  DashboardSummary,
} from './app.types';
import type { AuthenticatedUser } from './auth/supabase-auth.guard';
import { PrismaService } from './prisma.service';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async getNotifications(
    access: AuthenticatedUser,
  ): Promise<NotificationItem[]> {
    const storeIds = this.accessStoreIds(access);
    const orderWhere = storeIds ? { storeId: { in: storeIds } } : undefined;
    const isAdmin = access.role === 'TANJAI_ADMIN';
    const isBrandOwner = access.role === 'BRAND_OWNER';

    const [orders, depositRequests, imports, anomalies, stockMovements] =
      await Promise.all([
      this.prisma.order.findMany({
        where: orderWhere,
        select: {
          id: true,
          externalOrderNumber: true,
          createdAt: true,
          store: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      isAdmin || isBrandOwner
        ? this.prisma.depositRequest.findMany({
            where: isBrandOwner
              ? {
                  OR: [
                    ...(access.id
                      ? [{ requestedByUserId: access.id }]
                      : []),
                    { requestedByEmail: access.email },
                  ],
                }
              : { status: 'PENDING' },
            select: {
              id: true,
              requestedByEmail: true,
              amount: true,
              status: true,
              createdAt: true,
              updatedAt: true,
            },
            orderBy: { updatedAt: 'desc' },
            take: 10,
          })
        : Promise.resolve([]),
      isAdmin
        ? this.prisma.importBatch.findMany({
            select: { id: true, fileName: true, status: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 5,
          })
        : Promise.resolve([]),
      isAdmin
        ? this.prisma.anomaly.findMany({
            select: { id: true, message: true, severity: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 5,
          })
        : Promise.resolve([]),
      this.prisma.inventoryMovement.findMany({
        where: storeIds ? { storeId: { in: storeIds } } : undefined,
        select: {
          quantity: true,
          movementType: true,
          stockName: true,
          movementDate: true,
          createdAt: true,
          product: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 25000,
      }),
    ]);

    const stockTotals = new Map<
      string,
      { total: number; updatedAt: Date }
    >();
    for (const movement of stockMovements) {
      const label = movement.product?.name ?? movement.stockName?.trim();
      if (!label) continue;
      const sign = this.inventoryMovementSign(movement.movementType);
      if (sign === 0) continue;
      const movementTime = movement.movementDate ?? movement.createdAt;
      const current = stockTotals.get(label);
      stockTotals.set(label, {
        total: (current?.total ?? 0) + movement.quantity * sign,
        updatedAt:
          current && current.updatedAt > movementTime
            ? current.updatedAt
            : movementTime,
      });
    }

    const stockAlerts: NotificationItem[] = [...stockTotals.entries()]
      .filter(([, stock]) => stock.total <= 10)
      .sort((left, right) => left[1].total - right[1].total)
      .slice(0, 10)
      .map(([productName, stock]) => ({
        id: `stock-${productName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        type: 'STOCK',
        priority: 'HIGH',
        title: stock.total <= 0 ? 'Product out of stock' : 'Stock running low',
        message:
          stock.total <= 0
            ? `${productName} has no stock remaining.`
            : `${productName} has only ${this.round(stock.total)} units remaining.`,
        createdAt: stock.updatedAt.toISOString(),
        section: 'products',
      }));

    const paymentAlerts: NotificationItem[] = [];
    if (isAdmin) {
      const [importedDeposits, approvedDeposits, spent, latestTransaction] =
        await Promise.all([
          this.prisma.walletTransaction.aggregate({
            where: {
              transactionType: { contains: 'deposit', mode: 'insensitive' },
            },
            _sum: { amount: true },
          }),
          this.prisma.depositRequest.aggregate({
            where: { status: 'APPROVED' },
            _sum: { amount: true },
          }),
          this.prisma.walletTransaction.aggregate({
            where: {
              transactionType: {
                in: ['store_invoice', 'stock_purchase', 'tax'],
                mode: 'insensitive',
              },
            },
            _sum: { amount: true },
          }),
          this.prisma.walletTransaction.findFirst({
            select: { createdAt: true },
            orderBy: { createdAt: 'desc' },
          }),
        ]);
      const totalDeposits = this.round(
        (importedDeposits._sum.amount ?? 0) +
          (approvedDeposits._sum.amount ?? 0),
      );
      const totalSpent = this.round(Math.abs(spent._sum.amount ?? 0));
      const remaining = this.round(totalDeposits - totalSpent);
      const remainingRatio = totalDeposits > 0 ? remaining / totalDeposits : 0;

      if (remaining <= 0) {
        paymentAlerts.push({
          id: 'payment-balance-exhausted',
          type: 'PAYMENT',
          priority: 'HIGH',
          title: 'Deposit balance exhausted',
          message: `Spending has consumed the available deposits. Balance: ${remaining.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}.`,
          createdAt: (latestTransaction?.createdAt ?? new Date(0)).toISOString(),
          section: 'payments',
        });
      } else if (remainingRatio <= 0.1) {
        paymentAlerts.push({
          id: 'payment-balance-low',
          type: 'PAYMENT',
          priority: 'MEDIUM',
          title: 'Deposit balance running low',
          message: `Only ${remaining.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} remains from deposits.`,
          createdAt: (latestTransaction?.createdAt ?? new Date(0)).toISOString(),
          section: 'payments',
        });
      }
    }

    const notifications: NotificationItem[] = [
      ...orders.map((order) => ({
        id: `order-${order.id}`,
        type: 'ORDER' as const,
        priority: 'LOW' as const,
        title: `Order ${order.externalOrderNumber}`,
        message: `New order activity for ${order.store.name}.`,
        createdAt: order.createdAt.toISOString(),
        section: 'orders' as const,
      })),
      ...depositRequests.map((request) => ({
        id: `deposit-${request.id}-${request.status}`,
        type: 'DEPOSIT' as const,
        priority: (request.status === 'REJECTED'
          ? 'HIGH'
          : request.status === 'PENDING'
            ? 'MEDIUM'
            : 'LOW') as NotificationItem['priority'],
        title: isAdmin
          ? `Deposit request from ${request.requestedByEmail}`
          : `Deposit request ${this.formatLabel(request.status)}`,
        message: `${request.amount.toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
        })}${isAdmin ? ' is waiting for review.' : ` is ${request.status.toLowerCase()}.`}`,
        createdAt: (request.updatedAt ?? request.createdAt).toISOString(),
        section: 'payments' as const,
      })),
      ...imports.map((batch) => ({
        id: `import-${batch.id}`,
        type: 'IMPORT' as const,
        priority: 'LOW' as const,
        title: 'Excel import completed',
        message: `${batch.fileName} was imported successfully.`,
        createdAt: batch.createdAt.toISOString(),
        section: 'imports' as const,
      })),
      ...anomalies.map((anomaly) => ({
        id: `anomaly-${anomaly.id}`,
        type: 'ANOMALY' as const,
        priority: (['critical', 'error'].includes(
          anomaly.severity.toLowerCase(),
        )
          ? 'HIGH'
          : anomaly.severity.toLowerCase() === 'warning'
            ? 'MEDIUM'
            : 'LOW') as NotificationItem['priority'],
        title: `${this.formatLabel(anomaly.severity)} anomaly`,
        message: anomaly.message,
        createdAt: anomaly.createdAt.toISOString(),
        section: 'dashboard' as const,
      })),
      ...stockAlerts,
      ...paymentAlerts,
    ];

    const priorityOrder: Record<NotificationItem['priority'], number> = {
      HIGH: 0,
      MEDIUM: 1,
      LOW: 2,
    };
    return notifications
      .sort(
        (first, second) =>
          priorityOrder[first.priority] - priorityOrder[second.priority] ||
          new Date(second.createdAt).getTime() -
            new Date(first.createdAt).getTime(),
      )
      .slice(0, 40);
  }

  async getDashboardSection(
    section: string,
    filters: DashboardFilters = {},
    access: AuthenticatedUser,
  ): Promise<DashboardSection> {
    const normalizedFilters = this.normalizeDashboardFilters(filters);
    const storeIds = this.accessStoreIds(access);

    switch (section) {
      case 'products':
        return this.getProductsSection('with-skus', storeIds, access.role);
      case 'products-without-skus':
        return this.getProductsSection('without-skus', storeIds, access.role);
      case 'orders':
        return this.getOrdersSection(normalizedFilters, storeIds, access.role);
      case 'stores':
        return this.getStoresSection(storeIds);
      case 'invoices':
        return this.getInvoicesSection(
          normalizedFilters,
          storeIds,
          access.role,
        );
      case 'payments':
        return this.getPaymentsSection(normalizedFilters, access);
      default:
        return { title: 'Dashboard', columns: [], rows: [] };
    }
  }

  async getDashboardSummary(
    filters: DashboardFilters = {},
    access: AuthenticatedUser,
  ): Promise<DashboardSummary> {
    const normalizedFilters = this.normalizeDashboardFilters(filters);
    return this.getErpDashboardSummary(normalizedFilters, access);
  }

  private async getErpDashboardSummary(
    filters: DashboardFilters,
    access: AuthenticatedUser,
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
      const accessStoreIds = this.accessStoreIds(access);
      const restrictStores = Boolean(
        filters.store || filters.brand || accessStoreIds,
      );
      const allowedStores = stores.filter((store) => {
        if (accessStoreIds && !accessStoreIds.includes(store.id)) {
          return false;
        }
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
        allDepositTotals,
        allSpendTotals,
        approvedDepositTotals,
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
        access.role === 'BRAND_OWNER'
          ? Promise.resolve([])
          : this.prisma.anomaly.findMany({
              select: {
                id: true,
                severity: true,
                createdAt: true,
                message: true,
              },
              orderBy: { createdAt: 'desc' },
              take: 1000,
            }),
        this.prisma.productSkuAlias.findMany({
          where: accessStoreIds
            ? { storeId: { in: accessStoreIds } }
            : undefined,
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
        this.prisma.walletTransaction.aggregate({
          where: {
            ...(access.role === 'TANJAI_ADMIN'
              ? {
                  transactionType: {
                    contains: 'deposit',
                    mode: 'insensitive' as const,
                  },
                }
              : { id: '__not_visible__' }),
          },
          _sum: { amount: true },
        }),
        this.prisma.walletTransaction.aggregate({
          where: {
            transactionType: {
              in: ['store_invoice', 'stock_purchase', 'tax'],
              mode: 'insensitive',
            },
            ...(accessStoreIds
              ? { storeId: { in: accessStoreIds } }
              : {}),
          },
          _sum: { amount: true },
        }),
        this.prisma.depositRequest.aggregate({
          where: {
            status: 'APPROVED',
            ...(access.role === 'UFULFILL'
              ? { id: '__not_visible__' }
              : access.role === 'BRAND_OWNER'
                ? {
                    OR: [
                      ...(access.id
                        ? [{ requestedByUserId: access.id }]
                        : []),
                      { requestedByEmail: access.email.toLowerCase() },
                    ],
                  }
                : {}),
          },
          _sum: { amount: true },
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
        access.role !== 'UFULFILL'
          ? this.round(
              (allDepositTotals._sum.amount ?? 0) +
                (approvedDepositTotals._sum.amount ?? 0) -
                Math.abs(allSpendTotals._sum.amount ?? 0),
            )
          : 0;

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
      const canSeeCosts = access.role !== 'UFULFILL';
      const productCosts = canSeeCosts
        ? this.round(costAgg._sum.productCost ?? 0)
        : 0;
      const shippingCosts = canSeeCosts
        ? this.round(costAgg._sum.shippingCost ?? 0)
        : 0;
      const handlingCosts = canSeeCosts
        ? this.round(costAgg._sum.handlingCost ?? 0)
        : 0;
      const totalCosts = canSeeCosts
        ? this.round(invoiceAgg._sum.total ?? 0)
        : 0;
      const refunds = canSeeCosts
        ? this.round(invoiceAgg._sum.refunds ?? 0)
        : 0;
      const otherCosts = canSeeCosts
        ? this.round(invoiceAgg._sum.otherCost ?? 0)
        : 0;
      const stockStatus = this.round(
        stockMovements.reduce((total, movement) => {
          const sign = this.inventoryMovementSign(movement.movementType);
          if (sign === 0) return total;
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
        costsByDate: canSeeCosts ? this.groupCostByDate(linesWithOrder) : [],
        ordersByStore: this.groupCountByLabel(
          orders.map(
            (order) => storeNameById.get(order.storeId) ?? 'Unknown store',
          ),
        ),
        costsByStore: canSeeCosts ? this.groupCostByStore(linesWithOrder) : [],
        costDistribution: canSeeCosts ? [
          { label: 'Product', total: productCosts },
          { label: 'Shipping', total: shippingCosts },
          { label: 'Handling', total: handlingCosts },
          { label: 'Refunds', total: Math.abs(refunds) },
          {
            label: 'Other',
            total: Math.abs(otherCosts),
          },
        ].filter((item) => item.total > 0) : [],
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
          brands: brands
            .filter((brand) =>
              allowedStores.some((store) => store.brandId === brand.id),
            )
            .map((brand) => brand.name),
          stores: allowedStores.map((store) => store.name),
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
        debugCounts: access.role === 'TANJAI_ADMIN' ? debugCounts : undefined,
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

  private async getProductsSection(
    skuMode: 'with-skus' | 'without-skus' = 'with-skus',
    storeIds: string[] | null = null,
    role = 'TANJAI_ADMIN',
  ): Promise<DashboardSection> {
    if (skuMode === 'without-skus') {
      return this.getStockItemsWithoutSkusSection();
    }

    try {
      return await this.loadProductsSection(
        role !== 'UFULFILL',
        storeIds,
      );
    } catch (error) {
      if (this.isMissingProductQuotationColumn(error)) {
        return this.loadProductsSection(false, storeIds);
      }
      throw error;
    }
  }

  private async loadProductsSection(
    includeQuotation: boolean,
    storeIds: string[] | null = null,
  ): Promise<DashboardSection> {
    const select: Record<string, unknown> = {
      id: true,
      name: true,
      description: true,
      weight: true,
      imageUrl: true,
      skuAliases: {
        ...(storeIds ? { where: { storeId: { in: storeIds } } } : {}),
        select: { sku: true, store: { select: { name: true } } },
        orderBy: { sku: 'asc' },
      },
      _count: {
        select: {
          orderLines: storeIds
            ? { where: { order: { storeId: { in: storeIds } } } }
            : true,
          stockPurchases: storeIds
            ? { where: { id: '__not_accessible__' } }
            : true,
          inventoryMovements: storeIds
            ? { where: { storeId: { in: storeIds } } }
            : true,
        },
      },
    };

    if (includeQuotation) {
      select.quotation = true;
    }

    const products = await this.prisma.product.findMany({
      where: storeIds
        ? {
            OR: [
              { skuAliases: { some: { storeId: { in: storeIds } } } },
              {
                orderLines: {
                  some: { order: { storeId: { in: storeIds } } },
                },
              },
              {
                inventoryMovements: {
                  some: { storeId: { in: storeIds } },
                },
              },
            ],
          }
        : undefined,
      orderBy: { name: 'asc' },
      take: 5000,
      select,
    });
    const catalogProducts = products.filter((product) => {
      if (!this.isCatalogProduct(product, includeQuotation)) return false;
      return true;
    });

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
        this.productResponseRow(product, includeQuotation, 0, true),
      ),
    };
  }

  private async getStockItemsWithoutSkusSection(): Promise<DashboardSection> {
    const items = await this.prisma.inventoryItem.findMany({
      where: {
        AND: [
          { OR: [{ stockSku: null }, { stockSku: '' }] },
          { links: { none: { productId: { not: null } } } },
        ],
      },
      orderBy: { stockName: 'asc' },
      take: 5000,
      select: {
        id: true,
        stockName: true,
        sourceSheet: true,
        importBatch: { select: { fileName: true } },
        _count: { select: { links: true } },
      },
    });

    return {
      title: 'Products Without SKUs',
      columns: [
        { key: 'name', label: 'Stock item' },
        { key: 'sourceSheet', label: 'Source sheet' },
        { key: 'matchedProduct', label: 'Matched product' },
        { key: 'inventoryLinks', label: 'Links' },
      ],
      rows: items.map((item) => {
        return {
          id: undefined,
          inventoryItemId: item.id,
          name: item.stockName,
          description: `Unmatched stock item from ${item.importBatch.fileName}`,
          imageUrl: null,
          skuAliases: [],
          stores: [],
          skus: '-',
          weight: null,
          orderLines: 0,
          stockPurchases: 0,
          inventoryMovements: 0,
          currentInventory: 0,
          quotation: null,
          sourceSheet: item.sourceSheet ?? '-',
          matchedProduct: '-',
          inventoryLinks: item._count.links,
        };
      }),
    };
  }

  async getDashboardProduct(id: string, access: AuthenticatedUser) {
    if (!id) {
      throw new BadRequestException('Product ID is required.');
    }

    const storeIds = this.accessStoreIds(access);
    const product = await this.prisma.product.findFirst({
      where: {
        id,
        ...(storeIds
          ? {
              OR: [
                { skuAliases: { some: { storeId: { in: storeIds } } } },
                {
                  orderLines: {
                    some: { order: { storeId: { in: storeIds } } },
                  },
                },
                {
                  inventoryMovements: {
                    some: { storeId: { in: storeIds } },
                  },
                },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        description: true,
        weight: true,
        imageUrl: true,
        quotation: access.role !== 'UFULFILL',
        skuAliases: {
          ...(storeIds ? { where: { storeId: { in: storeIds } } } : {}),
          select: { sku: true, store: { select: { name: true } } },
          orderBy: { sku: 'asc' },
        },
        inventoryMovements: {
          ...(storeIds ? { where: { storeId: { in: storeIds } } } : {}),
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
            orderLines: storeIds
              ? { where: { order: { storeId: { in: storeIds } } } }
              : true,
            stockPurchases: storeIds
              ? { where: { id: '__not_accessible__' } }
              : true,
            inventoryMovements: storeIds
              ? { where: { storeId: { in: storeIds } } }
              : true,
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product was not found.');
    }

    const movementTotals = await this.prisma.inventoryMovement.groupBy({
      by: ['movementType'],
      _sum: { quantity: true },
      where: {
        productId: id,
        ...(storeIds ? { storeId: { in: storeIds } } : {}),
      },
    });
    let currentInventory = 0;
    for (const total of movementTotals) {
      const sign = this.inventoryMovementSign(total.movementType);
      if (sign === 0) continue;
      currentInventory += (total._sum.quantity ?? 0) * sign;
    }

    return this.productResponseRow(
      product,
      access.role !== 'UFULFILL',
      this.round(currentInventory),
    );
  }

  async getDashboardInventoryItem(id: string) {
    if (!id) {
      throw new BadRequestException('Inventory item ID is required.');
    }

    const item = await this.prisma.inventoryItem.findUnique({
      where: { id },
      select: {
        id: true,
        stockName: true,
        sourceSheet: true,
        importBatchId: true,
        importBatch: { select: { fileName: true } },
      },
    });

    if (!item) {
      throw new NotFoundException('Inventory item was not found.');
    }

    const movements = await this.prisma.inventoryMovement.findMany({
      where: {
        importBatchId: item.importBatchId,
        stockName: item.stockName,
      },
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
    });

    return {
      id: undefined,
      inventoryItemId: item.id,
      name: item.stockName,
      description: `Unmatched stock item from ${item.importBatch.fileName}`,
      imageUrl: null,
      skuAliases: [],
      stores: [],
      skus: '-',
      weight: null,
      orderLines: 0,
      stockPurchases: 0,
      inventoryMovements: movements.length,
      currentInventory: this.round(
        movements.reduce((total, movement) => {
          const sign = this.inventoryMovementSign(movement.movementType);
          if (sign === 0) return total;
          return total + movement.quantity * sign;
        }, 0),
      ),
      quotation: null,
      movements: movements.map((movement) => ({
        date: this.formatDateValue(movement.movementDate),
        type: this.formatLabel(movement.movementType),
        movementType: movement.movementType,
        quantity: movement.quantity,
        reference: movement.reference ?? '-',
        comment: movement.comment ?? '',
      })),
      sourceSheet: item.sourceSheet ?? '-',
    };
  }

  private productResponseRow(
    product: any,
    includeQuotation: boolean,
    currentInventory = 0,
    compactQuotation = false,
  ) {
    return {
      id: product.id,
      name: product.name,
      description: product.description ?? '',
      imageUrl: product.imageUrl ?? null,
      skuAliases: product.skuAliases.map((alias: any) => alias.sku),
      quotation:
        includeQuotation && 'quotation' in product
          ? compactQuotation
            ? this.compactQuotationForList(product.quotation)
            : (this.normalizeQuotationForResponse(product.quotation) ?? null)
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

  private compactQuotationForList(quotation: unknown) {
    if (
      !quotation ||
      typeof quotation !== 'object' ||
      Array.isArray(quotation)
    ) {
      return null;
    }

    const record = quotation as Record<string, unknown>;
    const firstRow = Array.isArray(record.quotationRows)
      ? record.quotationRows.find(
          (row) => row && typeof row === 'object' && !Array.isArray(row),
        )
      : null;
    const firstRowRecord = (firstRow ?? null) as Record<string, unknown> | null;

    return {
      productGroup:
        typeof record.productGroup === 'string' ? record.productGroup : '',
      quotationRows:
        typeof firstRowRecord?.sourceRow === 'number'
          ? [{ sourceRow: firstRowRecord.sourceRow }]
          : [],
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
    accessibleStoreIds: string[] | null = null,
    role = 'TANJAI_ADMIN',
  ): Promise<DashboardSection> {
    const canSeeCosts = role !== 'UFULFILL';
    const dateFilter = this.dateFilter(filters.dateFrom, filters.dateTo);
    const invoiceDateFilter = this.dateFilter(
      filters.invoiceDateFrom,
      filters.invoiceDateTo,
    );
    const where: Prisma.OrderWhereInput = {
      ...(accessibleStoreIds
        ? { storeId: { in: accessibleStoreIds } }
        : {}),
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
      const requestedStoreIds = stores
        .filter(
          (store) =>
            sameText(store.name, filters.store as string) ||
            store.normalizedName === normalizedStore,
        )
        .map((store) => store.id)
        .filter(
          (storeId) =>
            !accessibleStoreIds || accessibleStoreIds.includes(storeId),
        );

      where.storeId = { in: requestedStoreIds };
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
    const totalCostPromise = hasDateFilter && canSeeCosts
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
                  quotation: canSeeCosts,
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
        totalCost: canSeeCosts
          ? this.round(totalCostAggregate?._sum.totalCost ?? 0)
          : 0,
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
      ].filter(
        (column) =>
          canSeeCosts ||
          ![
            'productCost',
            'shippingCost',
            'handlingCost',
            'totalCost',
          ].includes(column.key),
      ),
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
              ...(canSeeCosts
                ? {
                    productCost: 0,
                    shippingCost: 0,
                    handlingCost: 0,
                    totalCost: 0,
                  }
                : {}),
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
          ...(canSeeCosts
            ? {
                productCost: this.round(line.productCost),
                shippingCost: this.round(line.shippingCost),
                handlingCost: this.round(line.handlingCost),
                totalCost: this.round(line.totalCost),
              }
            : {}),
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

  private async getStoresSection(
    storeIds: string[] | null = null,
  ): Promise<DashboardSection> {
    const stores = await this.prisma.store.findMany({
      where: storeIds ? { id: { in: storeIds } } : undefined,
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

  private async getInvoicesSection(
    filters: DashboardFilters = {},
    accessibleStoreIds: string[] | null = null,
    role = 'TANJAI_ADMIN',
  ): Promise<DashboardSection> {
    const canSeeCosts = role !== 'UFULFILL';
    const invoiceDateFilter = this.dateFilter(
      filters.invoiceDateFrom,
      filters.invoiceDateTo,
    );
    const where: Prisma.FulfillmentInvoiceWhereInput = {
      ...(accessibleStoreIds
        ? { storeId: { in: accessibleStoreIds } }
        : {}),
      ...(invoiceDateFilter ? { invoiceDate: invoiceDateFilter } : {}),
      ...(filters.invoice
        ? {
            invoiceReference: {
              contains: filters.invoice,
              mode: 'insensitive' as const,
            },
          }
        : {}),
      ...(filters.store
        ? {
            store: {
              name: {
                equals: filters.store,
                mode: 'insensitive' as const,
              },
            },
          }
        : {}),
    };
    const invoices = await this.prisma.fulfillmentInvoice.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        invoiceReference: true,
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
        { key: 'subtotal', label: 'Subtotal' },
        { key: 'refunds', label: 'Refunds' },
        { key: 'otherCost', label: 'Other' },
        { key: 'total', label: 'Total' },
      ].filter(
        (column) =>
          canSeeCosts ||
          !['subtotal', 'refunds', 'otherCost', 'total'].includes(column.key),
      ),
      rows: invoices.map((invoice) => ({
        invoice: invoice.invoiceReference,
        store: invoice.store.name,
        ...(canSeeCosts
          ? {
              subtotal: this.round(invoice.subtotal),
              refunds: this.round(invoice.refunds),
              otherCost: this.round(invoice.otherCost),
              total: this.round(invoice.total),
            }
          : {}),
      })),
    };
  }

  private async getPaymentsSection(
    filters: DashboardFilters = {},
    access: AuthenticatedUser,
  ): Promise<DashboardSection> {
    const accessibleStoreIds = this.accessStoreIds(access);
    const stores = await this.prisma.store.findMany({
      where: accessibleStoreIds
        ? { id: { in: accessibleStoreIds } }
        : undefined,
      select: { id: true, name: true, normalizedName: true },
      orderBy: { name: 'asc' },
    });
    const storeNameById = new Map(
      stores.map((store) => [store.id, store.name]),
    );
    const dateFilter = this.dateFilter(filters.dateFrom, filters.dateTo);
    const dateWhere: Prisma.WalletTransactionWhereInput = {
      ...(dateFilter ? { transactionDate: dateFilter } : {}),
    };
    const invoiceDateFilter: Prisma.StringNullableFilter = {
      ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
      ...(filters.dateTo ? { lte: filters.dateTo } : {}),
    };
    const depositWhere: Prisma.WalletTransactionWhereInput = {
      ...dateWhere,
      transactionType: { contains: 'deposit', mode: 'insensitive' },
    };
    const storeInvoiceWhere: Prisma.WalletTransactionWhereInput = {
      transactionType: {
        in: ['store_invoice', 'stock_purchase', 'tax'],
        mode: 'insensitive',
      },
      ...(Object.keys(invoiceDateFilter).length
        ? { invoiceReference: invoiceDateFilter }
        : {}),
      ...(accessibleStoreIds
        ? { storeId: { in: accessibleStoreIds } }
        : {}),
    };

    if (filters.store) {
      const normalizedStore = this.normalizeStoreName(filters.store);
      const storeIds = stores
        .filter(
          (store) =>
            sameText(store.name, filters.store as string) ||
            store.normalizedName === normalizedStore,
        )
        .map((store) => store.id);
      storeInvoiceWhere.storeId = { in: storeIds };
    }
    const paymentType = filters.paymentType?.trim().toLowerCase();
    const depositOwnerWhere: Prisma.DepositRequestWhereInput = {
      status: 'APPROVED',
      ...(access.role === 'BRAND_OWNER'
        ? {
            OR: [
              ...(access.id ? [{ requestedByUserId: access.id }] : []),
              { requestedByEmail: access.email.toLowerCase() },
            ],
          }
        : {}),
    };
    const filteredDepositRequestWhere: Prisma.DepositRequestWhereInput = {
      ...depositOwnerWhere,
      ...(dateFilter ? { transactionDate: dateFilter } : {}),
      ...(paymentType === 'spent' ? { id: '__not_visible__' } : {}),
    };
    const visibleWalletDepositWhere: Prisma.WalletTransactionWhereInput =
      access.role === 'BRAND_OWNER' ? { id: '__not_visible__' } : depositWhere;
    const paymentWheres =
      access.role === 'BRAND_OWNER'
        ? [storeInvoiceWhere]
        : paymentType === 'deposit'
        ? [visibleWalletDepositWhere]
        : paymentType === 'spent'
          ? [storeInvoiceWhere]
          : [visibleWalletDepositWhere, storeInvoiceWhere];
    const where: Prisma.WalletTransactionWhereInput = {
      OR: paymentWheres,
    };

    const [
      payments,
      depositTotals,
      storeInvoiceTotals,
      totalCount,
      allDepositTotals,
      allStoreInvoiceTotals,
      approvedDeposits,
      approvedDepositTotals,
      approvedDepositCount,
      allApprovedDepositTotals,
    ] =
      await Promise.all([
        this.prisma.walletTransaction.findMany({
          where,
          orderBy: [
            { transactionDate: { sort: 'desc', nulls: 'last' } },
            { createdAt: 'desc' },
          ],
          take: 500,
          select: {
            transactionDate: true,
            transactionType: true,
            invoiceReference: true,
            amount: true,
            runningBalance: true,
            storeId: true,
          },
        }),
        this.prisma.walletTransaction.aggregate({
          where: visibleWalletDepositWhere,
          _sum: { amount: true },
        }),
        this.prisma.walletTransaction.aggregate({
          where: storeInvoiceWhere,
          _sum: { amount: true },
        }),
        this.prisma.walletTransaction.count({ where }),
        this.prisma.walletTransaction.aggregate({
          where:
            access.role === 'BRAND_OWNER'
              ? { id: '__not_accessible__' }
              : {
                  transactionType: {
                    contains: 'deposit',
                    mode: 'insensitive',
                  },
                },
          _sum: { amount: true },
        }),
        this.prisma.walletTransaction.aggregate({
          where: {
            transactionType: {
              in: ['store_invoice', 'stock_purchase', 'tax'],
              mode: 'insensitive',
            },
            ...(accessibleStoreIds
              ? { storeId: { in: accessibleStoreIds } }
              : {}),
          },
          _sum: { amount: true },
        }),
        this.prisma.depositRequest.findMany({
          where: filteredDepositRequestWhere,
          orderBy: [{ transactionDate: 'desc' }, { createdAt: 'desc' }],
          take: 500,
          select: {
            id: true,
            requestedByEmail: true,
            transactionDate: true,
            amount: true,
            createdAt: true,
          },
        }),
        this.prisma.depositRequest.aggregate({
          where: filteredDepositRequestWhere,
          _sum: { amount: true },
        }),
        this.prisma.depositRequest.count({
          where: filteredDepositRequestWhere,
        }),
        this.prisma.depositRequest.aggregate({
          where: depositOwnerWhere,
          _sum: { amount: true },
        }),
      ]);

    const depositTotal =
      paymentType === 'spent'
        ? 0
        : this.round(
            (depositTotals._sum.amount ?? 0) +
              (approvedDepositTotals._sum.amount ?? 0),
          );
    const storeInvoiceTotal =
      paymentType === 'deposit'
        ? 0
        : this.round(storeInvoiceTotals._sum.amount ?? 0);
    const netMovement = this.round(depositTotal + storeInvoiceTotal);
    const allDepositTotal = this.round(
      (allDepositTotals._sum.amount ?? 0) +
        (allApprovedDepositTotals._sum.amount ?? 0),
    );
    const allStoreInvoiceTotal = this.round(
      Math.abs(allStoreInvoiceTotals._sum.amount ?? 0),
    );
    const remainingBalance = this.round(
      allDepositTotal - allStoreInvoiceTotal,
    );

    const paymentRows = payments.map((payment) => {
      const isDeposit = payment.transactionType
        .toLowerCase()
        .includes('deposit');
      return {
        sortDate: payment.transactionDate?.getTime() ?? 0,
        date: isDeposit
          ? this.formatDateValue(payment.transactionDate)
          : (payment.invoiceReference ?? '-'),
        store: payment.storeId
          ? (storeNameById.get(payment.storeId) ?? '-')
          : 'Brand owner',
        type: this.formatLabel(payment.transactionType),
        amount: this.round(payment.amount),
        balance:
          access.role === 'TANJAI_ADMIN' &&
          typeof payment.runningBalance === 'number'
            ? this.round(payment.runningBalance)
            : '-',
      };
    });
    const approvedDepositRows = approvedDeposits.map((deposit) => ({
      sortDate: deposit.transactionDate.getTime(),
      date: this.formatDateValue(deposit.transactionDate),
      store: deposit.requestedByEmail,
      type: 'Deposit',
      amount: this.round(deposit.amount),
      balance: '-',
    }));

    return {
      title: 'Deposits & Spending',
      columns: [
        { key: 'date', label: 'Date' },
        { key: 'store', label: 'Store' },
        { key: 'type', label: 'Type' },
        { key: 'amount', label: 'Amount' },
        { key: 'balance', label: 'Balance' },
      ],
      rows: [...paymentRows, ...approvedDepositRows]
        .sort((first, second) => second.sortDate - first.sortDate)
        .slice(0, 500)
        .map(({ sortDate: _sortDate, ...row }) => row),
      totalRows: totalCount + approvedDepositCount,
      meta: {
        remainingBalance,
        deposits: allDepositTotal,
        storeInvoices: allStoreInvoiceTotal,
        netMovement,
      },
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

  private accessStoreIds(access: AuthenticatedUser): string[] | null {
    if (access.role !== 'BRAND_OWNER') return null;
    return [...new Set(access.storeIds.map(String).map((id) => id.trim()))].filter(
      Boolean,
    );
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
      movementType: string | null;
      product: { name: string } | null;
    }>,
  ) {
    const grouped = movements.reduce<Record<string, number>>((totals, item) => {
      const label = item.product?.name ?? 'Unknown product';
      const sign = this.inventoryMovementSign(item.movementType);
      if (sign === 0) return totals;
      totals[label] = (totals[label] ?? 0) + item.quantity * sign;
      return totals;
    }, {});

    return Object.entries(grouped)
      .map(([label, total]) => ({ label, total: this.round(total) }))
      .sort((first, second) => second.total - first.total)
      .slice(0, 12);
  }

  private inventoryMovementSign(type: string | null | undefined) {
    const normalized = String(type ?? '').trim().toLowerCase();
    if (!normalized) return 0;
    if (
      normalized === 'snapshot' ||
      normalized === 'left' ||
      normalized.includes('left')
    ) {
      return 0;
    }
    if (
      normalized === 'consumption' ||
      normalized === 'used' ||
      normalized.includes('consum')
    ) {
      return -1;
    }
    if (
      normalized === 'stock' ||
      normalized === 'inbound' ||
      normalized === 'return_to_stock' ||
      normalized.includes('return')
    ) {
      return 1;
    }
    return 0;
  }

  private round(value: number) {
    return Number(value.toFixed(2));
  }
}

function sameText(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
