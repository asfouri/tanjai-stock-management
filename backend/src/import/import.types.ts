export type SheetType =
  | 'quotation'
  | 'store_orders'
  | 'stock_invoice'
  | 'stock_list'
  | 'payment_balance'
  | 'unknown';

export type SourceRef = {
  sourceSheet: string;
  sourceRow: number;
};

export type ParsedStore = {
  name: string;
  normalizedName: string;
  country?: string;
  platform?: string;
};

export type ParsedProduct = {
  name: string;
  description?: string;
  weight?: number;
  sku?: string;
  storeName?: string;
};

export type ParsedOrderLine = SourceRef & {
  sku: string;
  quantity: number;
  productCost: number;
  shippingCost: number;
  handlingCost: number;
  totalCost: number;
};

export type ParsedShipment = SourceRef & {
  trackingNumber: string;
};

export type ParsedOrder = SourceRef & {
  storeName: string;
  externalOrderNumber: string;
  orderDate?: Date;
  invoiceReference: string;
  lines: ParsedOrderLine[];
  shipments: ParsedShipment[];
};

export type ParsedFulfillmentInvoice = SourceRef & {
  storeName: string;
  invoiceReference: string;
  invoiceDate?: Date;
  subtotal: number;
  refunds: number;
  adjustments: number;
  total: number;
};

export type ParsedStockPurchase = SourceRef & {
  sku?: string;
  productName?: string;
  purchaseDate?: Date;
  quantity: number;
  unitCost?: number;
  totalCost: number;
};

export type ParsedInventoryMovement = SourceRef & {
  productName?: string;
  storeName?: string;
  movementDate?: Date;
  movementType: string;
  quantity: number;
  reference?: string;
  comment?: string;
};

export type ParsedWalletTransaction = SourceRef & {
  storeName?: string;
  transactionDate?: Date;
  transactionType: string;
  invoiceReference?: string;
  amount: number;
  runningBalance?: number;
};

export type ImportWarning = SourceRef & {
  message: string;
  severity: 'info' | 'warning' | 'error';
};

export type ParsedImport = {
  fileName: string;
  fileHash: string;
  brandName?: string;
  sheets: Array<{
    name: string;
    type: SheetType;
    rows: number;
    invoiceBlocks?: number;
  }>;
  stores: ParsedStore[];
  products: ParsedProduct[];
  orders: ParsedOrder[];
  invoices: ParsedFulfillmentInvoice[];
  stockPurchases: ParsedStockPurchase[];
  inventoryMovements: ParsedInventoryMovement[];
  walletTransactions: ParsedWalletTransaction[];
  warnings: ImportWarning[];
};

export type ImportPreview = {
  token: string;
  fileName: string;
  fileHash: string;
  detectedSheets: ParsedImport['sheets'];
  stores: ParsedStore[];
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
  warnings: ImportWarning[];
};
