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

export type FilterOptions = {
  brands: string[];
  stores: string[];
  skus: string[];
  invoices: string[];
  orderNumbers: string[];
  trackingNumbers: string[];
  countries: string[];
  dates: string[];
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
  filterOptions: FilterOptions;
  debugCounts?: {
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
};

export type ImportPreview = {
  token: string;
  fileName: string;
  detectedSheets: Array<{
    name: string;
    type: string;
    rows: number;
    invoiceBlocks?: number;
  }>;
  stores: Array<{ name: string; normalizedName: string }>;
  counts: {
    orders: number;
    invoices: number;
    shipments: number;
    refunds: number;
    stockPurchases: number;
    stockMovements: number;
    walletTransactions: number;
    warnings: number;
    duplicateRecords: number;
  };
  totals: {
    productCosts: number;
    shippingCosts: number;
    handlingCosts: number;
    invoiceCosts: number;
    refunds: number;
    currentBalance: number | null;
  };
  duplicateRecords: string[];
  warnings: Array<{
    sourceSheet: string;
    sourceRow: number;
    severity: string;
    message: string;
  }>;
};

export type Filters = {
  brand: string;
  store: string;
  dateFrom: string;
  dateTo: string;
  invoiceDateFrom: string;
  invoiceDateTo: string;
  sku: string;
  invoice: string;
  orderNumber: string;
  trackingNumber: string;
  trackingStatus: string;
  trackingCarrier: string;
  trackingPresence: "HAS" | "MISSING" | "";
  trackingIssue: "DELIVERED" | "EXCEPTION" | "REGISTRATION_ERROR" | "";
  country: string;
  orderSearch: string;
  orderSort: "asc" | "desc" | "";
  orderProvider: "EXCEL" | "WOOCOMMERCE";
  paymentType: "Deposit" | "Spent" | "";
};

export type TrackingEvent = {
  id: string;
  eventTime: string | null;
  eventTimeUtc: string | null;
  description: string | null;
  location: string | null;
  status?: string | null;
  subStatus: string | null;
  stage: string | null;
  carrierCode?: number | null;
  carrierName?: string | null;
  source?: string;
};

export type TrackingShipment = {
  id: string;
  trackingNumber: string;
  carrierCode: number | null;
  carrierName: string | null;
  registrationStatus: string;
  status: string | null;
  subStatus: string | null;
  registeredAt: string | null;
  lastRequestedAt: string | null;
  lastWebhookAt: string | null;
  latestEventAt: string | null;
  latestEventDescription: string | null;
  latestEventLocation: string | null;
  deliveredAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  events: TrackingEvent[];
};

export type AuthenticatedUser = {
  id?: string;
  email: string;
  role: string;
  storeIds: string[];
};

export type ManagedUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  storeIds: string[];
  createdAt: string;
  lastSignInAt: string | null;
};

export type UserStoreOption = {
  id: string;
  name: string;
};

export type SectionId =
  | "dashboard"
  | "imports"
  | "products"
  | "products-without-skus"
  | "orders"
  | "inventory"
  | "stores"
  | "invoices"
  | "payments"
  | "integrations"
  | "users";

export type SectionData = {
  title: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<
    Record<
      string,
      | string
      | number
      | boolean
      | string[]
      | ProductQuotation
      | ProductRow
      | TrackingShipment[]
      | null
    >
  >;
  totalRows?: number;
  page?: number;
  pageSize?: number;
  meta?: Record<string, string | number | boolean | null>;
  groups?: Array<{ id: string; name: string }>;
};

export type ProductQuotation = {
  productGroup?: string;
  unitPrice?: number;
  weight?: number;
  moq?: string;
  quantity?: number;
  quantityConditions?: string[];
  freightByCountry?: Array<{ country: string; amount: number }>;
  serviceFee?: number;
  landedCost?: number;
  landedCostByCountry?: Array<{ country: string; amount: number }>;
  deliveryTime?: string;
  sellingPrice?: number;
  stockNotes?: string[];
  notes?: string[];
  quotationRows?: QuotationOfferRow[];
  priceTiers?: Array<{
    quantity?: number;
    unitPrice?: number;
    landedCost?: number;
    sellingPrice?: number;
  }>;
  retired?: boolean;
};

export type QuotationOfferRow = {
  sourceKey?: string;
  sourceSheet?: string;
  sourceRow?: number;
  quantityLabel?: string | number;
  quantity?: string | number;
  unitPrice?: string | number;
  weight?: string | number;
  freightFR?: string | number;
  freightDE?: string | number;
  freightGB?: string | number;
  freightUSA?: string | number;
  serviceFee?: string | number;
  totalCostFR?: string | number;
  totalCostDE?: string | number;
  totalCostGB?: string | number;
  totalCostUSA?: string | number;
  deliveryTime?: string | number;
  sellingPrice?: string | number;
  notes?: string;
};

export type ProductMovement = {
  date?: string;
  type?: string;
  movementType?: string;
  quantity?: number;
  reference?: string;
  comment?: string;
};

export type ProductRow = {
  id?: string;
  groupId?: string | null;
  inventoryItemId?: string;
  name: string;
  description?: string;
  imageUrl?: string | null;
  skuAliases?: string[];
  skuAssignments?: Array<{
    id?: string;
    sku: string;
    storeId?: string | null;
    storeName?: string | null;
  }>;
  stores?: string[];
  skus?: string;
  weight: number | string | null;
  orderLines: number;
  stockPurchases: number;
  inventoryMovements?: number;
  currentInventory?: number;
  movements?: ProductMovement[];
  quotation?: ProductQuotation | null;
};

export type ImportBatchRow = {
  id: string;
  fileName: string;
  fileHash: string;
  fileHashStatus: string;
  status: string;
  importedAt: string;
  orders: number;
  invoices: number;
  products: number;
  stockPurchases: number;
  inventoryMovements: number;
  walletTransactions: number;
  warnings: number;
  anomalies: number;
  duplicates: number;
};
