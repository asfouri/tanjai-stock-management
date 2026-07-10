import type { User } from "@supabase/supabase-js";
import type {
  DashboardSummary,
  ProductRow,
  QuotationOfferRow,
} from "./types";

export const emptySummary: DashboardSummary = {
  totalOrders: 0,
  totalShipments: 0,
  totalInvoices: 0,
  totalCosts: 0,
  productCosts: 0,
  shippingCosts: 0,
  handlingCosts: 0,
  refunds: 0,
  currentBalance: 0,
  stockStatus: 0,
  totalRequests: 0,
  anomaliesDetected: 0,
  pendingOrders: 0,
  ordersOverTime: [],
  costsByDate: [],
  ordersByStore: [],
  costsByStore: [],
  costDistribution: [],
  stockByProduct: [],
  ordersByStatus: [],
  requestsOverview: [],
  anomaliesBySeverity: [],
  recentActivity: [],
  attentionRequired: [],
  filterOptions: {
    brands: [],
    stores: [],
    skus: [],
    invoices: [],
    orderNumbers: [],
    trackingNumbers: [],
    countries: [],
    dates: [],
  },
};

export function getUserDisplayName(user: User | null) {
  const firstName = user?.user_metadata?.first_name;
  const lastName = user?.user_metadata?.last_name;
  const fullName = [firstName, lastName].filter(Boolean).join(" ");

  return fullName || user?.email || "User";
}

export function normalizeSummary(
  summary: Partial<DashboardSummary>,
): DashboardSummary {
  return {
    ...emptySummary,
    ...summary,
    filterOptions: {
      ...emptySummary.filterOptions,
      ...summary.filterOptions,
    },
  };
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
    value,
  );
}

export function formatDate(value: string | null) {
  if (!value) return "No date";

  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatCellValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "-";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function cleanKeyPart(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function uniqueNonEmptyStrings(
  values: Array<string | number | null | undefined> = [],
) {
  const seen = new Set<string>();
  const items: string[] = [];

  for (const value of values) {
    const item = cleanKeyPart(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    items.push(item);
  }

  return items;
}

export function uniqueByKey<T>(items: T[], getKey: (item: T) => string | null) {
  const seen = new Set<string>();
  const uniqueItems: T[] = [];

  for (const item of items) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueItems.push(item);
  }

  return uniqueItems;
}

export function productRowKey(product: ProductRow) {
  const id = cleanKeyPart(product.id);
  if (id) return id;

  const name = cleanKeyPart(product.name);
  return name ? `product-name:${name}` : null;
}

export function quotationRowKey(row: QuotationOfferRow) {
  const sourceKey = cleanKeyPart(row.sourceKey);
  if (sourceKey) return sourceKey;

  const sourceSheet = cleanKeyPart(row.sourceSheet);
  if (sourceSheet && row.sourceRow !== null && row.sourceRow !== undefined) {
    return `${sourceSheet}-${row.sourceRow}`;
  }

  return null;
}

export function recordRowKey(row: Record<string, unknown>) {
  const id = cleanKeyPart(row.id);
  if (id) return id;

  const stableValue = JSON.stringify(row);
  return stableValue === "{}" ? null : stableValue;
}
