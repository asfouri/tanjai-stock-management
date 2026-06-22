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

const chartColors = ["#18181b", "#0f766e", "#b45309", "#991b1b", "#52525b"];

const apiBaseUrl = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3005"
).replace(/\/$/, "");

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

function Panel({
  title,
  children,
}: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-5">{children}</div>
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
  return (
    <label className="grid gap-1 text-xs font-medium text-zinc-500">
      {label}
      <select
        className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none transition focus:border-zinc-900"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
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
  const [summary, setSummary] = useState<DashboardSummary>(emptySummary);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [importErrorMessage, setImportErrorMessage] = useState("");

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

        if (!response.ok) throw new Error("Unable to load dashboard summary.");

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
  }, [filterQuery, router]);

  async function refreshDashboard() {
    setIsLoading(true);
    const response = await fetch(
      `${apiBaseUrl}/dashboard/summary${filterQuery ? `?${filterQuery}` : ""}`
    );
    if (response.ok) {
      setSummary(normalizeSummary(await response.json()));
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
    } catch (error) {
      setImportErrorMessage(
        error instanceof Error ? error.message : "Unable to confirm import."
      );
    } finally {
      setIsImporting(false);
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
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-zinc-200 bg-white px-5 py-6 md:flex">
        <div className="text-lg font-semibold">TanjAI Stock</div>
        <nav className="mt-8">
          <div className="rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white">
            Dashboard
          </div>
        </nav>
        <button
          className="mt-auto h-10 rounded-md border border-zinc-300 text-sm font-medium transition hover:bg-zinc-50"
          type="button"
          onClick={handleLogout}
        >
          Logout
        </button>
      </aside>

      <div className="md:pl-64">
        <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 px-5 py-4 backdrop-blur md:px-8">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 md:hidden">
                TanjAI Stock
              </p>
              <h1 className="text-2xl font-semibold">Dashboard</h1>
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

        <section className="space-y-5 px-5 py-6 md:px-8">
          {errorMessage ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-700">
              {errorMessage}
            </div>
          ) : null}

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
                onChange={(value) => setFilters({ ...filters, dateFrom: value })}
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
                    <p className="text-sm font-medium text-zinc-500">{title}</p>
                    <p className="mt-4 text-2xl font-semibold">{value}</p>
                  </article>
                ))}
              </div>

              <div className="grid gap-5 xl:grid-cols-2">
                <Panel title="Orders by date">
                  <LinePanel data={summary.ordersOverTime} empty="No orders yet." />
                </Panel>
                <Panel title="Costs by date">
                  <LinePanel data={summary.costsByDate} empty="No costs yet." />
                </Panel>
                <Panel title="Orders by store">
                  <BarPanel data={summary.ordersByStore} empty="No store orders yet." />
                </Panel>
                <Panel title="Costs by store">
                  <BarPanel data={summary.costsByStore} empty="No store costs yet." />
                </Panel>
                <Panel title="Cost distribution">
                  <PiePanel data={summary.costDistribution} empty="No costs yet." />
                </Panel>
                <Panel title="Stock by product">
                  <BarPanel data={summary.stockByProduct} empty="No stock movements yet." />
                </Panel>
                <Panel title="Cost summary">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Metric label="Product costs" value={formatCurrency(summary.productCosts)} />
                    <Metric label="Shipping costs" value={formatCurrency(summary.shippingCosts)} />
                    <Metric label="Handling costs" value={formatCurrency(summary.handlingCosts)} />
                    <Metric label="Refunds" value={formatCurrency(summary.refunds)} />
                    <Metric label="Stock status" value={formatNumber(summary.stockStatus)} />
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
                          <span className="text-sm font-medium">{item.label}</span>
                          <span className="text-sm text-zinc-500">{item.total}</span>
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
                            <p className="text-xs text-zinc-500">{item.type}</p>
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
  return (
    <section>
      <h3 className="text-sm font-semibold">{title}</h3>
      {items.length > 0 ? (
        <div className="mt-3 max-h-44 overflow-auto rounded-md border border-zinc-200">
          {items.slice(0, 80).map((item) => (
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
