"use client";

import {
  ChangeEvent,
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  apiBaseUrl,
  apiFetch,
  getSessionWithTimeout,
  responseErrorMessage,
  setCachedAccessToken,
} from "./api";
import { FilterInput, FilterSelect } from "./components/FilterBar";
import { EmptyState, Panel } from "./components/Panel";
import { ProductImage } from "./components/ProductImage";
import type {
  ChartPoint,
  DashboardSummary,
  Filters,
  ImportBatchRow,
  ImportPreview,
  ProductQuotation,
  ProductRow,
  QuotationOfferRow,
  SectionData,
  SectionId,
} from "./types";
import {
  cleanKeyPart,
  emptySummary,
  formatCellValue,
  formatCurrency,
  formatDate,
  formatNumber,
  getUserDisplayName,
  normalizeSummary,
  productRowKey,
  quotationRowKey,
  recordRowKey,
  uniqueByKey,
  uniqueNonEmptyStrings,
} from "./utils";

const initialFilters: Filters = {
  brand: "",
  store: "",
  dateFrom: "",
  dateTo: "",
  invoiceDateFrom: "",
  invoiceDateTo: "",
  sku: "",
  invoice: "",
  orderNumber: "",
  trackingNumber: "",
  country: "",
  orderSearch: "",
  orderSort: "",
};

const sidebarItems: Array<{ id: SectionId; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "imports", label: "Imports" },
  { id: "products", label: "Products" },
  { id: "orders", label: "Orders" },
  { id: "product-matching", label: "Product Matching Review" },
  { id: "stores", label: "Stores" },
  { id: "invoices", label: "Invoices" },
  { id: "payments", label: "Payments" },
];

const chartColors = ["#18181b", "#0f766e", "#b45309", "#991b1b", "#52525b"];

type CachedSectionId = Exclude<SectionId, "dashboard" | "imports">;
type SectionDataCache = Partial<Record<CachedSectionId, SectionData>>;
type LoadedSectionCache = Partial<Record<Exclude<SectionId, "dashboard">, true>>;

export default function DashboardPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadedSectionQueryRef = useRef<Partial<Record<SectionId, string>>>({});
  const [user, setUser] = useState<User | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>("dashboard");
  const [summary, setSummary] = useState<DashboardSummary>(emptySummary);
  const [sectionDataCache, setSectionDataCache] = useState<SectionDataCache>({});
  const [loadedSectionCache, setLoadedSectionCache] =
    useState<LoadedSectionCache>({});
  const [importBatches, setImportBatches] = useState<ImportBatchRow[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [productPage, setProductPage] = useState(1);
  const [selectedProduct, setSelectedProduct] = useState<ProductRow | null>(null);
  const [selectedImportAction, setSelectedImportAction] = useState<{
    batch: ImportBatchRow;
    mode: "remove" | "replace";
  } | null>(null);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [orderPage, setOrderPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingSection, setLoadingSection] = useState<SectionId | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isRemovingImport, setIsRemovingImport] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [importErrorMessage, setImportErrorMessage] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const sectionData =
    activeSection !== "dashboard" && activeSection !== "imports"
      ? (sectionDataCache[activeSection] ?? null)
      : null;
  const isSectionLoading = loadingSection === activeSection;
  const debouncedOrderSearch = useDebouncedValue(filters.orderSearch, 300);

  const filterQuery = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (
        key === "orderSearch" ||
        key === "orderSort" ||
        key === "invoiceDateFrom" ||
        key === "invoiceDateTo"
      ) {
        continue;
      }
      if (value.trim()) params.set(key, value.trim());
    }
    return params.toString();
  }, [filters]);

  const orderSectionQuery = useMemo(() => {
    const params = new URLSearchParams();
    for (const key of [
      "store",
      "dateFrom",
      "dateTo",
      "invoiceDateFrom",
      "invoiceDateTo",
      "country",
      "orderSort",
    ] as const) {
      const value = filters[key].trim();
      if (value) params.set(key, value);
    }
    if (debouncedOrderSearch.trim()) {
      params.set("orderSearch", debouncedOrderSearch.trim());
    }
    if (orderPage > 1) {
      params.set("orderPage", String(orderPage));
    }
    return params.toString();
  }, [
    filters.store,
    filters.dateFrom,
    filters.dateTo,
    filters.invoiceDateFrom,
    filters.invoiceDateTo,
    filters.country,
    filters.orderSort,
    debouncedOrderSearch,
    orderPage,
  ]);

  // Any change to the order filters restarts pagination from the first page.
  useEffect(() => {
    setOrderPage(1);
  }, [
    filters.store,
    filters.dateFrom,
    filters.dateTo,
    filters.country,
    filters.orderSort,
    debouncedOrderSearch,
  ]);

  useEffect(() => {
    let isMounted = true;

    async function loadDashboard() {
      try {
        const sessionResponse = await getSessionWithTimeout();
        const session = sessionResponse?.data.session;

        if (isMounted) setUser(session?.user ?? null);

        const response = await apiFetch(
          `${apiBaseUrl}/dashboard/summary${filterQuery ? `?${filterQuery}` : ""}`,
        );

        if (response.status === 401) {
          router.replace("/login");
          return;
        }

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
      return;
    }

    const sectionQuery = activeSection === "orders" ? orderSectionQuery : "";

    if (
      loadedSectionCache[activeSection] &&
      loadedSectionQueryRef.current[activeSection] === sectionQuery
    ) {
      return;
    }

    let isMounted = true;

    async function loadSection() {
      setLoadingSection(activeSection);
      setErrorMessage("");

      try {
        if (activeSection === "imports") {
          const response = await apiFetch(`${apiBaseUrl}/imports/excel/history`);
          if (!response.ok) {
            throw new Error(
              await responseErrorMessage(response, "Unable to load import history.")
            );
          }
          const data = (await response.json()) as ImportBatchRow[];
          if (isMounted) {
            setImportBatches(data);
            loadedSectionQueryRef.current.imports = sectionQuery;
            setLoadedSectionCache((cache) => ({ ...cache, imports: true }));
          }
          return;
        }

        const response = await apiFetch(
          `${apiBaseUrl}/dashboard/section/${activeSection}${
            sectionQuery ? `?${sectionQuery}` : ""
          }`
        );

        if (!response.ok) {
          throw new Error(
            await responseErrorMessage(response, "Unable to load section data.")
          );
        }

        const data = (await response.json()) as SectionData;
        if (isMounted) {
          setSectionDataCache((cache) => ({
            ...cache,
            [activeSection]: data,
          }));
          loadedSectionQueryRef.current[activeSection] = sectionQuery;
          setLoadedSectionCache((cache) => ({
            ...cache,
            [activeSection]: true,
          }));
        }
      } catch (error) {
        if (isMounted) {
          setErrorMessage(
            error instanceof Error ? error.message : "Unable to load section."
          );
        }
      } finally {
        if (isMounted) {
          setLoadingSection((section) =>
            section === activeSection ? null : section
          );
        }
      }
    }

    loadSection();

    return () => {
      isMounted = false;
    };
  }, [activeSection, loadedSectionCache, orderSectionQuery, refreshKey]);

  async function refreshDashboard() {
    setIsLoading(true);
    const response = await apiFetch(
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

  function invalidateSectionCache() {
    setSectionDataCache({});
    setLoadedSectionCache({});
    loadedSectionQueryRef.current = {};
  }

  async function handleLogout() {
    setErrorMessage("");
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    setCachedAccessToken("");
    await fetch("/api/logout", { method: "POST" }).catch(() => null);
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
      const response = await apiFetch(`${apiBaseUrl}/imports/excel/preview`, {
        method: "POST",
        headers: {
          "Content-Type":
            file.type ||
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "x-file-name": encodeURIComponent(file.name),
        },
        body: file,
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
      const response = await apiFetch(`${apiBaseUrl}/imports/excel/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: preview.token }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message ?? "Unable to save import.");
      }

      setPreview(null);
      invalidateSectionCache();
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
      const response = await apiFetch(`${apiBaseUrl}/imports/excel/remove`, {
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
      invalidateSectionCache();
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
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
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
                  <FilterSelect
                    label="Country"
                    placeholder="All countries"
                    options={summary.filterOptions.countries}
                    value={filters.country}
                    onChange={(value) => setFilters({ ...filters, country: value })}
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
                onSearchChange={(value) => {
                  setProductSearch(value);
                  setProductPage(1);
                }}
                onSelectProduct={setSelectedProduct}
              />
            ) : activeSection === "orders" ? (
              <div className="flex h-[calc(100vh-9rem)] min-h-[30rem] flex-col gap-3 overflow-hidden">
                <div className="shrink-0">
                  <OrderFiltersPanel
                    filters={filters}
                    countries={summary.filterOptions.countries}
                    stores={summary.filterOptions.stores}
                    onChange={setFilters}
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                  <OrdersSection
                    data={sectionData}
                    isLoading={isSectionLoading}
                    page={orderPage}
                    onPageChange={setOrderPage}
                    onSelectProduct={setSelectedProduct}
                  />
                </div>
              </div>
            ) : activeSection === "product-matching" ? (
              <ProductMatchingReviewSection
                data={sectionData}
                isLoading={isSectionLoading}
                onChanged={() => {
                  invalidateSectionCache();
                  setRefreshKey((value) => value + 1);
                }}
              />
            ) : (
              <SectionTable
                data={sectionData}
                isLoading={isSectionLoading}
                title={
                  sidebarItems.find((item) => item.id === activeSection)
                    ?.label ?? "Section"
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
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
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
  const matchesQuery = (product: ProductRow) => {
    if (!query) return true;
    const productName = cleanKeyPart(product.name).toLowerCase();
    const description = (product.description ?? "").toLowerCase();
    return (
      productName.includes(query) ||
      description.includes(query) ||
      (product.skuAliases ?? []).some((sku) => sku.toLowerCase().includes(query))
    );
  };

  // Products are grouped by the Excel quotation's "No." column block;
  // products imported without a group each form their own group.
  const groupMap = new Map<string, ProductRow[]>();
  for (const product of products) {
    const groupName =
      cleanKeyPart(product.quotation?.productGroup ?? "") || product.name || "-";
    const members = groupMap.get(groupName);
    if (members) {
      members.push(product);
    } else {
      groupMap.set(groupName, [product]);
    }
  }
  const groups = [...groupMap.entries()]
    .map(([name, items]) => ({
      name,
      items,
      imageUrl: items.find((item) => item.imageUrl)?.imageUrl ?? null,
      skuCount: uniqueNonEmptyStrings(
        items.flatMap((item) => item.skuAliases ?? []),
      ).length,
      orderLines: items.reduce(
        (total, item) => total + (item.orderLines ?? 0),
        0,
      ),
      // Position of the group's block in the Excel quotation sheet.
      sourceRow: items.reduce((min, item) => {
        const row = item.quotation?.quotationRows?.[0]?.sourceRow;
        return typeof row === "number" && row < min ? row : min;
      }, Number.POSITIVE_INFINITY),
    }))
    // Most recently added in the Excel file (bottom of the sheet) first;
    // groups without source info go last.
    .sort((left, right) => {
      const leftRow = Number.isFinite(left.sourceRow) ? left.sourceRow : -1;
      const rightRow = Number.isFinite(right.sourceRow) ? right.sourceRow : -1;
      return rightRow - leftRow || left.name.localeCompare(right.name);
    });

  const activeGroup = selectedGroup
    ? (groups.find((group) => group.name === selectedGroup) ?? null)
    : null;
  const filteredGroups = groups.filter(
    (group) =>
      !query ||
      group.name.toLowerCase().includes(query) ||
      group.items.some(matchesQuery),
  );
  const filteredProducts = (activeGroup?.items ?? []).filter(matchesQuery);
  const totalRows = activeGroup
    ? filteredProducts.length
    : filteredGroups.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(page, pageCount);
  const sliceStart = (currentPage - 1) * pageSize;
  const visibleGroups = filteredGroups.slice(sliceStart, sliceStart + pageSize);
  const visibleProducts = filteredProducts.slice(
    sliceStart,
    sliceStart + pageSize,
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
          {activeGroup
            ? `Showing ${formatNumber(filteredProducts.length)} of ${formatNumber(
                activeGroup.items.length,
              )} products`
            : `Showing ${formatNumber(filteredGroups.length)} of ${formatNumber(
                groups.length,
              )} product groups`}
        </p>
      </div>

      {activeGroup ? (
        <div className="mt-4 flex items-center gap-3">
          <button
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium transition hover:bg-zinc-50"
            type="button"
            onClick={() => {
              setSelectedGroup(null);
              onPageChange(1);
            }}
          >
            ← All groups
          </button>
          <p className="text-sm font-semibold text-zinc-900">
            {activeGroup.name}
          </p>
        </div>
      ) : null}

      {!activeGroup ? (
        visibleGroups.length === 0 ? (
          <EmptyState label="No product groups match your search." />
        ) : (
          <div className="mt-5 w-full overflow-hidden">
            <table className="w-full table-fixed text-left text-sm">
              <colgroup>
                <col className="w-[7%]" />
                <col className="w-[48%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[11%]" />
                <col className="w-[10%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-2 py-3 font-semibold">Image</th>
                  <th className="px-2 py-3 font-semibold">Group</th>
                  <th className="px-2 py-3 text-right font-semibold">Products</th>
                  <th className="px-2 py-3 text-right font-semibold">SKUs</th>
                  <th className="px-2 py-3 text-right font-semibold">Lines</th>
                  <th className="px-2 py-3 text-right font-semibold">View</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {visibleGroups.map((group) => (
                  <tr
                    className="cursor-pointer align-top hover:bg-zinc-50"
                    key={group.name}
                    onClick={() => {
                      setSelectedGroup(group.name);
                      onPageChange(1);
                    }}
                  >
                    <td className="px-2 py-3">
                      <ProductImage
                        alt={`${group.name} image`}
                        size="small"
                        src={group.imageUrl}
                      />
                    </td>
                    <td className="min-w-0 px-2 py-3">
                      <p className="line-clamp-2 font-medium text-zinc-900">
                        {group.name}
                      </p>
                      <p className="mt-1 line-clamp-1 text-xs text-zinc-500">
                        {group.items.length === 1
                          ? group.items[0].description || "No description"
                          : `${formatNumber(group.items.length)} products`}
                      </p>
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums text-zinc-700">
                      {formatNumber(group.items.length)}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums text-zinc-700">
                      {formatNumber(group.skuCount)}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums text-zinc-700">
                      {formatNumber(group.orderLines)}
                    </td>
                    <td className="px-2 py-3 text-right">
                      <button
                        className="rounded-md border border-zinc-300 px-2 py-1.5 text-xs font-medium transition hover:bg-white"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedGroup(group.name);
                          onPageChange(1);
                        }}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : visibleProducts.length === 0 ? (
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
                      {product.description || product.name || "-"}
                    </p>
                    {product.description &&
                    product.description !== product.name ? (
                      <p className="mt-1 line-clamp-1 text-xs text-zinc-500">
                        {product.name}
                      </p>
                    ) : null}
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

type OrderLineRow = Record<string, SectionData["rows"][number][string]> & {
  orderNumber?: string;
  store?: string;
  invoice?: string;
  country?: string;
  status?: string;
  date?: string;
  trackingNumbers?: string;
  sku?: string;
  quantity?: number;
  productCost?: number;
  shippingCost?: number;
  handlingCost?: number;
  totalCost?: number;
  lineType?: string;
  refunded?: boolean;
  refundTotal?: number;
  sourceSheet?: string;
  sourceRow?: number;
  product?: ProductRow | null;
};

function normalizeOrderRows(rows: SectionData["rows"]) {
  const normalized = uniqueByKey(
    (rows as OrderLineRow[]).map((row) => ({
      ...row,
      orderNumber: cleanKeyPart(row.orderNumber),
      store: cleanKeyPart(row.store),
      invoice: cleanKeyPart(row.invoice),
      country: cleanKeyPart(row.country),
      status: cleanKeyPart(row.status),
      date: cleanKeyPart(row.date),
      trackingNumbers: cleanKeyPart(row.trackingNumbers),
      sku: cleanKeyPart(row.sku),
    })),
    orderLineRowKey,
  );
  return normalized;
}

type OrderGroup = {
  key: string;
  summary: OrderLineRow;
  lines: OrderLineRow[];
  refundTotal?: number;
  totalCost: number;
};

// One entry per order: product lines grouped together, refunds folded into
// a refund amount. Orders that only contain a refund keep it as their line.
function groupOrderRows(rows: OrderLineRow[]): OrderGroup[] {
  const orderKeyOf = (row: OrderLineRow) =>
    [
      cleanKeyPart(row.orderNumber),
      cleanKeyPart(row.invoice),
      cleanKeyPart(row.store),
    ].join("|");
  const isRefund = (row: OrderLineRow) =>
    (row.lineType ?? "").trim().toLowerCase() === "refund";

  const membersByOrder = new Map<string, OrderLineRow[]>();
  for (const row of rows) {
    const key = orderKeyOf(row);
    const members = membersByOrder.get(key);
    if (members) {
      members.push(row);
    } else {
      membersByOrder.set(key, [row]);
    }
  }

  const groups: OrderGroup[] = [];
  for (const [key, members] of membersByOrder) {
    const productRows = members.filter((row) => !isRefund(row));
    const refundRows = members.filter(isRefund);
    const lines = productRows.length > 0 ? productRows : refundRows;
    const refundTotal =
      productRows.length > 0 && refundRows.length > 0
        ? refundRows.reduce(
            (total, row) => total + Number(row.totalCost ?? 0),
            0,
          )
        : undefined;
    const totalCost = lines.reduce(
      (total, row) => total + Number(row.totalCost ?? 0),
      0,
    );

    groups.push({
      key,
      summary:
        refundTotal === undefined ? lines[0] : { ...lines[0], refundTotal },
      lines,
      refundTotal,
      totalCost,
    });
  }
  return groups;
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebouncedValue(value), delayMs);
    return () => clearTimeout(timeoutId);
  }, [value, delayMs]);

  return debouncedValue;
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M4 6h16" />
      <path d="M7 12h10" />
      <path d="M10 18h4" />
    </svg>
  );
}

function SortIcon({ direction }: { direction: "asc" | "desc" | "" }) {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M4 7h11" />
      <path d="M4 12h7" />
      <path d="M4 17h4" />
      {direction === "asc" ? (
        <path d="m18 17 3-3 3 3" />
      ) : (
        <path d="m18 14 3 3 3-3" />
      )}
      <path d="M21 6v11" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function OrderFiltersPanel({
  filters,
  countries,
  stores,
  onChange,
}: {
  filters: Filters;
  countries: string[];
  stores: string[];
  onChange: (filters: Filters) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const activeFilterCount = [
    filters.store,
    filters.dateFrom,
    filters.dateTo,
    filters.invoiceDateFrom,
    filters.invoiceDateTo,
    filters.country,
  ].filter(Boolean).length;
  const nextOrderSort = filters.orderSort === "asc" ? "desc" : "asc";
  const orderSortLabel =
    filters.orderSort === "asc"
      ? "Order ID asc"
      : filters.orderSort === "desc"
        ? "Order ID desc"
        : "Order ID";

  return (
    <section className="relative min-w-0 rounded-lg border border-zinc-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium text-zinc-500">
          Search orders
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400">
              <SearchIcon />
            </span>
            <input
              className="h-10 w-full rounded-md border border-zinc-300 bg-white pl-9 pr-9 text-sm text-zinc-900 outline-none transition focus:border-zinc-900"
              placeholder="Order number, product, SKU, or tracking"
              value={filters.orderSearch}
              onChange={(event) =>
                onChange({
                  ...filters,
                  orderSearch: event.target.value,
                  orderNumber: "",
                  sku: "",
                  trackingNumber: "",
                })
              }
            />
            {filters.orderSearch ? (
              <button
                aria-label="Clear order search"
                className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
                type="button"
                onClick={() => onChange({ ...filters, orderSearch: "" })}
              >
                <CloseIcon />
              </button>
            ) : null}
          </div>
        </label>

        <div className="flex gap-2">
          <button
            className={`inline-flex h-10 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition ${
              filters.orderSort
                ? "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700"
                : "border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50"
            }`}
            type="button"
            onClick={() => onChange({ ...filters, orderSort: nextOrderSort })}
          >
            <SortIcon direction={filters.orderSort} />
            <span>{orderSortLabel}</span>
          </button>
          <button
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-900 transition hover:bg-zinc-50"
            type="button"
            onClick={() => setIsOpen((value) => !value)}
          >
            <FilterIcon />
            <span>Filters</span>
            {activeFilterCount > 0 ? (
              <span className="grid h-5 min-w-[1.25rem] place-items-center rounded-full bg-zinc-900 px-1.5 text-xs text-white">
                {activeFilterCount}
              </span>
            ) : null}
          </button>
        </div>
      </div>

      {isOpen ? (
        <div className="absolute right-4 top-[calc(100%-0.25rem)] z-30 w-[min(100vw-2rem,42rem)] rounded-lg border border-zinc-200 bg-white p-4 shadow-xl">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Filter orders</h2>
            <button
              aria-label="Close filters"
              className="grid h-8 w-8 place-items-center rounded-md border border-zinc-300 text-zinc-600 transition hover:bg-zinc-50 hover:text-zinc-900"
              type="button"
              onClick={() => setIsOpen(false)}
            >
              <CloseIcon />
            </button>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <FilterSelect
              label="Store"
              placeholder="All stores"
              options={stores}
              value={filters.store}
              onChange={(value) => onChange({ ...filters, store: value })}
            />
            <FilterSelect
              label="Country"
              placeholder="All countries"
              options={countries}
              value={filters.country}
              onChange={(value) => onChange({ ...filters, country: value })}
            />
            <FilterInput
              label="Order date from"
              type="date"
              value={filters.dateFrom}
              onChange={(value) =>
                onChange({
                  ...filters,
                  dateFrom: value,
                  // Picking a single date filters that exact day; extend
                  // "to" afterwards for a wider range.
                  dateTo:
                    value && (!filters.dateTo || filters.dateTo < value)
                      ? value
                      : filters.dateTo,
                })
              }
            />
            <FilterInput
              label="Order date to"
              type="date"
              value={filters.dateTo}
              onChange={(value) => onChange({ ...filters, dateTo: value })}
            />
            <FilterInput
              label="Invoice date from"
              type="date"
              value={filters.invoiceDateFrom}
              onChange={(value) =>
                onChange({
                  ...filters,
                  invoiceDateFrom: value,
                  invoiceDateTo:
                    value &&
                    (!filters.invoiceDateTo || filters.invoiceDateTo < value)
                      ? value
                      : filters.invoiceDateTo,
                })
              }
            />
            <FilterInput
              label="Invoice date to"
              type="date"
              value={filters.invoiceDateTo}
              onChange={(value) =>
                onChange({ ...filters, invoiceDateTo: value })
              }
            />
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-medium transition hover:bg-zinc-50"
              type="button"
              onClick={() =>
                onChange({
                  ...filters,
                  store: "",
                  dateFrom: "",
                  dateTo: "",
                  invoiceDateFrom: "",
                  invoiceDateTo: "",
                  country: "",
                })
              }
            >
              Clear
            </button>
            <button
              className="h-9 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition hover:bg-zinc-700"
              type="button"
              onClick={() => setIsOpen(false)}
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function OrdersSection({
  data,
  isLoading,
  page,
  onPageChange,
  onSelectProduct,
}: {
  data: SectionData | null;
  isLoading: boolean;
  page: number;
  onPageChange: (page: number) => void;
  onSelectProduct: (product: ProductRow) => void;
}) {
  const [selectedOrder, setSelectedOrder] = useState<OrderLineRow | null>(null);
  const [selectedProductSummary, setSelectedProductSummary] =
    useState<ProductRow | null>(null);
  const [expandedOrders, setExpandedOrders] = useState<Set<string>>(new Set());
  const rows = useMemo(
    () => normalizeOrderRows(data?.rows ?? []),
    [data],
  );
  const orderGroups = useMemo(() => groupOrderRows(rows), [rows]);
  const toggleExpanded = (key: string) => {
    setExpandedOrders((expanded) => {
      const next = new Set(expanded);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };
  const totalOrders = data?.totalRows ?? rows.length;
  const pageSize = data?.pageSize ?? 100;
  const pageCount = Math.max(1, Math.ceil(totalOrders / pageSize));
  const currentPage = Math.min(page, pageCount);
  const showFilteredTotal = data?.meta?.hasDateFilter === true;
  const filteredTotalCost = Number(data?.meta?.totalCost ?? 0);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-600">
        Loading orders...
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <Panel title="Orders">
        <EmptyState label="No orders found." />
      </Panel>
    );
  }

  return (
    <>
      <Panel title={`Orders (${formatNumber(totalOrders)})`}>
        {showFilteredTotal ? (
          <div className="mb-4 flex flex-col gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm font-medium text-zinc-600">
              Filtered date total
            </span>
            <span className="text-lg font-semibold tabular-nums text-zinc-900">
              {formatCurrency(filteredTotalCost)}
            </span>
          </div>
        ) : null}
        <div className="overflow-hidden">
          <table className="w-full table-fixed text-left text-sm">
            <colgroup>
              <col className="w-[16%]" />
              <col className="w-[18%]" />
              <col className="hidden w-[13%] md:table-column" />
              <col className="w-[19%]" />
              <col className="hidden w-[18%] lg:table-column" />
              <col className="w-[14%]" />
              <col className="w-[13%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-2 py-3 font-semibold">Order</th>
                <th className="px-2 py-3 font-semibold">Store</th>
                <th className="hidden px-2 py-3 font-semibold md:table-cell">
                  Date
                </th>
                <th className="px-2 py-3 font-semibold">Tracking</th>
                <th className="hidden px-2 py-3 font-semibold lg:table-cell">
                  Product
                </th>
                <th className="px-2 py-3 text-right font-semibold">Total</th>
                <th className="px-2 py-3 text-right font-semibold">View</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {orderGroups.map((group) => {
                const isExpandable = group.lines.length > 1;
                const isExpanded = isExpandable && expandedOrders.has(group.key);
                const summary = group.summary;

                return (
                  <Fragment key={group.key}>
                    <tr
                      className={`align-top hover:bg-zinc-50 ${
                        isExpandable ? "cursor-pointer" : ""
                      }`}
                      onClick={
                        isExpandable
                          ? () => toggleExpanded(group.key)
                          : undefined
                      }
                    >
                      <td className="min-w-0 px-2 py-3">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {isExpandable ? (
                            <span className="w-3 shrink-0 text-xs text-zinc-400">
                              {isExpanded ? "▾" : "▸"}
                            </span>
                          ) : null}
                          <p className="truncate font-medium text-zinc-900">
                            {summary.orderNumber || "-"}
                          </p>
                          {summary.refunded ? <RefundedTag /> : null}
                        </div>
                        <p className="mt-1 truncate text-xs text-zinc-500 md:hidden">
                          {summary.date || "-"}
                        </p>
                      </td>
                      <td className="min-w-0 px-2 py-3">
                        <p className="truncate text-zinc-700">
                          {summary.store || "-"}
                        </p>
                        <p className="mt-1 truncate text-xs text-zinc-500">
                          {summary.country || "-"}
                        </p>
                      </td>
                      <td className="hidden whitespace-nowrap px-2 py-3 text-zinc-700 md:table-cell">
                        {summary.date || "-"}
                      </td>
                      <td className="min-w-0 px-2 py-3">
                        <p
                          className="truncate text-zinc-700"
                          title={summary.trackingNumbers}
                        >
                          {summary.trackingNumbers || "-"}
                        </p>
                      </td>
                      <td className="hidden min-w-0 px-2 py-3 lg:table-cell">
                        {isExpandable ? (
                          <p className="truncate text-zinc-700">
                            {formatNumber(group.lines.length)} products
                          </p>
                        ) : (
                          <p className="truncate text-zinc-700" title={summary.sku}>
                            {summary.sku || "-"}
                          </p>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-zinc-700">
                        {formatCurrency(group.totalCost)}
                        {typeof group.refundTotal === "number" ? (
                          <p className="mt-1 text-xs font-medium text-red-600">
                            {formatCurrency(group.refundTotal)} refund
                          </p>
                        ) : null}
                      </td>
                      <td className="px-2 py-3 text-right">
                        <button
                          className="h-8 rounded-md border border-zinc-300 px-2 text-xs font-medium transition hover:bg-white"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedOrder(summary);
                          }}
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr className="bg-zinc-50/60">
                        <td className="px-2 pb-3 pt-1" colSpan={7}>
                          <div className="ml-5 overflow-hidden rounded-md border border-zinc-200 bg-white">
                            <table className="w-full text-left text-xs">
                              <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                                <tr>
                                  <th className="px-3 py-2 font-semibold">Product</th>
                                  <th className="px-3 py-2 text-right font-semibold">Qty</th>
                                  <th className="px-3 py-2 text-right font-semibold">Product cost</th>
                                  <th className="px-3 py-2 text-right font-semibold">Shipping</th>
                                  <th className="px-3 py-2 text-right font-semibold">Handling</th>
                                  <th className="px-3 py-2 text-right font-semibold">Total</th>
                                  <th className="px-3 py-2 text-right font-semibold">View</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-zinc-100">
                                {group.lines.map((line) => (
                                  <tr key={orderLineRowKey(line) as string}>
                                    <td className="min-w-0 px-3 py-2">
                                      <p className="truncate text-zinc-800" title={line.sku}>
                                        {line.sku || "-"}
                                      </p>
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
                                      {formatNumber(line.quantity ?? 0)}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
                                      {formatCurrency(Number(line.productCost ?? 0))}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
                                      {formatCurrency(Number(line.shippingCost ?? 0))}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
                                      {formatCurrency(Number(line.handlingCost ?? 0))}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
                                      {formatCurrency(Number(line.totalCost ?? 0))}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                      <button
                                        className="rounded-md border border-zinc-300 px-2 py-1 text-[11px] font-medium transition hover:bg-zinc-50"
                                        type="button"
                                        onClick={() => setSelectedOrder(line)}
                                      >
                                        Details
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
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

      {selectedOrder ? (
        <OrderDetailsModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onSelectProduct={(product) => {
            setSelectedOrder(null);
            setSelectedProductSummary(product);
          }}
        />
      ) : null}
      {selectedProductSummary ? (
        <FastProductSummaryModal
          product={selectedProductSummary}
          onClose={() => setSelectedProductSummary(null)}
          onOpenFullDetails={() => {
            setSelectedProductSummary(null);
            onSelectProduct(selectedProductSummary);
          }}
        />
      ) : null}
    </>
  );
}

function MovementTypeTag({ type }: { type: string }) {
  const normalized = type.toLowerCase();
  const style = normalized.includes("consum")
    ? "bg-amber-50 text-amber-700"
    : normalized.includes("return")
      ? "bg-blue-50 text-blue-700"
      : normalized.includes("inbound") || normalized.includes("arrival")
        ? "bg-emerald-50 text-emerald-700"
        : "bg-zinc-100 text-zinc-700";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${style}`}
    >
      {type}
    </span>
  );
}

function RefundedTag() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
      Refunded
    </span>
  );
}

function orderLineRowKey(row: OrderLineRow) {
  return [
    cleanKeyPart(row.orderNumber),
    cleanKeyPart(row.invoice),
    cleanKeyPart(row.store),
    cleanKeyPart(row.sku),
    cleanKeyPart(row.sourceSheet),
    row.sourceRow ?? "",
  ]
    .join("|")
    .trim();
}

function OrderDetailsModal({
  order,
  onClose,
  onSelectProduct,
}: {
  order: OrderLineRow;
  onClose: () => void;
  onSelectProduct: (product: ProductRow) => void;
}) {
  const product = isProductRow(order.product) ? order.product : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">
                Order {order.orderNumber || "-"}
              </h2>
              {order.refunded ? <RefundedTag /> : null}
            </div>
            <p className="mt-1 text-sm text-zinc-500">
              {order.store || "-"} · {order.date || "-"}
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
          <DetailItem label="Invoice" value={order.invoice} />
          <DetailItem label="Country" value={order.country} />
          <DetailItem label="Status" value={order.status} />
          <DetailItem label="Tracking" value={order.trackingNumbers} />
          <DetailItem label="Line type" value={order.lineType} />
          {typeof order.refundTotal === "number" ? (
            <DetailItem
              label="Refund"
              value={formatCurrency(order.refundTotal)}
            />
          ) : null}
        </div>

        <section className="mt-5 rounded-md border border-zinc-200 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">Product line</h3>
              <p className="mt-2 truncate text-sm text-zinc-700">
                {order.sku || "-"}
              </p>
            </div>
            {product ? (
              <button
                className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-medium transition hover:bg-zinc-50"
                type="button"
                onClick={() => onSelectProduct(product)}
              >
                Product info
              </button>
            ) : null}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <DetailItem label="Quantity" value={order.quantity} />
            <DetailItem label="Product cost" value={formatCurrency(Number(order.productCost ?? 0))} />
            <DetailItem label="Shipping cost" value={formatCurrency(Number(order.shippingCost ?? 0))} />
            <DetailItem label="Handling cost" value={formatCurrency(Number(order.handlingCost ?? 0))} />
            <DetailItem label="Total cost" value={formatCurrency(Number(order.totalCost ?? 0))} />
          </div>
        </section>

        <section className="mt-5 rounded-md border border-zinc-200 p-4">
          <h3 className="text-sm font-semibold">Import source</h3>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <DetailItem label="Source sheet" value={order.sourceSheet} />
            <DetailItem label="Source row" value={order.sourceRow} />
          </div>
        </section>
      </div>
    </div>
  );
}

function DetailItem({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  return (
    <div className="min-w-0 rounded-md bg-zinc-50 p-3">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-zinc-900" title={String(value ?? "")}>
        {value === null || value === undefined || value === "" ? "-" : value}
      </p>
    </div>
  );
}

function FastProductSummaryModal({
  product,
  onClose,
  onOpenFullDetails,
}: {
  product: ProductRow;
  onClose: () => void;
  onOpenFullDetails: () => void;
}) {
  const skus = uniqueNonEmptyStrings(product.skuAliases);
  const stores = uniqueNonEmptyStrings(product.stores);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{product.name}</h2>
            <p className="mt-1 line-clamp-2 text-sm text-zinc-500">
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

        <div className="mt-5 grid gap-4 sm:grid-cols-[7rem_1fr]">
          <ProductImage
            alt={`${product.name || "Product"} image`}
            size="large"
            src={product.imageUrl}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <DetailItem label="Weight" value={product.weight} />
            <DetailItem label="Order lines" value={product.orderLines ?? 0} />
            <DetailItem label="Stock purchases" value={product.stockPurchases ?? 0} />
            <DetailItem label="Inventory moves" value={product.inventoryMovements ?? 0} />
          </div>
        </div>

        <section className="mt-5 rounded-md border border-zinc-200 p-4">
          <h3 className="text-sm font-semibold">SKUs</h3>
          <div className="mt-3">
            <SkuChips skus={skus} />
          </div>
        </section>

        <section className="mt-5 rounded-md border border-zinc-200 p-4">
          <h3 className="text-sm font-semibold">Stores</h3>
          <p className="mt-2 text-sm text-zinc-700">
            {stores.length > 0 ? stores.join(", ") : "-"}
          </p>
        </section>

        <div className="mt-5 flex justify-end">
          <button
            className="h-9 rounded-md bg-zinc-950 px-3 text-sm font-medium text-white transition hover:bg-zinc-800"
            type="button"
            onClick={onOpenFullDetails}
          >
            Full details
          </button>
        </div>
      </div>
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

        <ProductStockDetails product={product} />

        <QuotationDetails quotation={product.quotation ?? null} />
      </div>
    </div>
  );
}

function ProductStockDetails({ product }: { product: ProductRow }) {
  const movements = product.movements ?? [];
  if (movements.length === 0) {
    return null;
  }

  let inbound = 0;
  let returns = 0;
  let consumed = 0;
  for (const movement of movements) {
    const type = String(movement.movementType ?? "").toLowerCase();
    const quantity = Number(movement.quantity ?? 0);
    if (type === "snapshot") continue;
    if (type === "consumption" || type === "used") {
      consumed += quantity;
    } else if (type === "return_to_stock") {
      returns += quantity;
    } else {
      inbound += quantity;
    }
  }

  return (
    <section className="mt-5">
      <h3 className="text-sm font-semibold">Stock</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Available stock"
          value={formatNumber(product.currentInventory ?? 0)}
        />
        <Metric label="Inbound" value={formatNumber(inbound)} />
        <Metric label="Returns" value={formatNumber(returns)} />
        <Metric label="Consumed" value={formatNumber(consumed)} />
      </div>
      <div className="mt-3 max-h-72 overflow-auto rounded-md border border-zinc-200">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-semibold">Date</th>
              <th className="px-3 py-2 font-semibold">Type</th>
              <th className="px-3 py-2 text-right font-semibold">Quantity</th>
              <th className="px-3 py-2 font-semibold">Reference</th>
              <th className="px-3 py-2 font-semibold">Comment</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {movements.map((movement, index) => (
              <tr key={`${movement.date}-${movement.reference}-${index}`}>
                <td className="whitespace-nowrap px-3 py-2 text-zinc-700">
                  {movement.date || "-"}
                </td>
                <td className="px-3 py-2">
                  <MovementTypeTag type={movement.type || "-"} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
                  {formatNumber(Number(movement.quantity ?? 0))}
                </td>
                <td className="px-3 py-2 text-zinc-500">
                  {movement.reference || "-"}
                </td>
                <td className="max-w-[16rem] px-3 py-2 text-zinc-500">
                  <p className="line-clamp-2" title={movement.comment}>
                    {movement.comment || "-"}
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
  const deliverySpans = quotationDeliverySpans(rows);

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
              rows.map((row, index) => (
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
                  {deliverySpans.has(index) ? (
                    <td
                      className="px-3 py-2 align-middle"
                      rowSpan={deliverySpans.get(index)}
                    >
                      {quotationValue(row.deliveryTime)}
                    </td>
                  ) : null}
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

// Mirrors Excel's merged Delivery date cells: consecutive rows sharing the
// same value render as one cell spanning the group.
function quotationDeliverySpans(rows: QuotationOfferRow[]) {
  const spans = new Map<number, number>();
  let index = 0;

  while (index < rows.length) {
    const value = quotationValue(rows[index].deliveryTime);
    let end = index + 1;
    while (
      end < rows.length &&
      quotationValue(rows[end].deliveryTime) === value
    ) {
      end += 1;
    }
    spans.set(index, end - index);
    index = end;
  }

  return spans;
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

function isProductRow(value: unknown): value is ProductRow {
  return (
    value !== null &&
    typeof value === "object" &&
    "name" in value &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

type ProductMatchRow = Record<string, SectionData["rows"][number][string]> & {
  id?: string;
  stockItemName?: string;
  suggestedProduct?: string;
  relationType?: string;
  confidenceScore?: number;
  quantityPerProduct?: number;
  confirmedByAdmin?: boolean;
  sourceSheet?: string;
  importFile?: string;
};

function ProductMatchingReviewSection({
  data,
  isLoading,
  onChanged,
}: {
  data: SectionData | null;
  isLoading: boolean;
  onChanged: () => void;
}) {
  const [savingId, setSavingId] = useState<string | null>(null);
  const rows = (data?.rows ?? []) as ProductMatchRow[];

  async function updateMatch(
    row: ProductMatchRow,
    action: "confirm" | "reject" | "edit",
  ) {
    if (!row.id) return;
    const body: Record<string, string | number> = { action };

    if (action === "edit") {
      const productName = window.prompt(
        "Suggested Quotation-NEW product",
        String(row.suggestedProduct ?? ""),
      );
      if (!productName) return;
      const relationType = window.prompt(
        "Relation type: alias, variant, or component",
        String(row.relationType ?? "alias"),
      );
      if (!relationType) return;
      const quantityValue = window.prompt(
        "Quantity per product",
        String(row.quantityPerProduct ?? 1),
      );
      body.productName = productName;
      body.relationType = relationType;
      body.quantityPerProduct = Number(quantityValue || 1);
    }

    setSavingId(row.id);
    const response = await apiFetch(`${apiBaseUrl}/product-matches/${row.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSavingId(null);

    if (response.ok) {
      onChanged();
    } else {
      window.alert(
        await responseErrorMessage(response, "Unable to update product match."),
      );
    }
  }

  if (isLoading) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-600">
        Loading product matches...
      </div>
    );
  }

  return (
    <Panel title={`Product Matching Review (${formatNumber(rows.length)})`}>
      {rows.length === 0 ? (
        <EmptyState label="No product matches to review." />
      ) : (
        <div className="overflow-hidden rounded-md border border-zinc-200">
          <table className="w-full table-fixed text-left text-sm">
            <colgroup>
              <col className="w-[18%]" />
              <col className="w-[26%]" />
              <col className="w-[11%]" />
              <col className="w-[10%]" />
              <col className="w-[10%]" />
              <col className="w-[9%]" />
              <col className="w-[16%]" />
            </colgroup>
            <thead className="bg-zinc-50">
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-3 py-3 font-semibold">Stock item</th>
                <th className="px-3 py-3 font-semibold">Suggested product</th>
                <th className="px-3 py-3 font-semibold">Type</th>
                <th className="px-3 py-3 text-right font-semibold">
                  Confidence
                </th>
                <th className="px-3 py-3 text-right font-semibold">Qty</th>
                <th className="px-3 py-3 font-semibold">Status</th>
                <th className="px-3 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((row) => (
                <tr className="align-top hover:bg-zinc-50" key={row.id}>
                  <td className="min-w-0 px-3 py-3">
                    <p className="truncate font-medium text-zinc-900">
                      {row.stockItemName || "-"}
                    </p>
                    <p className="mt-1 truncate text-xs text-zinc-500">
                      {row.sourceSheet || "-"}
                    </p>
                  </td>
                  <td className="min-w-0 px-3 py-3">
                    <p className="truncate text-zinc-700">
                      {row.suggestedProduct || "-"}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-zinc-700">
                    {row.relationType || "-"}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-zinc-700">
                    {formatNumber(Number(row.confidenceScore ?? 0))}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-zinc-700">
                    {formatNumber(Number(row.quantityPerProduct ?? 1))}
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        row.confirmedByAdmin
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {row.confirmedByAdmin ? "Confirmed" : "Review"}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex justify-end gap-2">
                      <button
                        className="h-8 rounded-md border border-zinc-300 px-2 text-xs font-medium transition hover:bg-white disabled:opacity-50"
                        disabled={savingId === row.id}
                        type="button"
                        onClick={() => updateMatch(row, "confirm")}
                      >
                        Confirm
                      </button>
                      <button
                        className="h-8 rounded-md border border-zinc-300 px-2 text-xs font-medium transition hover:bg-white disabled:opacity-50"
                        disabled={savingId === row.id}
                        type="button"
                        onClick={() => updateMatch(row, "edit")}
                      >
                        Edit
                      </button>
                      <button
                        className="h-8 rounded-md border border-red-200 px-2 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-50"
                        disabled={savingId === row.id}
                        type="button"
                        onClick={() => updateMatch(row, "reject")}
                      >
                        Reject
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

function SectionTable({
  data,
  isLoading,
  onSelectProduct,
  title,
}: {
  data: SectionData | null;
  isLoading: boolean;
  onSelectProduct?: (product: ProductRow) => void;
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
                    {column.key === "sku" && isProductRow(row.product) ? (
                      <button
                        className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-900 transition hover:bg-zinc-50"
                        type="button"
                        onClick={() => {
                          if (isProductRow(row.product)) {
                            onSelectProduct?.(row.product);
                          }
                        }}
                      >
                        {formatCellValue(row[column.key])}
                      </button>
                    ) : (
                      formatCellValue(row[column.key])
                    )}
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
