import { Injectable } from '@nestjs/common';
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
};

type DatabaseRow = {
  id?: string | number;
  status?: string | null;
  severity?: string | null;
  created_at?: string | null;
};

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async getDashboardSummary(
    filters: DashboardFilters = {},
  ): Promise<DashboardSummary> {
    if (process.env.EXCEL_IMPORT_STORAGE !== 'prisma') {
      const localSummary = await this.getLocalImportDashboardSummary(filters);
      if (localSummary) {
        return localSummary;
      }
    }

    const erpSummary = await this.getErpDashboardSummary(filters);

    if (erpSummary) {
      return erpSummary;
    }

    const [orders, requests, anomalies] = await Promise.all([
      this.getRows('orders', 'id,status,created_at'),
      this.getRows('requests', 'id,status,created_at'),
      this.getRows('anomalies', 'id,status,severity,created_at'),
    ]);

    const pendingOrders = this.countByValues(orders, 'status', ['pending']);
    const openRequests = this.countByValues(requests, 'status', [
      'open',
      'pending',
    ]);
    const unresolvedAnomalies = this.countByValues(anomalies, 'status', [
      'open',
      'pending',
      'unresolved',
    ]);

    return {
      totalOrders: orders.length,
      totalShipments: 0,
      totalInvoices: 0,
      totalCosts: 0,
      productCosts: 0,
      shippingCosts: 0,
      handlingCosts: 0,
      refunds: 0,
      currentBalance: 0,
      stockStatus: 0,
      totalRequests: requests.length,
      anomaliesDetected: anomalies.length,
      pendingOrders,
      ordersOverTime: this.groupByDate(orders),
      costsByDate: [],
      ordersByStore: [],
      costsByStore: [],
      costDistribution: [],
      stockByProduct: [],
      ordersByStatus: this.groupByField(orders, 'status'),
      requestsOverview: this.groupByField(requests, 'status'),
      anomaliesBySeverity: this.groupByField(anomalies, 'severity'),
      recentActivity: this.getRecentActivity(orders, requests, anomalies),
      attentionRequired: this.getAttentionItems(
        pendingOrders,
        openRequests,
        unresolvedAnomalies,
      ),
      filterOptions: {
        brands: [],
        stores: [],
        skus: [],
        invoices: [],
        orderNumbers: [],
        trackingNumbers: [],
        dates: [],
      },
    };
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
      const latestWallet = parsedImports
        .flatMap((item) => item.walletTransactions ?? [])
        .reverse()
        .find((transaction) => typeof transaction.runningBalance === 'number');
      const productCosts = this.round(
        filteredLines.reduce((total, line) => total + line.productCost, 0),
      );
      const shippingCosts = this.round(
        filteredLines.reduce((total, line) => total + line.shippingCost, 0),
      );
      const handlingCosts = this.round(
        filteredLines.reduce((total, line) => total + line.handlingCost, 0),
      );
      const totalCosts = this.round(
        filteredLines.reduce((total, line) => total + line.totalCost, 0),
      );
      const refunds = this.round(
        filteredInvoices.reduce((total, invoice) => total + invoice.refunds, 0),
      );

      return {
        totalOrders: filteredOrders.length,
        totalShipments: filteredOrders.reduce(
          (total, order) => total + (order.shipments?.length ?? 0),
          0,
        ),
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
  ): Promise<DashboardSummary | null> {
    try {
      const dateFilter = this.dateFilter(filters.dateFrom, filters.dateTo);
      const storeFilter = {
        ...(filters.store
          ? { normalizedName: this.normalizeStoreName(filters.store) }
          : {}),
        ...(filters.brand ? { brand: { name: filters.brand } } : {}),
      };
      const orderWhere = {
        ...(Object.keys(storeFilter).length ? { store: storeFilter } : {}),
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
        ...(filters.sku
          ? {
              lines: {
                some: {
                  sku: { contains: filters.sku, mode: 'insensitive' as const },
                },
              },
            }
          : {}),
        ...(filters.trackingNumber
          ? {
              shipments: {
                some: {
                  trackingNumber: {
                    contains: filters.trackingNumber,
                    mode: 'insensitive' as const,
                  },
                },
              },
            }
          : {}),
      };
      const invoiceWhere = {
        ...(Object.keys(storeFilter).length ? { store: storeFilter } : {}),
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
      const lineWhere = { order: orderWhere };

      const [
        orders,
        invoices,
        shipments,
        lines,
        stockMovements,
        walletTransactions,
        anomalies,
        brands,
        stores,
        aliases,
        shipmentRecords,
      ] = await Promise.all([
        this.prisma.order.findMany({
          where: orderWhere,
          select: {
            id: true,
            externalOrderNumber: true,
            orderDate: true,
            createdAt: true,
            store: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 5000,
        }),
        this.prisma.fulfillmentInvoice.findMany({
          where: invoiceWhere,
          select: {
            invoiceReference: true,
            invoiceDate: true,
            total: true,
            refunds: true,
            store: { select: { name: true } },
          },
          take: 5000,
        }),
        this.prisma.shipment.count({
          where: { order: orderWhere },
        }),
        this.prisma.orderLine.findMany({
          where: lineWhere,
          select: {
            sku: true,
            productCost: true,
            shippingCost: true,
            handlingCost: true,
            totalCost: true,
            order: {
              select: {
                orderDate: true,
                store: { select: { name: true } },
              },
            },
          },
          take: 10000,
        }),
        this.prisma.inventoryMovement.findMany({
          select: {
            quantity: true,
            movementType: true,
            product: { select: { name: true } },
          },
          take: 10000,
        }),
        this.prisma.walletTransaction.findMany({
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { runningBalance: true },
        }),
        this.prisma.anomaly.findMany({
          select: { id: true, severity: true, createdAt: true, message: true },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
        this.prisma.brand.findMany({
          select: { name: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.store.findMany({
          select: { name: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.productSkuAlias.findMany({
          select: { sku: true },
          orderBy: { sku: 'asc' },
          take: 500,
        }),
        this.prisma.shipment.findMany({
          where: { order: orderWhere },
          select: { trackingNumber: true },
          orderBy: { trackingNumber: 'asc' },
          take: 500,
        }),
      ]);

      const productCosts = this.round(
        lines.reduce((total, line) => total + line.productCost, 0),
      );
      const shippingCosts = this.round(
        lines.reduce((total, line) => total + line.shippingCost, 0),
      );
      const handlingCosts = this.round(
        lines.reduce((total, line) => total + line.handlingCost, 0),
      );
      const totalCosts = this.round(
        lines.reduce((total, line) => total + line.totalCost, 0),
      );
      const refunds = this.round(
        invoices.reduce((total, invoice) => total + invoice.refunds, 0),
      );
      const stockStatus = this.round(
        stockMovements.reduce((total, movement) => {
          const sign =
            movement.movementType === 'consumption' ||
            movement.movementType === 'used'
              ? -1
              : 1;
          return total + movement.quantity * sign;
        }, 0),
      );

      return {
        totalOrders: orders.length,
        totalShipments: shipments,
        totalInvoices: invoices.length,
        totalCosts,
        productCosts,
        shippingCosts,
        handlingCosts,
        refunds,
        currentBalance: walletTransactions[0]?.runningBalance ?? 0,
        stockStatus,
        totalRequests: 0,
        anomaliesDetected: anomalies.length,
        pendingOrders: 0,
        ordersOverTime: this.groupRecordsByDate(
          orders.map((order) => ({ date: order.orderDate })),
        ),
        costsByDate: this.groupCostByDate(lines),
        ordersByStore: this.groupCountByLabel(
          orders.map((order) => order.store.name),
        ),
        costsByStore: this.groupCostByStore(lines),
        costDistribution: [
          { label: 'Product', total: productCosts },
          { label: 'Shipping', total: shippingCosts },
          { label: 'Handling', total: handlingCosts },
          { label: 'Refunds', total: Math.abs(refunds) },
        ].filter((item) => item.total > 0),
        stockByProduct: this.groupStockByProduct(stockMovements),
        ordersByStatus: [],
        requestsOverview: [],
        anomaliesBySeverity: this.groupByField(anomalies, 'severity'),
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
          invoices: invoices
            .map((invoice) => invoice.invoiceReference)
            .filter(Boolean)
            .slice(0, 500),
          orderNumbers: orders
            .map((order) => order.externalOrderNumber)
            .filter(Boolean)
            .slice(0, 500),
          trackingNumbers: shipmentRecords
            .map((shipment) => shipment.trackingNumber)
            .filter(Boolean),
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
      };
    } catch {
      return null;
    }
  }

  private async getRows(table: string, select: string): Promise<DatabaseRow[]> {
    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return [];
    }

    try {
      const params = new URLSearchParams({
        select,
        limit: '1000',
        order: 'created_at.desc',
      });
      const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${params}`, {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      });

      if (!response.ok) {
        return [];
      }

      const rows = (await response.json()) as DatabaseRow[];

      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  private countByValues(
    rows: DatabaseRow[],
    field: 'status' | 'severity',
    values: string[],
  ): number {
    const acceptedValues = new Set(values.map((value) => value.toLowerCase()));

    return rows.filter((row) => {
      const value = row[field]?.toLowerCase();

      return value ? acceptedValues.has(value) : false;
    }).length;
  }

  private groupByField(
    rows: DatabaseRow[],
    field: 'status' | 'severity',
  ): ChartPoint[] {
    const groups = rows.reduce<Record<string, number>>((totals, row) => {
      const label = this.formatLabel(row[field] || 'unknown');
      totals[label] = (totals[label] ?? 0) + 1;

      return totals;
    }, {});

    return Object.entries(groups).map(([label, total]) => ({ label, total }));
  }

  private groupByDate(rows: DatabaseRow[]): ChartPoint[] {
    const groups = rows.reduce<Record<string, number>>((totals, row) => {
      if (!row.created_at) {
        return totals;
      }

      const label = new Date(row.created_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
      totals[label] = (totals[label] ?? 0) + 1;

      return totals;
    }, {});

    return Object.entries(groups)
      .map(([label, total]) => ({ label, total }))
      .slice(-7);
  }

  private getRecentActivity(
    orders: DatabaseRow[],
    requests: DatabaseRow[],
    anomalies: DatabaseRow[],
  ): ActivityItem[] {
    return [
      ...this.toActivityItems(orders, 'Order'),
      ...this.toActivityItems(requests, 'Request'),
      ...this.toActivityItems(anomalies, 'Anomaly'),
    ]
      .sort((first, second) => {
        const firstDate = first.createdAt
          ? new Date(first.createdAt).getTime()
          : 0;
        const secondDate = second.createdAt
          ? new Date(second.createdAt).getTime()
          : 0;

        return secondDate - firstDate;
      })
      .slice(0, 5);
  }

  private toActivityItems(rows: DatabaseRow[], type: string): ActivityItem[] {
    return rows
      .filter((row) => row.id)
      .map((row) => ({
        id: `${type.toLowerCase()}-${row.id}`,
        type,
        title: `${type} ${row.id}`,
        createdAt: row.created_at ?? null,
      }));
  }

  private getAttentionItems(
    pendingOrders: number,
    openRequests: number,
    unresolvedAnomalies: number,
  ): AttentionItem[] {
    return [
      { label: 'Pending orders', total: pendingOrders },
      { label: 'Open requests', total: openRequests },
      { label: 'Unresolved anomalies', total: unresolvedAnomalies },
    ].filter((item) => item.total > 0);
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

  private normalizeStoreName(value: string) {
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private toDateOption(value: string | Date | null | undefined) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
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
