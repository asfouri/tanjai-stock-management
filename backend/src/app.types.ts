export type ChartPoint = {
  label: string;
  total: number;
};

export type ActivityItem = {
  id: string;
  type: string;
  title: string;
  createdAt: string | null;
};

export type AttentionItem = {
  label: string;
  total: number;
};

export type DashboardFilters = {
  brand?: string;
  store?: string;
  dateFrom?: string;
  dateTo?: string;
  invoiceDateFrom?: string;
  invoiceDateTo?: string;
  sku?: string;
  invoice?: string;
  orderNumber?: string;
  trackingNumber?: string;
  country?: string;
  orderSearch?: string;
  orderSort?: 'asc' | 'desc' | '';
  orderPage?: string;
};

export type DashboardDebugCounts = {
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

export type DashboardSummary = {
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
    countries: string[];
    dates: string[];
  };
  debugCounts?: DashboardDebugCounts;
};

export type DashboardSection = {
  title: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<
    Record<
      string,
      string | number | boolean | string[] | Record<string, unknown> | null
    >
  >;
  totalRows?: number;
  page?: number;
  pageSize?: number;
  meta?: Record<string, string | number | boolean | null>;
};
