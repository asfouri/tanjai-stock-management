"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import {
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

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

type FilterOptions = {
  brands: string[];
  stores: string[];
  skus: string[];
  invoices: string[];
  orderNumbers: string[];
  trackingNumbers: string[];
  dates: string[];
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

type ImportPreview = {
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

type Filters = {
  brand: string;
  store: string;
  dateFrom: string;
  dateTo: string;
  sku: string;
  invoice: string;
  orderNumber: string;
  trackingNumber: string;
};

type SectionId =
  | "dashboard"
  | "imports"
  | "products"
  | "orders"
  | "inventory"
  | "stores"
  | "invoices"
  | "payments";

type SectionData = {
  title: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string | number | string[] | ProductQuotation | null>>;
};

type ProductQuotation = {
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

type QuotationOfferRow = {
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

type ProductRow = {
  id?: string;
  name: string;
  description?: string;
  imageUrl?: string | null;
  skuAliases?: string[];
  stores?: string[];
  skus?: string;
  weight: number | string | null;
  orderLines: number;
  stockPurchases: number;
  inventoryMovements?: number;
  currentInventory?: number;
  quotation?: ProductQuotation | null;
};

type ImportBatchRow = {
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

const emptySummary: DashboardSummary = {
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
    dates: [],
  },
};

const initialFilters: Filters = {
  brand: "",
  store: "",
  dateFrom: "",
  dateTo: "",
  sku: "",
  invoice: "",
  orderNumber: "",
  trackingNumber: "",
};

const sidebarItems: Array<{ id: SectionId; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "imports", label: "Imports" },
  { id: "products", label: "Products" },
  { id: "orders", label: "Orders" },
  { id: "inventory", label: "Inventory" },
  { id: "stores", label: "Stores" },
  { id: "invoices", label: "Invoices" },
  { id: "payments", label: "Payments" },
];

const chartColors = ["#18181b", "#0f766e", "#b45309", "#991b1b", "#52525b"];

const apiBaseUrl = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3005"
).replace(/\/$/, "");

async function responseErrorMessage(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  const message = body?.message;
  if (Array.isArray(message)) return message.join(" ");
  return typeof message === "string" && message.trim() ? message : fallback;
}

function getUserDisplayName(user: User | null) {
  const firstName = user?.user_metadata?.first_name;
  const lastName = user?.user_metadata?.last_name;
  const fullName = [firstName, lastName].filter(Boolean).join(" ");

  return fullName || user?.email || "User";
}

function normalizeSummary(summary: Partial<DashboardSummary>): DashboardSummary {
  return {
    ...emptySummary,
    ...summary,
    filterOptions: {
      ...emptySummary.filterOptions,
      ...summary.filterOptions,
    },
  };
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
    value
  );
}

function formatDate(value: string | null) {
  if (!value) return "No date";

  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatCellValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "-";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function cleanKeyPart(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function uniqueNonEmptyStrings(values: Array<string | number | null | undefined> = []) {
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

function uniqueByKey<T>(items: T[], getKey: (item: T) => string | null) {
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

function productRowKey(product: ProductRow) {
  const id = cleanKeyPart(product.id);
  if (id) return id;

  const name = cleanKeyPart(product.name);
  return name ? `product-name:${name}` : null;
}

function quotationRowKey(row: QuotationOfferRow) {
  const sourceKey = cleanKeyPart(row.sourceKey);
  if (sourceKey) return sourceKey;

  const sourceSheet = cleanKeyPart(row.sourceSheet);
  if (sourceSheet && row.sourceRow !== null && row.sourceRow !== undefined) {
    return `${sourceSheet}-${row.sourceRow}`;
  }

  return null;
}

function recordRowKey(row: Record<string, unknown>) {
  const id = cleanKeyPart(row.id);
  if (id) return id;

  const stableValue = JSON.stringify(row);
  return stableValue === "{}" ? null : stableValue;
}

function ProductImage({
  src,
  alt,
  size,
}: {
  src?: string | null;
  alt: string;
  size: "small" | "large";
}) {
  const hasImage = Boolean(cleanKeyPart(src));
  const className =
    size === "large"
      ? "h-56 w-full max-w-sm rounded-md border border-zinc-200 object-contain"
      : "h-14 w-14 rounded-md border border-zinc-200 object-contain";

  if (hasImage) {
    return (
      <img
        alt={alt}
        className={`${className} bg-white`}
        loading="lazy"
        src={src ?? undefined}
      />
    );
  }

  return (
    <div
      aria-label="No product image"
      className={`${className} flex items-center justify-center bg-zinc-50 text-xs font-medium text-zinc-400`}
      role="img"
    >
      No image
    </div>
  );
}

function Panel({
  title,
  children,
}: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <section className="min-w-0 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-5 min-w-0">{children}</div>
    </section>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-52 items-center justify-center rounded-md border border-dashed border-zinc-200 text-sm text-zinc-500">
      {label}
    </div>
  );
}

function FilterSelect({
  label,
  placeholder,
  value,
  options,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const normalizedOptions = uniqueNonEmptyStrings(options);

  return (
    <label className="grid gap-1 text-xs font-medium text-zinc-500">
      {label}
      <select
        className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none transition focus:border-zinc-900"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {normalizedOptions.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function FilterInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-zinc-500">
      {label}
      <input
        className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none transition focus:border-zinc-900"
        placeholder={placeholder}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>("dashboard");
  const [summary, setSummary] = useState<DashboardSummary>(emptySummary);
  const [sectionData, setSectionData] = useState<SectionData | null>(null);
  const [importBatches, setImportBatches] = useState<ImportBatchRow[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [productPage, setProductPage] = useState(1);
  const [selectedProduct, setSelectedProduct] = useState<ProductRow | null>(null);
  const [selectedImportAction, setSelectedImportAction] = useState<{
    batch: ImportBatchRow;
    mode: "remove" | "replace";
  } | null>(null);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [isLoading, setIsLoading] = useState(true);
  const [isSectionLoading, setIsSectionLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isRemovingImport, setIsRemovingImport] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [importErrorMessage, setImportErrorMessage] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const filterQuery = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value.trim()) params.set(key, value.trim());
    }
    return params.toString();
  }, [filters]);

  useEffect(() => {
    let isMounted = true;

    async function loadDashboard() {
      try {
        const supabase = getSupabaseBrowserClient();
        const { data, error } = await supabase.auth.getUser();

        if (error || !data.user) {
          router.replace("/login");
          return;
        }

        if (isMounted) setUser(data.user);

        const session = await supabase.auth.getSession();
        const response = await fetch(
          `${apiBaseUrl}/dashboard/summary${filterQuery ? `?${filterQuery}` : ""}`,
          {
            headers: session.data.session?.access_token
              ? { Authorization: `Bearer ${session.data.session.access_token}` }
              : undefined,
          }
        );

        if (!response.ok) {
          throw new Error(
            await responseErrorMessage(response, "Unable to load dashboard summary.")
          );
        }

        const dashboardSummary =
          (await response.json()) as Partial<DashboardSummary>;

        if (isMounted) setSummary(normalizeSummary(dashboardSummary));
      } catch (error) {
        if (isMounted) {
          setErrorMessage(
            error instanceof Error ? error.message : "Unable to load dashboard."
          );
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    loadDashboard();

    return () => {
      isMounted = false;
    };
  }, [filterQuery, router, refreshKey]);

  useEffect(() => {
    if (activeSection === "dashboard") {
      setSectionData(null);
      return;
    }

    let isMounted = true;

    async function loadSection() {
      setIsSectionLoading(true);
      setErrorMessage("");

      try {
        if (activeSection === "imports") {
          const response = await fetch(`${apiBaseUrl}/imports/excel/history`);
          if (!response.ok) {
            throw new Error(
              await responseErrorMessage(response, "Unable to load import history.")
            );
          }
          const data = (await response.json()) as ImportBatchRow[];
          if (isMounted) {
            setImportBatches(data);
            setSectionData(null);
          }
          return;
        }

        const response = await fetch(
          `${apiBaseUrl}/dashboard/section/${activeSection}`
        );

        if (!response.ok) {
          throw new Error(
            await responseErrorMessage(response, "Unable to load section data.")
          );
        }

        const data = (await response.json()) as SectionData;
        if (isMounted) setSectionData(data);
      } catch (error) {
        if (isMounted) {
          setErrorMessage(
            error instanceof Error ? error.message : "Unable to load section."
          );
        }
      } finally {
        if (isMounted) setIsSectionLoading(false);
      }
    }

    loadSection();

    return () => {
      isMounted = false;
    };
  }, [activeSection, refreshKey]);

  useEffect(() => {
    setProductPage(1);
  }, [productSearch, sectionData]);

  async function refreshDashboard() {
    setIsLoading(true);
    const response = await fetch(
      `${apiBaseUrl}/dashboard/summary${filterQuery ? `?${filterQuery}` : ""}`
    );
    if (response.ok) {
      setSummary(normalizeSummary(await response.json()));
    } else {
      setErrorMessage(
        await responseErrorMessage(response, "Unable to load dashboard summary.")
      );
    }
    setIsLoading(false);
  }

  async function handleLogout() {
    setErrorMessage("");
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setErrorMessage("Only .xlsx files can be uploaded.");
      return;
    }

    setIsImporting(true);
    setErrorMessage("");

    try {
      const response = await fetch(`${apiBaseUrl}/imports/excel/preview-local`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fileName: file.name }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message ?? "Unable to parse Excel file.");
      }

      setImportErrorMessage("");
      setPreview((await response.json()) as ImportPreview);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to upload Excel file."
      );
    } finally {
      setIsImporting(false);
    }
  }

  async function confirmImport() {
    if (!preview) return;

    setIsImporting(true);
    setImportErrorMessage("");

    try {
      const response = await fetch(`${apiBaseUrl}/imports/excel/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: preview.token }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message ?? "Unable to save import.");
      }

      setPreview(null);
      await refreshDashboard();
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setImportErrorMessage(
        error instanceof Error ? error.message : "Unable to confirm import."
      );
    } finally {
      setIsImporting(false);
    }
  }

  async function confirmImportAction() {
    if (!selectedImportAction) return;

    setIsRemovingImport(true);
    setErrorMessage("");

    try {
      const response = await fetch(`${apiBaseUrl}/imports/excel/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importBatchId: selectedImportAction.batch.id }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message ?? "Unable to remove import.");
      }

      const shouldOpenUpload = selectedImportAction.mode === "replace";
      setSelectedImportAction(null);
      await refreshDashboard();
      setRefreshKey((value) => value + 1);

      if (shouldOpenUpload) {
        window.setTimeout(() => fileInputRef.current?.click(), 0);
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to remove import."
      );
    } finally {
      setIsRemovingImport(false);
    }
  }

  const cards = [
    ["Orders", formatNumber(summary.totalOrders)],
    ["Shipments", formatNumber(summary.totalShipments)],
    ["Invoices", formatNumber(summary.totalInvoices)],
    ["Total costs", formatCurrency(summary.totalCosts)],
    ["Current balance", formatCurrency(summary.currentBalance)],
    ["Anomalies", formatNumber(summary.anomaliesDetected)],
  ];

  return (
    <main className="min-h-screen overflow-x-hidden bg-zinc-50 text-zinc-950">
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-zinc-200 bg-white px-5 py-6 md:flex">
        <div className="text-lg font-semibold">TanjAI Stock</div>
        <nav className="mt-8 space-y-1" aria-label="Dashboard sections">
          {sidebarItems.map((item) => {
            const isActive = item.id === activeSection;

            return (
              <button
                className={`h-10 w-full rounded-md px-3 text-left text-sm font-medium transition ${
                  isActive
                    ? "bg-zinc-950 text-white"
                    : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950"
                }`}
                key={item.id}
                type="button"
                onClick={() => setActiveSection(item.id)}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
        <button
          className="mt-auto h-10 rounded-md border border-zinc-300 text-sm font-medium transition hover:bg-zinc-50"
          type="button"
          onClick={handleLogout}
        >
          Logout
        </button>
      </aside>

      <div className="min-w-0 md:pl-64">
        <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 px-5 py-4 backdrop-blur md:px-8">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 md:hidden">
                TanjAI Stock
              </p>
              <h1 className="text-2xl font-semibold">
                {sidebarItems.find((item) => item.id === activeSection)?.label ??
                  "Dashboard"}
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <p className="truncate text-sm text-zinc-600">
                {getUserDisplayName(user)}
              </p>
              <input
                ref={fileInputRef}
                hidden
                accept=".xlsx"
                type="file"
                onChange={handleUpload}
              />
              <button
                className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
                type="button"
                disabled={isImporting}
                onClick={() => fileInputRef.current?.click()}
              >
                {isImporting ? "Processing..." : "Upload Excel"}
              </button>
              <button
                className="h-10 rounded-md border border-zinc-300 bg-white px-4 text-sm font-medium transition hover:bg-zinc-50 md:hidden"
                type="button"
                onClick={handleLogout}
              >
                Logout
              </button>
            </div>
          </div>
        </header>

        <section className="min-w-0 space-y-5 px-5 py-6 md:px-8">
          {errorMessage ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-700">
              {errorMessage}
            </div>
          ) : null}

          {activeSection === "dashboard" ? (
            <>
              <Panel title="Filters">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <FilterSelect
                    label="Brand"
                    placeholder="All brands"
                    options={summary.filterOptions.brands}
                    value={filters.brand}
                    onChange={(value) => setFilters({ ...filters, brand: value })}
                  />
                  <FilterSelect
                    label="Store"
                    placeholder="All stores"
                    options={summary.filterOptions.stores}
                    value={filters.store}
                    onChange={(value) => setFilters({ ...filters, store: value })}
                  />
                  <FilterInput
                    label="Date from"
                    type="date"
                    value={filters.dateFrom}
                    onChange={(value) =>
                      setFilters({ ...filters, dateFrom: value })
                    }
                  />
                  <FilterInput
                    label="Date to"
                    type="date"
                    value={filters.dateTo}
                    onChange={(value) => setFilters({ ...filters, dateTo: value })}
                  />
                  <FilterSelect
                    label="SKU"
                    placeholder="All SKUs"
                    options={summary.filterOptions.skus}
                    value={filters.sku}
                    onChange={(value) => setFilters({ ...filters, sku: value })}
                  />
                  <FilterSelect
                    label="Invoice"
                    placeholder="All invoices"
                    options={summary.filterOptions.invoices}
                    value={filters.invoice}
                    onChange={(value) => setFilters({ ...filters, invoice: value })}
                  />
                  <FilterInput
                    label="Order number"
                    placeholder="Search order number"
                    value={filters.orderNumber}
                    onChange={(value) =>
                      setFilters({ ...filters, orderNumber: value })
                    }
                  />
                  <FilterInput
                    label="Tracking number"
                    placeholder="Search tracking number"
                    value={filters.trackingNumber}
                    onChange={(value) =>
                      setFilters({ ...filters, trackingNumber: value })
                    }
                  />
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    className="h-10 rounded-md border border-zinc-300 px-4 text-sm font-medium transition hover:bg-zinc-50"
                    type="button"
                    onClick={() => setFilters(initialFilters)}
                  >
                    Clear
                  </button>
                </div>
              </Panel>

              {isLoading ? (
                <div className="rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-600">
                  Loading dashboard...
                </div>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
                    {cards.map(([title, value]) => (
                      <article
                        className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm"
                        key={title}
                      >
                        <p className="text-sm font-medium text-zinc-500">
                          {title}
                        </p>
                        <p className="mt-4 text-2xl font-semibold">{value}</p>
                      </article>
                    ))}
                  </div>

                  <div className="grid gap-5 xl:grid-cols-2">
                    <Panel title="Orders by date">
                      <LinePanel
                        data={summary.ordersOverTime}
                        empty="No orders yet."
                      />
                    </Panel>
                    <Panel title="Costs by date">
                      <LinePanel data={summary.costsByDate} empty="No costs yet." />
                    </Panel>
                    <Panel title="Orders by store">
                      <BarPanel
                        data={summary.ordersByStore}
                        empty="No store orders yet."
                      />
                    </Panel>
                    <Panel title="Costs by store">
                      <BarPanel
                        data={summary.costsByStore}
                        empty="No store costs yet."
                      />
                    </Panel>
                    <Panel title="Cost distribution">
                      <PiePanel
                        data={summary.costDistribution}
                        empty="No costs yet."
                      />
                    </Panel>
                    <Panel title="Stock by product">
                      <BarPanel
                        data={summary.stockByProduct}
                        empty="No stock movements yet."
                      />
                    </Panel>
                    <Panel title="Cost summary">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Metric
                          label="Product costs"
                          value={formatCurrency(summary.productCosts)}
                        />
                        <Metric
                          label="Shipping costs"
                          value={formatCurrency(summary.shippingCosts)}
                        />
                        <Metric
                          label="Handling costs"
                          value={formatCurrency(summary.handlingCosts)}
                        />
                        <Metric
                          label="Refunds"
                          value={formatCurrency(summary.refunds)}
                        />
                        <Metric
                          label="Stock status"
                          value={formatNumber(summary.stockStatus)}
                        />
                      </div>
                    </Panel>
                    <Panel title="Attention required">
                      {summary.attentionRequired.length > 0 ? (
                        <div className="space-y-3">
                          {summary.attentionRequired.map((item) => (
                            <div
                              className="flex items-center justify-between rounded-md border border-zinc-200 px-4 py-3"
                              key={item.label}
                            >
                              <span className="text-sm font-medium">
                                {item.label}
                              </span>
                              <span className="text-sm text-zinc-500">
                                {item.total}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <EmptyState label="Nothing requires attention." />
                      )}
                    </Panel>
                    <Panel title="Recent activity">
                      {summary.recentActivity.length > 0 ? (
                        <div className="divide-y divide-zinc-100">
                          {summary.recentActivity.map((item) => (
                            <div
                              className="flex items-center justify-between gap-4 py-3"
                              key={item.id}
                            >
                              <div>
                                <p className="text-sm font-medium">{item.title}</p>
                                <p className="text-xs text-zinc-500">
                                  {item.type}
                                </p>
                              </div>
                              <p className="text-xs text-zinc-500">
                                {formatDate(item.createdAt)}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <EmptyState label="No recent activity." />
                      )}
                    </Panel>
                  </div>
                </>
              )}
            </>
          ) : (
            activeSection === "imports" ? (
              <ImportHistorySection
                imports={importBatches}
                isLoading={isSectionLoading}
                onRemove={(batch) =>
                  setSelectedImportAction({ batch, mode: "remove" })
                }
                onReplace={(batch) =>
                  setSelectedImportAction({ batch, mode: "replace" })
                }
              />
            ) : activeSection === "products" ? (
              <ProductsSection
                data={sectionData}
                isLoading={isSectionLoading}
                page={productPage}
                search={productSearch}
                onPageChange={setProductPage}
                onSearchChange={setProductSearch}
                onSelectProduct={setSelectedProduct}
              />
            ) : (
              <SectionTable
                data={sectionData}
                isLoading={isSectionLoading}
                title={
                  sidebarItems.find((item) => item.id === activeSection)?.label ??
                  "Section"
                }
              />
            )
          )}
        </section>
      </div>

      {preview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-lg bg-white p-5 shadow-xl">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Import preview</h2>
                <p className="mt-1 text-sm text-zinc-500">{preview.fileName}</p>
              </div>
              <button
                className="h-9 rounded-md border border-zinc-300 px-3 text-sm"
                type="button"
                onClick={() => {
                  setPreview(null);
                  setImportErrorMessage("");
                }}
              >
                Cancel
              </button>
            </div>

            {importErrorMessage ? (
              <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {importErrorMessage}
              </div>
            ) : null}

            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Orders" value={formatNumber(preview.counts.orders)} />
              <Metric label="Invoices" value={formatNumber(preview.counts.invoices)} />
              <Metric label="Shipments" value={formatNumber(preview.counts.shipments)} />
              <Metric label="Invoice costs" value={formatCurrency(preview.totals.invoiceCosts)} />
              <Metric label="Stock movements" value={formatNumber(preview.counts.stockMovements)} />
              <Metric label="Wallet entries" value={formatNumber(preview.counts.walletTransactions)} />
              <Metric label="Warnings" value={formatNumber(preview.counts.warnings)} />
              <Metric label="Duplicates" value={formatNumber(preview.counts.duplicateRecords)} />
            </div>

            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <PreviewList
                title="Detected sheets"
                items={preview.detectedSheets.map(
                  (sheet) =>
                    `${sheet.name} · ${sheet.type} · ${sheet.rows} rows${
                      sheet.invoiceBlocks ? ` · ${sheet.invoiceBlocks} invoices` : ""
                    }`
                )}
              />
              <PreviewList
                title="Detected stores"
                items={preview.stores.map((store) => store.name)}
              />
              <PreviewList
                title="Warnings"
                items={preview.warnings.map(
                  (item) =>
                    `${item.sourceSheet} row ${item.sourceRow}: ${item.message}`
                )}
              />
              <PreviewList title="Duplicate records" items={preview.duplicateRecords} />
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                className="h-10 rounded-md border border-zinc-300 px-4 text-sm font-medium transition hover:bg-zinc-50"
                type="button"
                onClick={() => {
                  setPreview(null);
                  setImportErrorMessage("");
                }}
              >
                Cancel
              </button>
              <button
                className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
                type="button"
                disabled={isImporting}
                onClick={confirmImport}
              >
                Confirm import
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedProduct ? (
        <ProductDetailsModal
          product={selectedProduct}
          onClose={() => setSelectedProduct(null)}
        />
      ) : null}

      {selectedImportAction ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4">
          <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-lg font-semibold">
              {selectedImportAction.mode === "replace"
                ? "Replace import"
                : "Remove import"}
            </h2>
            <p className="mt-2 text-sm text-zinc-600">
              This will remove the import batch for{" "}
              <span className="font-medium text-zinc-950">
                {selectedImportAction.batch.fileName}
              </span>
              . All data created by that import will be removed, including orders,
              order lines, shipments, invoices, stock purchases, inventory movements,
              wallet transactions, anomalies, unused product aliases, and catalog data
              that is not used by another active import.
            </p>
            {selectedImportAction.mode === "replace" ? (
              <p className="mt-3 text-sm text-zinc-600">
                After removal, the Excel upload picker will open so you can import the
                corrected file.
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-3">
              <button
                className="h-10 rounded-md border border-zinc-300 px-4 text-sm font-medium transition hover:bg-zinc-50"
                disabled={isRemovingImport}
                type="button"
                onClick={() => setSelectedImportAction(null)}
              >
                Cancel
              </button>
              <button
                className="h-10 rounded-md bg-red-700 px-4 text-sm font-medium text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:bg-red-300"
                disabled={isRemovingImport}
                type="button"
                onClick={confirmImportAction}
              >
                {isRemovingImport
                  ? "Removing..."
                  : selectedImportAction.mode === "replace"
                    ? "Remove and upload"
                    : "Remove import"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 px-4 py-3">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function PreviewList({ title, items }: { title: string; items: string[] }) {
  const visibleItems = uniqueNonEmptyStrings(items).slice(0, 80);

  return (
    <section>
      <h3 className="text-sm font-semibold">{title}</h3>
      {visibleItems.length > 0 ? (
        <div className="mt-3 max-h-44 overflow-auto rounded-md border border-zinc-200">
          {visibleItems.map((item) => (
            <div className="border-b border-zinc-100 px-3 py-2 text-sm" key={item}>
              {item}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-zinc-200 p-3 text-sm text-zinc-500">
          None
        </p>
      )}
    </section>
  );
}

function ImportHistorySection({
  imports,
  isLoading,
  onRemove,
  onReplace,
}: {
  imports: ImportBatchRow[];
  isLoading: boolean;
  onRemove: (batch: ImportBatchRow) => void;
  onReplace: (batch: ImportBatchRow) => void;
}) {
  const visibleImports = uniqueByKey(imports, (batch) => cleanKeyPart(batch.id) || null);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-600">
        Loading import history...
      </div>
    );
  }

  return (
    <Panel title={`Import History (${formatNumber(visibleImports.length)})`}>
      {visibleImports.length === 0 ? (
        <EmptyState label="No Excel imports found." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-3 py-3 font-semibold">File</th>
                <th className="px-3 py-3 font-semibold">Imported</th>
                <th className="px-3 py-3 font-semibold">Status</th>
                <th className="px-3 py-3 text-right font-semibold">Orders</th>
                <th className="px-3 py-3 text-right font-semibold">Invoices</th>
                <th className="px-3 py-3 text-right font-semibold">Products</th>
                <th className="px-3 py-3 text-right font-semibold">Warnings</th>
                <th className="px-3 py-3 font-semibold">Hash</th>
                <th className="px-3 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {visibleImports.map((batch) => (
                <tr className="align-top hover:bg-zinc-50" key={batch.id}>
                  <td className="px-3 py-3">
                    <p className="font-medium text-zinc-900">{batch.fileName}</p>
                    <p className="mt-1 text-xs text-zinc-500">{batch.id}</p>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-zinc-700">
                    {formatDate(batch.importedAt)}
                  </td>
                  <td className="px-3 py-3">
                    <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700">
                      {batch.status || "Unknown"}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatNumber(batch.orders ?? 0)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatNumber(batch.invoices ?? 0)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatNumber(batch.products ?? 0)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatNumber(batch.warnings ?? 0)}
                  </td>
                  <td className="px-3 py-3">
                    <p className="text-xs font-medium text-zinc-700">
                      {batch.fileHashStatus}
                    </p>
                    <p className="mt-1 max-w-[11rem] truncate font-mono text-xs text-zinc-500">
                      {batch.fileHash}
                    </p>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex justify-end gap-2">
                      <button
                        className="h-8 rounded-md border border-zinc-300 px-3 text-xs font-medium transition hover:bg-white"
                        type="button"
                        onClick={() => onReplace(batch)}
                      >
                        Replace
                      </button>
                      <button
                        className="h-8 rounded-md border border-red-200 px-3 text-xs font-medium text-red-700 transition hover:bg-red-50"
                        type="button"
                        onClick={() => onRemove(batch)}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ProductsSection({
  data,
  isLoading,
  page,
  search,
  onPageChange,
  onSearchChange,
  onSelectProduct,
}: {
  data: SectionData | null;
  isLoading: boolean;
  page: number;
  search: string;
  onPageChange: (page: number) => void;
  onSearchChange: (value: string) => void;
  onSelectProduct: (product: ProductRow) => void;
}) {
  const pageSize = 25;
  const products = uniqueByKey(
    ((data?.rows ?? []) as unknown as ProductRow[]).map((product) => ({
      ...product,
      name: cleanKeyPart(product.name),
      skuAliases: uniqueNonEmptyStrings(product.skuAliases),
      stores: uniqueNonEmptyStrings(product.stores),
    })),
    productRowKey,
  );
  const query = search.trim().toLowerCase();
  const filteredProducts = products.filter((product) => {
    const productName = cleanKeyPart(product.name).toLowerCase();
    if (!query) return true;
    return (
      productName.includes(query) ||
      (product.skuAliases ?? []).some((sku) => sku.toLowerCase().includes(query))
    );
  });
  const pageCount = Math.max(1, Math.ceil(filteredProducts.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleProducts = filteredProducts.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  if (isLoading) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-600">
        Loading products...
      </div>
    );
  }

  return (
    <Panel title="Products">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <label className="grid gap-1 text-xs font-medium text-zinc-500 md:w-80">
          Search product or SKU
          <input
            className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none transition focus:border-zinc-900"
            placeholder="Search by name or SKU"
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>
        <p className="text-sm text-zinc-500">
          Showing {formatNumber(filteredProducts.length)} of{" "}
          {formatNumber(products.length)} products
        </p>
      </div>

      {visibleProducts.length === 0 ? (
        <EmptyState label="No products match your search." />
      ) : (
        <div className="mt-5 w-full overflow-hidden">
          <table className="w-full table-fixed text-left text-sm">
            <colgroup>
              <col className="w-[7%]" />
              <col className="w-[31%]" />
              <col className="w-[35%]" />
              <col className="w-[8%]" />
              <col className="w-[7%]" />
              <col className="w-[7%]" />
              <col className="w-[5%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-2 py-3 font-semibold">Image</th>
                <th className="px-2 py-3 font-semibold">Product</th>
                <th className="px-2 py-3 font-semibold">SKU aliases</th>
                <th className="px-2 py-3 text-right font-semibold">Weight</th>
                <th className="px-2 py-3 text-right font-semibold">Lines</th>
                <th className="px-2 py-3 text-right font-semibold">Buys</th>
                <th className="px-2 py-3 text-right font-semibold">View</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {visibleProducts.map((product) => (
                <tr
                  className="cursor-pointer align-top hover:bg-zinc-50"
                  key={productRowKey(product) as string}
                  onClick={() => onSelectProduct(product)}
                >
                  <td className="px-2 py-3">
                    <ProductImage
                      alt={`${product.name || "Product"} image`}
                      size="small"
                      src={product.imageUrl}
                    />
                  </td>
                  <td className="min-w-0 px-2 py-3">
                    <p className="line-clamp-2 font-medium text-zinc-900">
                      {product.name || "-"}
                    </p>
                    <p className="mt-1 line-clamp-1 text-xs text-zinc-500">
                      {product.description || "No description"}
                    </p>
                  </td>
                  <td className="min-w-0 px-2 py-3">
                    <SkuChips skus={product.skuAliases ?? []} />
                  </td>
                  <td className="px-2 py-3 text-right tabular-nums text-zinc-700">
                    {formatCellValue(product.weight)}
                  </td>
                  <td className="px-2 py-3 text-right tabular-nums text-zinc-700">
                    {formatNumber(product.orderLines ?? 0)}
                  </td>
                  <td className="px-2 py-3 text-right tabular-nums text-zinc-700">
                    {formatNumber(product.stockPurchases ?? 0)}
                  </td>
                  <td className="px-2 py-3 text-right">
                    <button
                      className="rounded-md border border-zinc-300 px-2 py-1.5 text-xs font-medium transition hover:bg-white"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectProduct(product);
                      }}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-3 border-t border-zinc-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-zinc-500">
          Page {formatNumber(currentPage)} of {formatNumber(pageCount)}
        </p>
        <div className="flex gap-2">
          <button
            className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-medium transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={currentPage <= 1}
            type="button"
            onClick={() => onPageChange(currentPage - 1)}
          >
            Previous
          </button>
          <button
            className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-medium transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={currentPage >= pageCount}
            type="button"
            onClick={() => onPageChange(currentPage + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </Panel>
  );
}

function SkuChips({ skus }: { skus: string[] }) {
  const visibleSkus = uniqueNonEmptyStrings(skus);

  if (visibleSkus.length === 0) {
    return <span className="text-zinc-400">-</span>;
  }

  const visible = visibleSkus.slice(0, 2);
  const remaining = visibleSkus.length - visible.length;

  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {visible.map((sku) => (
        <span
          className="max-w-full truncate rounded-full bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700"
          key={sku}
          title={sku}
        >
          {sku}
        </span>
      ))}
      {remaining > 0 ? (
        <span className="rounded-full bg-zinc-950 px-2 py-1 text-xs font-medium text-white">
          +{remaining} more
        </span>
      ) : null}
    </div>
  );
}

function ProductDetailsModal({
  product,
  onClose,
}: {
  product: ProductRow;
  onClose: () => void;
}) {
  const skus = uniqueNonEmptyStrings(product.skuAliases);
  const stores = uniqueNonEmptyStrings(product.stores);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4">
      <div className="max-h-[90vh] w-full max-w-6xl overflow-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{product.name}</h2>
            <p className="mt-1 text-sm text-zinc-500">
              {product.description || "No description"}
            </p>
          </div>
          <button
            className="h-9 rounded-md border border-zinc-300 px-3 text-sm"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-4">
            <ProductImage
              alt={`${product.name || "Product"} image`}
              size="large"
              src={product.imageUrl}
            />
          </div>
          <Metric label="Weight" value={formatCellValue(product.weight)} />
          <Metric
            label="Order lines"
            value={formatNumber(product.orderLines ?? 0)}
          />
          <Metric
            label="Stock purchases"
            value={formatNumber(product.stockPurchases ?? 0)}
          />
          <Metric
            label="Current inventory"
            value={formatNumber(product.currentInventory ?? 0)}
          />
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <PreviewList title="All SKU aliases" items={skus} />
          <PreviewList title="Linked stores" items={stores} />
        </div>

        <QuotationDetails quotation={product.quotation ?? null} />
      </div>
    </div>
  );
}

function QuotationDetails({
  quotation,
}: {
  quotation: ProductQuotation | null;
}) {
  if (!quotation) {
    return (
      <section className="mt-5">
        <h3 className="text-sm font-semibold">Quotation data</h3>
        <p className="mt-3 rounded-md border border-dashed border-zinc-200 p-3 text-sm text-zinc-500">
          None
        </p>
      </section>
    );
  }

  const rows = uniqueByKey(getQuotationOfferRows(quotation), quotationRowKey);

  return (
    <section className="mt-5">
      <h3 className="text-sm font-semibold">Quotation table</h3>
      <div className="mt-3 overflow-x-auto rounded-md border border-zinc-200">
        <table className="w-full min-w-[1680px] text-left text-xs">
          <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-semibold">Quantity / MOQ</th>
              <th className="px-3 py-2 text-right font-semibold">Unit price (USD)</th>
              <th className="px-3 py-2 text-right font-semibold">Weight (kg)</th>
              <th className="px-3 py-2 text-right font-semibold">Freight FR</th>
              <th className="px-3 py-2 text-right font-semibold">Freight DE</th>
              <th className="px-3 py-2 text-right font-semibold">Freight GB</th>
              <th className="px-3 py-2 text-right font-semibold">Freight USA</th>
              <th className="px-3 py-2 text-right font-semibold">Service fee</th>
              <th className="px-3 py-2 text-right font-semibold">Total cost FR</th>
              <th className="px-3 py-2 text-right font-semibold">Total cost DE</th>
              <th className="px-3 py-2 text-right font-semibold">Total cost GB</th>
              <th className="px-3 py-2 text-right font-semibold">Total cost USA</th>
              <th className="px-3 py-2 font-semibold">Delivery time</th>
              <th className="px-3 py-2 text-right font-semibold">Selling price</th>
              <th className="px-3 py-2 font-semibold">Notes / stock status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.length > 0 ? (
              rows.map((row) => (
                <tr
                  className="align-top hover:bg-zinc-50"
                  key={quotationRowKey(row) as string}
                >
                  <td className="px-3 py-2">{quotationValue(row.quantityLabel)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{quotationValue(row.unitPrice)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{quotationValue(row.weight)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{quotationValue(row.freightFR)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{quotationValue(row.freightDE)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{quotationValue(row.freightGB)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{quotationValue(row.freightUSA)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{quotationValue(row.serviceFee)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{quotationValue(row.totalCostFR)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{quotationValue(row.totalCostDE)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{quotationValue(row.totalCostGB)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{quotationValue(row.totalCostUSA)}</td>
                  <td className="px-3 py-2">{quotationValue(row.deliveryTime)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{quotationValue(row.sellingPrice)}</td>
                  <td className="min-w-[16rem] px-3 py-2">{quotationValue(row.notes)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-3 py-4 text-zinc-500" colSpan={15}>
                  No quotation rows stored.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function getQuotationOfferRows(quotation: ProductQuotation): QuotationOfferRow[] {
  if (quotation.quotationRows?.length) return quotation.quotationRows;

  const fallbackNotes = [
    ...(quotation.quantityConditions ?? []),
    ...(quotation.stockNotes ?? []),
    ...(quotation.notes ?? []),
    quotation.retired ? "Marked retired / will be removed" : "",
  ]
    .filter(Boolean)
    .join("; ");

  if (quotation.priceTiers?.length) {
    return quotation.priceTiers.map((tier) => ({
      quantity: tier.quantity,
      quantityLabel: tier.quantity,
      unitPrice: tier.unitPrice,
      totalCostFR: tier.landedCost ?? quotation.landedCost,
      sellingPrice: tier.sellingPrice ?? quotation.sellingPrice,
      notes: fallbackNotes,
    }));
  }

  return [
    {
      quantity: quotation.moq ?? quotation.quantity,
      quantityLabel: quotation.moq ?? quotation.quantity,
      unitPrice: quotation.unitPrice,
      weight: quotation.weight,
      freightFR: amountForCountry(quotation.freightByCountry, "FR"),
      freightDE: amountForCountry(quotation.freightByCountry, "DE"),
      freightGB: amountForCountry(quotation.freightByCountry, "GB"),
      freightUSA: amountForCountry(quotation.freightByCountry, "USA"),
      serviceFee: quotation.serviceFee,
      totalCostFR:
        quotation.landedCost ?? amountForCountry(quotation.landedCostByCountry, "FR"),
      totalCostDE: amountForCountry(quotation.landedCostByCountry, "DE"),
      totalCostGB: amountForCountry(quotation.landedCostByCountry, "GB"),
      totalCostUSA: amountForCountry(quotation.landedCostByCountry, "USA"),
      deliveryTime: quotation.deliveryTime,
      sellingPrice: quotation.sellingPrice,
      notes: fallbackNotes,
    },
  ].filter((row) => Object.values(row).some((value) => value !== undefined && value !== ""));
}

function amountForCountry(
  values: Array<{ country: string; amount: number }> | undefined,
  country: string,
) {
  return values?.find((item) => item.country === country)?.amount;
}

function quotationValue(value: string | number | undefined | null) {
  if (value === null || value === undefined || value === "") return "—";
  return typeof value === "number" ? formatNumber(value) : String(value);
}

function AmountList({
  title,
  items,
}: {
  title: string;
  items: Array<{ country: string; amount: number }>;
}) {
  const visibleItems = uniqueByKey(
    items.filter(
      (item) => cleanKeyPart(item.country) && Number.isFinite(item.amount),
    ),
    (item) => `${cleanKeyPart(item.country)}-${item.amount}`,
  );

  return (
    <section>
      <h4 className="text-sm font-semibold">{title}</h4>
      {visibleItems.length > 0 ? (
        <div className="mt-3 rounded-md border border-zinc-200">
          {visibleItems.map((item) => (
            <div
              className="flex items-center justify-between gap-4 border-b border-zinc-100 px-3 py-2 text-sm last:border-b-0"
              key={`${cleanKeyPart(item.country)}-${item.amount}`}
            >
              <span>{item.country}</span>
              <span className="font-medium tabular-nums">
                {formatCurrency(item.amount)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-zinc-200 p-3 text-sm text-zinc-500">
          None
        </p>
      )}
    </section>
  );
}

function SectionTable({
  data,
  isLoading,
  title,
}: {
  data: SectionData | null;
  isLoading: boolean;
  title: string;
}) {
  if (isLoading) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-600">
        Loading {title.toLowerCase()}...
      </div>
    );
  }

  if (!data || data.rows.length === 0) {
    return (
      <Panel title={title}>
        <EmptyState label={`No ${title.toLowerCase()} found.`} />
      </Panel>
    );
  }

  const visibleRows = uniqueByKey(data.rows, recordRowKey);

  return (
    <Panel title={`${data.title} (${formatNumber(visibleRows.length)})`}>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
              {data.columns.map((column) => (
                <th className="whitespace-nowrap px-3 py-3 font-semibold" key={column.key}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {visibleRows.map((row) => (
              <tr className="hover:bg-zinc-50" key={recordRowKey(row) as string}>
                {data.columns.map((column) => (
                  <td
                    className="max-w-xs whitespace-nowrap px-3 py-3 text-zinc-700"
                    key={column.key}
                    title={String(row[column.key] ?? "")}
                  >
                    {formatCellValue(row[column.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function LinePanel({ data, empty }: { data: ChartPoint[]; empty: string }) {
  if (data.length === 0) return <EmptyState label={empty} />;

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <XAxis dataKey="label" tickLine={false} />
          <YAxis tickLine={false} />
          <Tooltip />
          <Line dataKey="total" stroke="#18181b" strokeWidth={2} type="monotone" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function BarPanel({ data, empty }: { data: ChartPoint[]; empty: string }) {
  if (data.length === 0) return <EmptyState label={empty} />;

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <XAxis dataKey="label" tickLine={false} />
          <YAxis tickLine={false} />
          <Tooltip />
          <Bar dataKey="total" fill="#18181b" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function PiePanel({ data, empty }: { data: ChartPoint[]; empty: string }) {
  if (data.length === 0) return <EmptyState label={empty} />;

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="total" innerRadius={55} nameKey="label" outerRadius={85}>
            {data.map((entry, index) => (
              <Cell fill={chartColors[index % chartColors.length]} key={entry.label} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
