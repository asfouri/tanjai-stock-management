"use client";

import {
  ChangeEvent,
  Fragment,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
  AuthenticatedUser,
  FilterOptions,
  Filters,
  ImportBatchRow,
  ImportPreview,
  ManagedUser,
  UserStoreOption,
  ProductQuotation,
  ProductMovement,
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
  paymentType: "",
};

const sidebarItems: Array<{ id: SectionId; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "imports", label: "Imports" },
  { id: "products", label: "Products" },
  { id: "products-without-skus", label: "Products Without SKUs" },
  { id: "orders", label: "Orders" },
  { id: "stores", label: "Stores" },
  { id: "invoices", label: "Invoices" },
  { id: "payments", label: "Payments" },
  { id: "users", label: "User Management" },
];

const sectionAccessByRole: Record<string, readonly SectionId[]> = {
  TANJAI_ADMIN: sidebarItems.map((item) => item.id),
  BRAND_OWNER: [
    "dashboard",
    "products",
    "orders",
    "stores",
    "invoices",
    "payments",
  ],
  UFULFILL: [
    "dashboard",
    "products",
    "products-without-skus",
    "orders",
    "stores",
    "invoices",
  ],
};
const defaultSectionAccess: readonly SectionId[] = ["dashboard"];
const noSectionAccess: readonly SectionId[] = [];

const chartColors = ["#18181b", "#0f766e", "#b45309", "#991b1b", "#52525b"];

type CachedSectionId = Exclude<SectionId, "dashboard" | "imports" | "users">;
type SectionDataCache = Partial<Record<CachedSectionId, SectionData>>;
type LoadedSectionCache = Partial<Record<Exclude<SectionId, "dashboard">, true>>;

type DepositRequestRow = {
  id: string;
  requestedByEmail: string;
  transactionDate: string;
  amount: number;
  proofFileName: string;
  proofMimeType: string;
  proofAvailable: boolean;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
};

type NotificationItem = {
  id: string;
  type: "ORDER" | "DEPOSIT" | "IMPORT" | "ANOMALY" | "STOCK" | "PAYMENT";
  priority: "HIGH" | "MEDIUM" | "LOW";
  title: string;
  message: string;
  createdAt: string;
  section: "dashboard" | "imports" | "products" | "orders" | "payments";
};

export default function DashboardPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadedSectionQueryRef = useRef<Partial<Record<SectionId, string>>>({});
  const loadedSectionCacheRef = useRef<LoadedSectionCache>({});
  const [user, setUser] = useState<User | null>(null);
  const [authenticatedUser, setAuthenticatedUser] =
    useState<AuthenticatedUser | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>("dashboard");
  const [summary, setSummary] = useState<DashboardSummary>(emptySummary);
  const [sectionDataCache, setSectionDataCache] = useState<SectionDataCache>({});
  const [importBatches, setImportBatches] = useState<ImportBatchRow[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [productPage, setProductPage] = useState(1);
  const [selectedProduct, setSelectedProduct] = useState<ProductRow | null>(null);
  const [isLoadingProductDetails, setIsLoadingProductDetails] = useState(false);
  const [stockProduct, setStockProduct] = useState<ProductRow | null>(null);
  const [isLoadingStockDetails, setIsLoadingStockDetails] = useState(false);
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
  const [importStatusMessage, setImportStatusMessage] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const sectionData =
    activeSection !== "dashboard" &&
    activeSection !== "imports" &&
    activeSection !== "users"
      ? (sectionDataCache[activeSection] ?? null)
      : null;
  const isSectionLoading = loadingSection === activeSection;
  const debouncedOrderSearch = useDebouncedValue(filters.orderSearch, 300);
  const isTanjaiAdmin = authenticatedUser?.role === "TANJAI_ADMIN";
  const isBrandOwner = authenticatedUser?.role === "BRAND_OWNER";
  const isUfulfill = authenticatedUser?.role === "UFULFILL";
  const permittedSections = authenticatedUser
    ? (sectionAccessByRole[authenticatedUser.role] ?? noSectionAccess)
    : defaultSectionAccess;
  const visibleSidebarItems = sidebarItems.filter(
    (item) => permittedSections.includes(item.id),
  );

  useEffect(() => {
    if (
      authenticatedUser &&
      !permittedSections.includes(activeSection)
    ) {
      setActiveSection("dashboard");
    }
  }, [activeSection, authenticatedUser, permittedSections]);

  const filterQuery = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (
        key === "orderSearch" ||
        key === "orderSort" ||
        key === "invoiceDateFrom" ||
        key === "invoiceDateTo" ||
        key === "paymentType"
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

  const paymentSectionQuery = useMemo(() => {
    const params = new URLSearchParams();
    for (const key of ["store", "dateFrom", "dateTo", "paymentType"] as const) {
      const value = filters[key].trim();
      if (value) params.set(key, value);
    }
    return params.toString();
  }, [filters.store, filters.dateFrom, filters.dateTo, filters.paymentType]);

  const invoiceSectionQuery = useMemo(() => {
    const params = new URLSearchParams();
    for (const key of [
      "store",
      "invoice",
      "invoiceDateFrom",
      "invoiceDateTo",
    ] as const) {
      const value = filters[key].trim();
      if (value) params.set(key, value);
    }
    return params.toString();
  }, [
    filters.store,
    filters.invoice,
    filters.invoiceDateFrom,
    filters.invoiceDateTo,
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

        const authResponse = await apiFetch(`${apiBaseUrl}/auth/me`);
        const currentUser = authResponse.ok
          ? ((await authResponse.json()) as AuthenticatedUser)
          : null;

        if (isMounted) {
          setSummary(normalizeSummary(dashboardSummary));
          setAuthenticatedUser(currentUser);
        }
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
    if (activeSection === "dashboard" || activeSection === "users") {
      return;
    }

    const sectionQuery =
      activeSection === "orders"
        ? orderSectionQuery
        : activeSection === "payments"
          ? paymentSectionQuery
          : activeSection === "invoices"
            ? invoiceSectionQuery
          : "";

    if (
      loadedSectionCacheRef.current[activeSection] &&
      loadedSectionQueryRef.current[activeSection] === sectionQuery
    ) {
      setErrorMessage("");
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
            loadedSectionCacheRef.current = {
              ...loadedSectionCacheRef.current,
              imports: true,
            };
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
          loadedSectionCacheRef.current = {
            ...loadedSectionCacheRef.current,
            [activeSection]: true,
          };
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
  }, [
    activeSection,
    invoiceSectionQuery,
    orderSectionQuery,
    paymentSectionQuery,
    refreshKey,
  ]);

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
    loadedSectionCacheRef.current = {};
    loadedSectionQueryRef.current = {};
  }

  async function openProductDetails(product: ProductRow) {
    setSelectedProduct(product);
    setIsLoadingProductDetails(Boolean(product.id));
    setErrorMessage("");

    if (!product.id) {
      setIsLoadingProductDetails(false);
      return;
    }

    try {
      const response = await apiFetch(
        `${apiBaseUrl}/dashboard/product/${encodeURIComponent(product.id)}`,
      );

      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, "Unable to load product details."),
        );
      }

      const details = (await response.json()) as ProductRow;
      setSelectedProduct((current) =>
        current?.id === product.id ? details : current,
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to load product details.",
      );
    } finally {
      setIsLoadingProductDetails(false);
    }
  }

  async function openStockDetails(product: ProductRow) {
    setStockProduct(product);
    const detailId = product.inventoryItemId ?? product.id;
    setIsLoadingStockDetails(Boolean(detailId));
    setErrorMessage("");

    if (!detailId) {
      setIsLoadingStockDetails(false);
      return;
    }

    try {
      const path = product.inventoryItemId
        ? `dashboard/inventory-item/${encodeURIComponent(product.inventoryItemId)}`
        : `dashboard/product/${encodeURIComponent(detailId)}`;
      const response = await apiFetch(
        `${apiBaseUrl}/${path}`,
      );

      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, "Unable to load stock details."),
        );
      }

      const details = (await response.json()) as ProductRow;
      setStockProduct((current) =>
        (current?.inventoryItemId ?? current?.id) === detailId
          ? details
          : current,
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to load stock details.",
      );
    } finally {
      setIsLoadingStockDetails(false);
    }
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
    setImportStatusMessage("");

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

      const result = (await response.json()) as {
        ignored?: boolean;
        message?: string;
      };
      setPreview(null);
      setImportStatusMessage(
        result.message ??
          (result.ignored
            ? "This Excel file was already imported. No data was added."
            : "Excel file imported successfully."),
      );

      if (!result.ignored) {
        invalidateSectionCache();
        await refreshDashboard();
        setRefreshKey((value) => value + 1);
      }
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

  const cards: Array<[string, string]> = [
    ["Orders", formatNumber(summary.totalOrders)],
    ["Shipments", formatNumber(summary.totalShipments)],
    ["Invoices", formatNumber(summary.totalInvoices)],
    ...(!isUfulfill
      ? ([["Total costs", formatCurrency(summary.totalCosts)]] as Array<[
          string,
          string,
        ]>)
      : []),
    ...(isTanjaiAdmin
      ? ([["Current balance", formatCurrency(summary.currentBalance)]] as Array<[
          string,
          string,
        ]>)
      : []),
    ...(!isBrandOwner
      ? ([["Anomalies", formatNumber(summary.anomaliesDetected)]] as Array<[
          string,
          string,
        ]>)
      : []),
    ...(isUfulfill
      ? ([["Stock status", formatNumber(summary.stockStatus)]] as Array<[
          string,
          string,
        ]>)
      : []),
  ];

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-zinc-200 bg-white px-5 py-6 md:flex">
        <div className="text-lg font-semibold">TanjAI Stock</div>
        <nav className="mt-8 space-y-1" aria-label="Dashboard sections">
          {visibleSidebarItems.map((item) => {
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
        <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/95 px-5 py-4 backdrop-blur md:px-8">
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
                {authenticatedUser?.email || getUserDisplayName(user)}
              </p>
              {authenticatedUser ? (
                <NotificationsButton
                  user={authenticatedUser}
                  onNavigate={(section) => setActiveSection(section)}
                />
              ) : null}
              {isTanjaiAdmin ? (
                <>
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
                </>
              ) : null}
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
          {importStatusMessage ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
              {importStatusMessage}
            </div>
          ) : null}
          {errorMessage ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-700">
              {errorMessage}
            </div>
          ) : null}

          {activeSection === "dashboard" ? (
            <>
              <DashboardFilterPicker
                filterOptions={summary.filterOptions}
                filters={filters}
                onChange={setFilters}
              />

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
                    {!isUfulfill ? (
                      <Panel title="Costs by date">
                        <LinePanel
                          data={summary.costsByDate}
                          empty="No costs yet."
                        />
                      </Panel>
                    ) : null}
                    <Panel title="Orders by store">
                      <BarPanel
                        data={summary.ordersByStore}
                        empty="No store orders yet."
                      />
                    </Panel>
                    {!isUfulfill ? (
                      <>
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
                      </>
                    ) : null}
                    <Panel title="Stock by product">
                      <BarPanel
                        data={summary.stockByProduct}
                        empty="No stock movements yet."
                      />
                    </Panel>
                    {!isUfulfill ? (
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
                    ) : null}
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
            activeSection === "users" && isTanjaiAdmin ? (
              <UserManagementSection currentUser={authenticatedUser} />
            ) : activeSection === "imports" ? (
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
            ) : activeSection === "products" ||
              activeSection === "products-without-skus" ? (
              <ProductsSection
                data={sectionData}
                isLoading={isSectionLoading}
                page={productPage}
                search={productSearch}
                title={
                  activeSection === "products-without-skus"
                    ? "Products Without SKUs"
                    : "Products"
                }
                onPageChange={setProductPage}
                onSearchChange={(value) => {
                  setProductSearch(value);
                  setProductPage(1);
                }}
                onOpenStock={openStockDetails}
                onSelectProduct={openProductDetails}
              />
            ) : activeSection === "orders" ? (
              <div className="h-[calc(100vh-9rem)] min-h-[30rem] overflow-y-auto pr-1">
                  <OrdersSection
                    action={
                      <OrderFiltersPanel
                        filters={filters}
                        countries={summary.filterOptions.countries}
                        stores={summary.filterOptions.stores}
                        onChange={setFilters}
                      />
                    }
                    data={sectionData}
                    isLoading={isSectionLoading}
                    page={orderPage}
                    onPageChange={setOrderPage}
                    onSelectProduct={openProductDetails}
                  />
              </div>
            ) : activeSection === "payments" ? (
              <PaymentsSection
                currentUser={authenticatedUser!}
                data={sectionData}
                filters={filters}
                isLoading={isSectionLoading}
                limitedToSpending={false}
                stores={summary.filterOptions.stores}
                onChange={setFilters}
                onPaymentsChanged={async () => {
                  invalidateSectionCache();
                  await refreshDashboard();
                  setRefreshKey((value) => value + 1);
                }}
              />
            ) : activeSection === "invoices" ? (
              <SectionTable
                action={
                  <InvoiceFiltersButton
                    filters={filters}
                    stores={summary.filterOptions.stores}
                    onChange={setFilters}
                  />
                }
                data={sectionData}
                isLoading={isSectionLoading}
                title="Invoices"
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

            {isImporting ? (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                Saving this import can take a few minutes for large workbooks.
                Keep this tab open while the backend writes the records.
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
                {isImporting ? "Saving import..." : "Confirm import"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedProduct ? (
        <ProductDetailsModal
          isLoadingDetails={isLoadingProductDetails}
          product={selectedProduct}
          onClose={() => {
            setSelectedProduct(null);
            setIsLoadingProductDetails(false);
          }}
        />
      ) : null}

      {stockProduct ? (
        <ProductStockModal
          isLoadingDetails={isLoadingStockDetails}
          product={stockProduct}
          onClose={() => {
            setStockProduct(null);
            setIsLoadingStockDetails(false);
          }}
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

type DashboardFilterKey =
  | "brand"
  | "store"
  | "dateFrom"
  | "dateTo"
  | "sku"
  | "invoice"
  | "orderNumber"
  | "trackingNumber"
  | "country";

type DashboardFilterDefinition = {
  key: DashboardFilterKey;
  label: string;
  kind: "select" | "date" | "text";
  placeholder?: string;
  optionsKey?: keyof FilterOptions;
};

const dashboardFilterDefinitions: DashboardFilterDefinition[] = [
  {
    key: "brand",
    label: "Brand",
    kind: "select",
    placeholder: "All brands",
    optionsKey: "brands",
  },
  {
    key: "store",
    label: "Store",
    kind: "select",
    placeholder: "All stores",
    optionsKey: "stores",
  },
  { key: "dateFrom", label: "Date from", kind: "date" },
  { key: "dateTo", label: "Date to", kind: "date" },
  {
    key: "sku",
    label: "SKU",
    kind: "select",
    placeholder: "All SKUs",
    optionsKey: "skus",
  },
  {
    key: "invoice",
    label: "Invoice",
    kind: "select",
    placeholder: "All invoices",
    optionsKey: "invoices",
  },
  {
    key: "orderNumber",
    label: "Order number",
    kind: "text",
    placeholder: "Search order number",
  },
  {
    key: "trackingNumber",
    label: "Tracking number",
    kind: "text",
    placeholder: "Search tracking number",
  },
  {
    key: "country",
    label: "Country",
    kind: "select",
    placeholder: "All countries",
    optionsKey: "countries",
  },
];

function DashboardFilterPicker({
  filterOptions,
  filters,
  onChange,
}: {
  filterOptions: FilterOptions;
  filters: Filters;
  onChange: (filters: Filters) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<DashboardFilterKey[]>(() =>
    dashboardFilterDefinitions
      .filter((definition) => filters[definition.key].trim())
      .map((definition) => definition.key),
  );

  useEffect(() => {
    const valuedKeys = dashboardFilterDefinitions
      .filter((definition) => filters[definition.key].trim())
      .map((definition) => definition.key);
    if (valuedKeys.length === 0) return;
    setSelectedKeys((current) => uniqueFilterKeys([...current, ...valuedKeys]));
  }, [filters]);

  const activeKeys = selectedKeys.filter((key) =>
    dashboardFilterDefinitions.some((definition) => definition.key === key),
  );
  const availableFilters = dashboardFilterDefinitions.filter(
    (definition) => !activeKeys.includes(definition.key),
  );
  const appliedCount = dashboardFilterDefinitions.filter((definition) =>
    filters[definition.key].trim(),
  ).length;

  function addFilter(key: DashboardFilterKey) {
    setSelectedKeys((current) => uniqueFilterKeys([...current, key]));
    setIsAddMenuOpen(false);
  }

  function removeFilter(key: DashboardFilterKey) {
    setSelectedKeys((current) => current.filter((item) => item !== key));
    onChange({ ...filters, [key]: "" });
  }

  function clearFilters() {
    setSelectedKeys([]);
    setIsMenuOpen(false);
    setIsAddMenuOpen(false);
    onChange(initialFilters);
  }

  return (
    <div className="flex justify-end">
      <div className="relative">
        <button
          className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition ${
            appliedCount > 0
              ? "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700"
              : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
          }`}
          type="button"
          onClick={() => setIsMenuOpen((value) => !value)}
        >
          <FilterIcon />
          Filter
          {appliedCount > 0 ? (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-white px-1 text-[10px] text-zinc-900">
              {appliedCount}
            </span>
          ) : null}
        </button>

        {isMenuOpen ? (
          <div className="absolute right-0 top-10 z-30 w-[min(90vw,44rem)] rounded-lg border border-zinc-200 bg-white p-4 text-left shadow-xl">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Filter dashboard</h3>
              <button
                aria-label="Close dashboard filters"
                className="grid h-7 w-7 place-items-center rounded-md border border-zinc-300 text-zinc-600 hover:bg-zinc-50"
                type="button"
                onClick={() => {
                  setIsMenuOpen(false);
                  setIsAddMenuOpen(false);
                }}
              >
                <CloseIcon />
              </button>
            </div>

            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative">
          <button
                    className="h-8 rounded-md border border-zinc-300 bg-white px-3 text-xs font-medium transition hover:bg-zinc-50"
            type="button"
                    onClick={() => setIsAddMenuOpen((value) => !value)}
          >
            + Add filter
          </button>

                  {isAddMenuOpen ? (
                    <div className="absolute left-0 top-10 z-40 w-64 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg">
              {availableFilters.length > 0 ? (
                availableFilters.map((definition) => (
                  <button
                    className="block w-full px-3 py-2 text-left text-sm transition hover:bg-zinc-50"
                    key={definition.key}
                    type="button"
                    onClick={() => addFilter(definition.key)}
                  >
                    {definition.label}
                  </button>
                ))
              ) : (
                <div className="px-3 py-2 text-sm text-zinc-500">
                  All filters selected
                </div>
              )}
                    </div>
                  ) : null}
        </div>

        <div className="flex items-center gap-2">
          {appliedCount > 0 ? (
            <span className="text-sm text-zinc-500">
              {appliedCount} active
            </span>
          ) : null}
          <button
                  className="h-8 rounded-md border border-zinc-300 px-3 text-xs font-medium transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={activeKeys.length === 0 && appliedCount === 0}
            type="button"
            onClick={clearFilters}
          >
            Clear
          </button>
        </div>
      </div>

      {activeKeys.length > 0 ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {activeKeys.map((key) => {
            const definition = dashboardFilterDefinitions.find(
              (item) => item.key === key,
            );
            if (!definition) return null;
            return (
              <div className="grid gap-1" key={key}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-zinc-500">
                    {definition.label}
                  </span>
                  <button
                    className="text-xs font-medium text-zinc-500 transition hover:text-zinc-950"
                    type="button"
                    onClick={() => removeFilter(key)}
                  >
                    Remove
                  </button>
                </div>
                {renderDashboardFilterControl(
                  definition,
                  filterOptions,
                  filters,
                  onChange,
                )}
              </div>
            );
          })}
        </div>
      ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function renderDashboardFilterControl(
  definition: DashboardFilterDefinition,
  filterOptions: FilterOptions,
  filters: Filters,
  onChange: (filters: Filters) => void,
) {
  if (definition.kind === "select") {
    return (
      <FilterSelect
        label=""
        placeholder={definition.placeholder ?? "All"}
        options={definition.optionsKey ? filterOptions[definition.optionsKey] : []}
        value={filters[definition.key]}
        onChange={(value) => onChange({ ...filters, [definition.key]: value })}
      />
    );
  }

  return (
    <FilterInput
      label=""
      placeholder={definition.placeholder}
      type={definition.kind === "date" ? "date" : "text"}
      value={filters[definition.key]}
      onChange={(value) => onChange({ ...filters, [definition.key]: value })}
    />
  );
}

function uniqueFilterKeys(keys: DashboardFilterKey[]) {
  return keys.filter((key, index) => keys.indexOf(key) === index);
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
  title,
  onPageChange,
  onSearchChange,
  onOpenStock,
  onSelectProduct,
}: {
  data: SectionData | null;
  isLoading: boolean;
  page: number;
  search: string;
  title: string;
  onPageChange: (page: number) => void;
  onSearchChange: (value: string) => void;
  onOpenStock: (product: ProductRow) => void;
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
    <Panel title={title}>
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
                <col className="w-[29%]" />
                <col className="w-[33%]" />
                <col className="w-[8%]" />
                <col className="w-[7%]" />
                <col className="w-[7%]" />
                <col className="w-[9%]" />
              </colgroup>
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-2 py-3 font-semibold">Image</th>
                <th className="px-2 py-3 font-semibold">Product</th>
                <th className="px-2 py-3 font-semibold">SKU aliases</th>
                <th className="px-2 py-3 text-right font-semibold">Weight</th>
                <th className="px-2 py-3 text-right font-semibold">Lines</th>
                <th className="px-2 py-3 text-right font-semibold">Buys</th>
                <th className="px-2 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {visibleProducts.map((product) => (
                <tr
                  className="cursor-pointer align-top hover:bg-zinc-50"
                  key={productRowKey(product) as string}
                  onClick={() => {
                    if (product.id) onSelectProduct(product);
                  }}
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
                    <div className="flex justify-end gap-1.5">
                      {uniqueNonEmptyStrings(product.skuAliases).length > 0 ||
                      product.inventoryItemId ||
                      (product.inventoryMovements ?? 0) > 0 ? (
                        <button
                          className="rounded-md border border-teal-700 px-2 py-1.5 text-xs font-medium text-teal-800 transition hover:bg-teal-50"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenStock(product);
                          }}
                        >
                          Stock
                        </button>
                      ) : null}
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
                    </div>
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

function NotificationsButton({
  user,
  onNavigate,
}: {
  user: AuthenticatedUser;
  onNavigate: (section: NotificationItem["section"]) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastSeenAt, setLastSeenAt] = useState(0);
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [priorityFilter, setPriorityFilter] = useState("ALL");
  const [toastNotifications, setToastNotifications] = useState<
    NotificationItem[]
  >([]);
  const knownNotificationFingerprintsRef = useRef<Set<string> | null>(null);
  const storageKey = `tanjai.notifications.seen:${user.email.toLowerCase()}`;

  useEffect(() => {
    const storedValue = Number(window.localStorage.getItem(storageKey) ?? 0);
    setLastSeenAt(Number.isFinite(storedValue) ? storedValue : 0);
  }, [storageKey]);

  useEffect(() => {
    let isMounted = true;

    async function loadNotifications() {
      try {
        const response = await apiFetch(`${apiBaseUrl}/notifications`);
        if (!response.ok) {
          throw new Error(
            await responseErrorMessage(
              response,
              "Unable to load notifications.",
            ),
          );
        }
        const responseRows = (await response.json()) as NotificationItem[];
        const rows = Array.isArray(responseRows) ? responseRows : [];
        if (isMounted) {
          const fingerprints = new Set(rows.map(notificationFingerprint));
          const knownFingerprints = knownNotificationFingerprintsRef.current;
          if (knownFingerprints === null) {
            knownNotificationFingerprintsRef.current = fingerprints;
          } else {
            const newNotifications = rows.filter(
              (notification) =>
                !knownFingerprints.has(notificationFingerprint(notification)),
            );
            if (newNotifications.length > 0) {
              setToastNotifications((current) =>
                [...newNotifications, ...current]
                  .filter(
                    (notification, index, all) =>
                      all.findIndex(
                        (item) =>
                          notificationFingerprint(item) ===
                          notificationFingerprint(notification),
                      ) === index,
                  )
                  .slice(0, 4),
              );
            }
            knownNotificationFingerprintsRef.current = new Set([
              ...knownFingerprints,
              ...fingerprints,
            ]);
          }
          setNotifications(rows);
          setError("");
        }
      } catch (loadError) {
        if (isMounted) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Unable to load notifications.",
          );
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    void loadNotifications();
    const intervalId = window.setInterval(() => {
      void loadNotifications();
    }, 15_000);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const unreadCount = notifications.filter(
    (notification) =>
      new Date(notification.createdAt).getTime() > lastSeenAt,
  ).length;
  const visibleNotifications = notifications.filter(
    (notification) =>
      (typeFilter === "ALL" || notification.type === typeFilter) &&
      (priorityFilter === "ALL" || notification.priority === priorityFilter),
  );

  function markAllRead() {
    const now = Date.now();
    window.localStorage.setItem(storageKey, String(now));
    setLastSeenAt(now);
  }

  function toggleNotifications() {
    setIsOpen((current) => {
      const next = !current;
      if (next) markAllRead();
      return next;
    });
  }

  function removeToast(notification: NotificationItem) {
    const fingerprint = notificationFingerprint(notification);
    setToastNotifications((current) =>
      current.filter((item) => notificationFingerprint(item) !== fingerprint),
    );
  }

  return (
    <div className="relative">
      <button
        aria-label="Notifications"
        className="relative grid h-10 w-10 place-items-center rounded-md border border-zinc-300 bg-white text-zinc-700 transition hover:bg-zinc-50 hover:text-zinc-950"
        title="Notifications"
        type="button"
        onClick={toggleNotifications}
      >
        <BellIcon />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full border-2 border-white bg-red-600 px-1 text-[10px] font-semibold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div className="absolute right-0 top-12 z-50 w-[min(90vw,24rem)] overflow-hidden rounded-lg border border-zinc-200 bg-white text-left shadow-xl">
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-950">
                Notifications
              </h2>
              <p className="mt-0.5 text-xs text-zinc-500">
                Recent activity for your account
              </p>
            </div>
            <button
              aria-label="Close notifications"
              className="grid h-7 w-7 place-items-center rounded-md border border-zinc-300 text-zinc-600 hover:bg-zinc-50"
              type="button"
              onClick={() => setIsOpen(false)}
            >
              <CloseIcon />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-3">
            <label className="grid gap-1 text-[11px] font-medium text-zinc-500">
              Type
              <select
                className="h-8 rounded-md border border-zinc-300 bg-white px-2 text-xs text-zinc-900 outline-none focus:border-zinc-900"
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
              >
                <option value="ALL">All types</option>
                <option value="STOCK">Stock</option>
                <option value="PAYMENT">Payments</option>
                <option value="DEPOSIT">Deposits</option>
                <option value="ORDER">Orders</option>
                <option value="ANOMALY">Anomalies</option>
                <option value="IMPORT">Imports</option>
              </select>
            </label>
            <label className="grid gap-1 text-[11px] font-medium text-zinc-500">
              Priority
              <select
                className="h-8 rounded-md border border-zinc-300 bg-white px-2 text-xs text-zinc-900 outline-none focus:border-zinc-900"
                value={priorityFilter}
                onChange={(event) => setPriorityFilter(event.target.value)}
              >
                <option value="ALL">All priorities</option>
                <option value="HIGH">High</option>
                <option value="MEDIUM">Medium</option>
                <option value="LOW">Low</option>
              </select>
            </label>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {isLoading ? (
              <p className="px-4 py-8 text-center text-sm text-zinc-500">
                Loading notifications...
              </p>
            ) : error ? (
              <p className="px-4 py-8 text-center text-sm text-red-600">
                {error}
              </p>
            ) : notifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-zinc-500">
                No notifications yet.
              </p>
            ) : visibleNotifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-zinc-500">
                No notifications match these filters.
              </p>
            ) : (
              visibleNotifications.map((notification) => (
                <button
                  className="flex w-full gap-3 border-b border-zinc-100 px-4 py-3 text-left transition last:border-b-0 hover:bg-zinc-50"
                  key={notification.id}
                  type="button"
                  onClick={() => {
                    markAllRead();
                    setIsOpen(false);
                    onNavigate(notification.section);
                  }}
                >
                  <span className="mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-zinc-100 text-zinc-700">
                    <NotificationTypeIcon type={notification.type} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium text-zinc-950">
                        {notification.title}
                      </span>
                      <NotificationPriorityBadge
                        priority={notification.priority}
                      />
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-zinc-600">
                      {notification.message}
                    </span>
                    <span className="mt-1 block text-[11px] text-zinc-400">
                      {new Date(notification.createdAt).toLocaleString()}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}

      {typeof document !== "undefined" && toastNotifications.length > 0
        ? createPortal(
            <div
              aria-live="polite"
              className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-[min(92vw,24rem)] flex-col gap-3"
            >
              {toastNotifications.map((notification) => (
                <NotificationToast
                  key={notificationFingerprint(notification)}
                  notification={notification}
                  onClose={() => removeToast(notification)}
                  onOpen={() => {
                    removeToast(notification);
                    onNavigate(notification.section);
                  }}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function notificationFingerprint(notification: NotificationItem) {
  return [
    notification.id,
    notification.priority,
    notification.createdAt,
    notification.message,
  ].join("|");
}

function NotificationToast({
  notification,
  onClose,
  onOpen,
}: {
  notification: NotificationItem;
  onClose: () => void;
  onOpen: () => void;
}) {
  useEffect(() => {
    const timeoutId = window.setTimeout(onClose, 8_000);
    return () => window.clearTimeout(timeoutId);
  }, [onClose]);

  const priorityBorder =
    notification.priority === "HIGH"
      ? "border-l-red-600"
      : notification.priority === "MEDIUM"
        ? "border-l-amber-500"
        : "border-l-zinc-400";

  return (
    <article
      className={`notification-toast-enter pointer-events-auto overflow-hidden rounded-lg border border-l-4 border-zinc-200 ${priorityBorder} bg-white shadow-2xl`}
    >
      <div className="flex items-start gap-3 p-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-zinc-100 text-zinc-700">
          <NotificationTypeIcon type={notification.type} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-sm font-semibold text-zinc-950">
              {notification.title}
            </p>
            <NotificationPriorityBadge priority={notification.priority} />
          </div>
          <p className="mt-1 text-xs leading-5 text-zinc-600">
            {notification.message}
          </p>
        </div>
        <button
          aria-label="Dismiss notification"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          type="button"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <button
        className="h-10 w-full border-t border-zinc-200 bg-zinc-50 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100"
        type="button"
        onClick={onOpen}
      >
        Open
      </button>
    </article>
  );
}

function BellIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </svg>
  );
}

function NotificationTypeIcon({ type }: { type: NotificationItem["type"] }) {
  if (type === "STOCK") return <span className="text-sm font-semibold">□</span>;
  if (type === "PAYMENT") return <span className="text-sm font-semibold">$</span>;
  if (type === "DEPOSIT") return <span className="text-sm font-semibold">$</span>;
  if (type === "IMPORT") return <span className="text-sm font-semibold">↥</span>;
  if (type === "ANOMALY") return <span className="text-sm font-semibold">!</span>;
  return <span className="text-sm font-semibold">#</span>;
}

function NotificationPriorityBadge({
  priority,
}: {
  priority: NotificationItem["priority"];
}) {
  const style =
    priority === "HIGH"
      ? "bg-red-50 text-red-700"
      : priority === "MEDIUM"
        ? "bg-amber-50 text-amber-700"
        : "bg-zinc-100 text-zinc-600";
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold tracking-wide ${style}`}
    >
      {priority}
    </span>
  );
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

function InvoiceFiltersButton({
  filters,
  stores,
  onChange,
}: {
  filters: Filters;
  stores: string[];
  onChange: (filters: Filters) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const activeFilterCount = [
    filters.store,
    filters.invoice,
    filters.invoiceDateFrom,
    filters.invoiceDateTo,
  ].filter(Boolean).length;
  return (
    <div className="relative">
      <button
        className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition ${
          activeFilterCount > 0
            ? "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700"
            : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
        }`}
        type="button"
        onClick={() => setIsOpen((value) => !value)}
      >
        <FilterIcon />
        Filter
        {activeFilterCount > 0 ? (
          <span className="grid h-4 min-w-4 place-items-center rounded-full bg-white px-1 text-[10px] text-zinc-900">
            {activeFilterCount}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div className="absolute right-0 top-10 z-30 w-[min(90vw,36rem)] rounded-lg border border-zinc-200 bg-white p-4 text-left shadow-xl">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Filter invoices</h3>
            <button
              aria-label="Close invoice filters"
              className="grid h-7 w-7 place-items-center rounded-md border border-zinc-300 text-zinc-600 hover:bg-zinc-50"
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
            <FilterInput
              label="Invoice"
              placeholder="Search invoice reference"
              value={filters.invoice}
              onChange={(value) => onChange({ ...filters, invoice: value })}
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
              className="h-8 rounded-md border border-zinc-300 px-3 text-xs font-medium hover:bg-zinc-50"
              type="button"
              onClick={() =>
                onChange({
                  ...filters,
                  store: "",
                  invoice: "",
                  invoiceDateFrom: "",
                  invoiceDateTo: "",
                })
              }
            >
              Clear
            </button>
            <button
              className="h-8 rounded-md bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-700"
              type="button"
              onClick={() => setIsOpen(false)}
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
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
  const totalActiveCount =
    activeFilterCount +
    (filters.orderSearch ? 1 : 0) +
    (filters.orderSort ? 1 : 0);
  const nextOrderSort = filters.orderSort === "asc" ? "desc" : "asc";
  const orderSortLabel =
    filters.orderSort === "asc"
      ? "Order ID asc"
      : filters.orderSort === "desc"
        ? "Order ID desc"
        : "Order ID";

  return (
    <div className="relative">
      <button
        className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition ${
          totalActiveCount > 0
            ? "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700"
            : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
        }`}
        type="button"
        onClick={() => setIsOpen((value) => !value)}
      >
        <FilterIcon />
        Filter
        {totalActiveCount > 0 ? (
          <span className="grid h-4 min-w-4 place-items-center rounded-full bg-white px-1 text-[10px] text-zinc-900">
            {totalActiveCount}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div className="absolute right-0 top-10 z-30 w-[min(90vw,42rem)] rounded-lg border border-zinc-200 bg-white p-4 text-left shadow-xl">
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

          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="grid min-w-0 gap-1 text-xs font-medium text-zinc-500">
              Search orders
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400">
                  <SearchIcon />
                </span>
                <input
                  className="h-9 w-full rounded-md border border-zinc-300 bg-white pl-9 pr-9 text-sm text-zinc-900 outline-none transition focus:border-zinc-900"
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
            <button
              className={`inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-xs font-medium transition ${
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
                  orderSearch: "",
                  orderSort: "",
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
    </div>
  );
}

function OrdersSection({
  action,
  data,
  isLoading,
  page,
  onPageChange,
  onSelectProduct,
}: {
  action?: ReactNode;
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
      <Panel action={action} title="Orders">
        <p className="text-sm text-zinc-600">Loading orders...</p>
      </Panel>
    );
  }

  if (rows.length === 0) {
    return (
      <Panel action={action} title="Orders">
        <EmptyState label="No orders found." />
      </Panel>
    );
  }

  return (
    <>
      <Panel action={action} title={`Orders (${formatNumber(totalOrders)})`}>
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
  isLoadingDetails,
  product,
  onClose,
}: {
  isLoadingDetails: boolean;
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

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
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
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <PreviewList title="All SKU aliases" items={skus} />
          <PreviewList title="Linked stores" items={stores} />
        </div>

        {isLoadingDetails ? (
          <div className="mt-5 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">
            Loading product details...
          </div>
        ) : null}

        <QuotationDetails quotation={product.quotation ?? null} />
      </div>
    </div>
  );
}

function ProductStockModal({
  isLoadingDetails,
  product,
  onClose,
}: {
  isLoadingDetails: boolean;
  product: ProductRow;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">
              {product.description || product.name}
            </h2>
            <p className="mt-1 truncate text-sm text-zinc-500">
              {product.name}
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

        {isLoadingDetails ? (
          <div className="mt-5 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">
            Loading stock table...
          </div>
        ) : (
          <StockExcelTable movements={product.movements ?? []} />
        )}
      </div>
    </div>
  );
}

type StockTableRow = {
  date: string;
  stock?: number;
  used?: number;
  left?: number;
};

function StockExcelTable({ movements }: { movements: ProductMovement[] }) {
  const rows = buildStockTableRows(movements);

  if (rows.length === 0) {
    return (
      <p className="mt-3 rounded-md border border-dashed border-zinc-200 p-3 text-sm text-zinc-500">
        No stock table data.
      </p>
    );
  }

  return (
    <div className="mt-5 overflow-auto rounded-md border border-zinc-300">
      <table className="w-full min-w-[34rem] table-fixed border-collapse text-center text-sm">
        <colgroup>
          <col className="w-[28%]" />
          <col className="w-[24%]" />
          <col className="w-[24%]" />
          <col className="w-[24%]" />
        </colgroup>
        <thead>
          <tr>
            <th className="border border-zinc-300 bg-white px-3 py-2 font-semibold">
              Date
            </th>
            <th className="border border-zinc-300 bg-white px-3 py-2 font-semibold">
              stock
            </th>
            <th className="border border-zinc-300 bg-white px-3 py-2 font-semibold">
              used
            </th>
            <th className="border border-zinc-300 bg-white px-3 py-2 font-semibold">
              left
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.date}>
              <td className="border border-zinc-300 px-3 py-2 tabular-nums">
                {row.date}
              </td>
              <td className="border border-zinc-300 px-3 py-2 tabular-nums">
                {formatStockTableCell(row.stock)}
              </td>
              <td className="border border-zinc-300 px-3 py-2 tabular-nums">
                {formatStockTableCell(row.used)}
              </td>
              <td className="border border-zinc-300 px-3 py-2 tabular-nums">
                {formatStockTableCell(row.left)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function buildStockTableRows(movements: ProductMovement[]): StockTableRow[] {
  const byDate = new Map<string, StockTableRow & { snapshot?: number }>();

  for (const movement of movements) {
    const date = movement.date || "-";
    const quantity = Number(movement.quantity ?? 0);
    if (!Number.isFinite(quantity)) continue;

    const row = byDate.get(date) ?? { date };
    const kind = stockMovementKind(movement.movementType);

    if (kind === "left") {
      row.snapshot = quantity;
    } else if (kind === "used") {
      row.used = (row.used ?? 0) + quantity;
    } else if (kind === "stock") {
      row.stock = (row.stock ?? 0) + quantity;
    }

    byDate.set(date, row);
  }

  const rows = [...byDate.values()].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  repairLegacyCombinedLeftRows(rows);
  const hasSnapshots = rows.some((row) => row.snapshot !== undefined);
  let runningLeft = 0;

  return rows.map((row) => {
    runningLeft += (row.stock ?? 0) - (row.used ?? 0);
    return {
      date: row.date,
      stock: row.stock,
      used: row.used,
      left:
        row.snapshot !== undefined
          ? row.snapshot
          : hasSnapshots
            ? undefined
            : runningLeft,
    };
  });
}

function repairLegacyCombinedLeftRows(
  rows: Array<StockTableRow & { snapshot?: number }>,
) {
  let previousLeft: number | undefined;

  for (const row of rows) {
    if (
      row.snapshot === undefined &&
      previousLeft !== undefined &&
      row.stock !== undefined &&
      row.used !== undefined &&
      row.stock > previousLeft
    ) {
      const inferredLeft = row.stock - previousLeft;
      if (inferredLeft >= 0) {
        row.stock = previousLeft;
        row.snapshot = inferredLeft;
      }
    }

    if (row.snapshot !== undefined) {
      previousLeft = row.snapshot;
    } else if (row.stock !== undefined || row.used !== undefined) {
      previousLeft = (previousLeft ?? 0) + (row.stock ?? 0) - (row.used ?? 0);
    }
  }
}

function formatStockTableCell(value: number | undefined) {
  return value === undefined ? "" : formatNumber(value);
}

function stockMovementKind(type: string | null | undefined) {
  const normalized = String(type ?? "").trim().toLowerCase();
  if (!normalized) return "ignore";
  if (
    normalized === "snapshot" ||
    normalized === "left" ||
    normalized.includes("left")
  ) {
    return "left";
  }
  if (
    normalized === "consumption" ||
    normalized === "used" ||
    normalized.includes("consum")
  ) {
    return "used";
  }
  if (
    normalized === "stock" ||
    normalized === "inbound" ||
    normalized === "return_to_stock" ||
    normalized.includes("return")
  ) {
    return "stock";
  }
  return "ignore";
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

function UserManagementSection({
  currentUser,
}: {
  currentUser: AuthenticatedUser;
}) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [storeOptions, setStoreOptions] = useState<UserStoreOption[]>([]);
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("BRAND_OWNER");
  const [isLoadingUsers, setIsLoadingUsers] = useState(true);
  const [isCreatingUser, setIsCreatingUser] = useState(false);
  const [isCreateUserOpen, setIsCreateUserOpen] = useState(false);
  const [isStorePickerOpen, setIsStorePickerOpen] = useState(false);
  const [createError, setCreateError] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [userRefreshKey, setUserRefreshKey] = useState(0);
  const [userSearch, setUserSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [modifyUser, setModifyUser] = useState<ManagedUser | null>(null);
  const [modifyName, setModifyName] = useState("");
  const [modifyEmail, setModifyEmail] = useState("");
  const [modifyPassword, setModifyPassword] = useState("");
  const [modifyRole, setModifyRole] = useState("");
  const [modifyStoreIds, setModifyStoreIds] = useState<string[]>([]);
  const [isModifyStorePickerOpen, setIsModifyStorePickerOpen] = useState(false);
  const [deleteUser, setDeleteUser] = useState<ManagedUser | null>(null);
  const [isUpdatingUser, setIsUpdatingUser] = useState(false);
  const [actionError, setActionError] = useState("");

  const filteredUsers = useMemo(() => {
    const query = userSearch.trim().toLowerCase();
    return users.filter((managedUser) => {
      const matchesSearch =
        !query ||
        managedUser.name.toLowerCase().includes(query) ||
        managedUser.email.toLowerCase().includes(query);
      const matchesRole =
        !roleFilter ||
        (roleFilter === "NO_ROLE"
          ? !managedUser.role
          : managedUser.role === roleFilter);
      return matchesSearch && matchesRole;
    });
  }, [roleFilter, userSearch, users]);
  const storeNameById = useMemo(
    () => new Map(storeOptions.map((store) => [store.id, store.name])),
    [storeOptions],
  );

  useEffect(() => {
    let isMounted = true;

    async function loadUsers() {
      setIsLoadingUsers(true);
      setError("");
      const [response, storeResponse] = await Promise.all([
        apiFetch(`${apiBaseUrl}/users`),
        apiFetch(`${apiBaseUrl}/users/store-options`),
      ]);

      if (!response.ok) {
        const responseMessage = await responseErrorMessage(
          response,
          "Unable to load users.",
        );
        if (isMounted) setError(responseMessage);
      } else {
        const data = (await response.json()) as ManagedUser[];
        if (isMounted) setUsers(data);
      }

      if (!storeResponse.ok) {
        const responseMessage = await responseErrorMessage(
          storeResponse,
          "Unable to load stores.",
        );
        if (isMounted) setError(responseMessage);
      } else {
        const data = (await storeResponse.json()) as UserStoreOption[];
        if (isMounted) setStoreOptions(data);
      }

      if (isMounted) setIsLoadingUsers(false);
    }

    void loadUsers();
    return () => {
      isMounted = false;
    };
  }, [userRefreshKey]);

  async function createUser() {
    setCreateError("");
    setMessage("");
    setIsCreatingUser(true);

    try {
      const response = await apiFetch(`${apiBaseUrl}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password,
          role,
          storeIds: role === "BRAND_OWNER" ? selectedStoreIds : [],
        }),
      });

      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, "Unable to create user."),
        );
      }

      setName("");
      setEmail("");
      setPassword("");
      setRole("BRAND_OWNER");
      setSelectedStoreIds([]);
      setIsStorePickerOpen(false);
      setIsCreateUserOpen(false);
      setMessage("User created successfully.");
      setUserRefreshKey((value) => value + 1);
    } catch (createError) {
      setCreateError(
        createError instanceof Error
          ? createError.message
          : "Unable to create user.",
      );
    } finally {
      setIsCreatingUser(false);
    }
  }

  async function updateUser() {
    if (!modifyUser) return;
    setActionError("");
    setMessage("");
    setIsUpdatingUser(true);

    try {
      const response = await apiFetch(
        `${apiBaseUrl}/users/${modifyUser.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: modifyName,
            email: modifyEmail,
            password: modifyPassword,
            role: modifyRole,
            storeIds: modifyRole === "BRAND_OWNER" ? modifyStoreIds : [],
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, "Unable to update user."),
        );
      }
      setModifyUser(null);
      setModifyPassword("");
      setIsModifyStorePickerOpen(false);
      setMessage(`${modifyEmail} was updated.`);
      setUserRefreshKey((value) => value + 1);
    } catch (updateError) {
      setActionError(
        updateError instanceof Error
          ? updateError.message
          : "Unable to update user.",
      );
    } finally {
      setIsUpdatingUser(false);
    }
  }

  async function confirmDeleteUser() {
    if (!deleteUser) return;
    setActionError("");
    setMessage("");
    setIsUpdatingUser(true);

    try {
      const response = await apiFetch(`${apiBaseUrl}/users/${deleteUser.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, "Unable to remove user."),
        );
      }
      const removedEmail = deleteUser.email;
      setDeleteUser(null);
      setMessage(`${removedEmail} was removed.`);
      setUserRefreshKey((value) => value + 1);
    } catch (deleteError) {
      setActionError(
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to remove user.",
      );
    } finally {
      setIsUpdatingUser(false);
    }
  }

  return (
    <div className="space-y-5">
      {message ? (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {isCreateUserOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Create user</h2>
                <p className="mt-1 text-sm text-zinc-500">
                  Enter the account details and choose its access role.
                </p>
              </div>
              <button
                aria-label="Close create user dialog"
                className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-50"
                disabled={isCreatingUser}
                type="button"
                onClick={() => setIsCreateUserOpen(false)}
              >
                Close
              </button>
            </div>
            <form
              className="grid gap-4 md:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                void createUser();
              }}
            >
          <label className="grid gap-1 text-xs font-medium text-zinc-500">
            Name
            <input
              className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none transition focus:border-zinc-900"
              placeholder="Full name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-zinc-500">
            Email
            <input
              required
              className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none transition focus:border-zinc-900"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-zinc-500">
            Temporary password
            <input
              required
              className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none transition focus:border-zinc-900"
              minLength={8}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-zinc-500">
            Role
            <select
              className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none transition focus:border-zinc-900"
              value={role}
              onChange={(event) => {
                const nextRole = event.target.value;
                setRole(nextRole);
                if (nextRole !== "BRAND_OWNER") {
                  setSelectedStoreIds([]);
                  setIsStorePickerOpen(false);
                }
              }}
            >
              <option value="BRAND_OWNER">Brand owner</option>
              <option value="UFULFILL">UFULFILL</option>
              <option value="TANJAI_ADMIN">TanjAI admin</option>
            </select>
          </label>
          {role === "BRAND_OWNER" ? (
            <div className="relative grid gap-1 md:col-span-2">
              <span className="text-xs font-medium text-zinc-500">
                Associated stores
              </span>
              <button
                aria-expanded={isStorePickerOpen}
                className="flex h-10 items-center justify-between rounded-md border border-zinc-300 bg-white px-3 text-left text-sm text-zinc-900 outline-none transition hover:bg-zinc-50 focus:border-zinc-900"
                disabled={storeOptions.length === 0}
                type="button"
                onClick={() => setIsStorePickerOpen((value) => !value)}
              >
                <span className="truncate">
                  {selectedStoreIds.length === 0
                    ? storeOptions.length === 0
                      ? "No stores available"
                      : "Select one or more stores"
                    : selectedStoreIds.length === 1
                      ? (storeOptions.find(
                          (store) => store.id === selectedStoreIds[0],
                        )?.name ?? "1 store selected")
                      : `${selectedStoreIds.length} stores selected`}
                </span>
                <span aria-hidden="true" className="ml-3 text-zinc-500">
                  &#9662;
                </span>
              </button>

              {isStorePickerOpen ? (
                <div className="absolute left-0 right-0 top-[4.25rem] z-20 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg">
                  <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
                    <span className="text-xs text-zinc-500">
                      {selectedStoreIds.length} selected
                    </span>
                    <div className="flex gap-3">
                      <button
                        className="text-xs font-medium text-zinc-600 hover:text-zinc-950"
                        type="button"
                        onClick={() =>
                          setSelectedStoreIds(
                            storeOptions.map((store) => store.id),
                          )
                        }
                      >
                        Select all
                      </button>
                      <button
                        className="text-xs font-medium text-zinc-600 hover:text-zinc-950"
                        type="button"
                        onClick={() => setSelectedStoreIds([])}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="max-h-52 overflow-y-auto p-1">
                    {storeOptions.map((store) => (
                      <label
                        className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm hover:bg-zinc-50"
                        key={store.id}
                      >
                        <input
                          checked={selectedStoreIds.includes(store.id)}
                          className="h-4 w-4 accent-zinc-950"
                          type="checkbox"
                          onChange={(event) =>
                            setSelectedStoreIds((current) =>
                              event.target.checked
                                ? [...current, store.id]
                                : current.filter((id) => id !== store.id),
                            )
                          }
                        />
                        <span className="truncate">{store.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

              <div className="flex justify-end gap-2 md:col-span-2">
                <button
                  className="h-10 rounded-md border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50"
                  disabled={isCreatingUser}
                  type="button"
                  onClick={() => setIsCreateUserOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
                  disabled={
                    isCreatingUser ||
                    (role === "BRAND_OWNER" &&
                      selectedStoreIds.length === 0)
                  }
                  type="submit"
                >
                  {isCreatingUser ? "Creating..." : "Create user"}
                </button>
              </div>
            </form>
            {createError ? (
              <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {createError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800"
          type="button"
          onClick={() => {
            setName("");
            setEmail("");
            setPassword("");
            setRole("BRAND_OWNER");
            setSelectedStoreIds([]);
            setIsStorePickerOpen(false);
            setCreateError("");
            setIsCreateUserOpen(true);
          }}
        >
          + Create user
        </button>
      </div>

      <Panel
        title={`Users (${formatNumber(filteredUsers.length)}${
          filteredUsers.length !== users.length
            ? ` of ${formatNumber(users.length)}`
            : ""
        })`}
      >
        <div className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_16rem]">
          <label className="grid gap-1 text-xs font-medium text-zinc-500">
            Search
            <input
              className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none transition focus:border-zinc-900"
              placeholder="Search by name or email"
              type="search"
              value={userSearch}
              onChange={(event) => setUserSearch(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-zinc-500">
            User type
            <select
              className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none transition focus:border-zinc-900"
              value={roleFilter}
              onChange={(event) => setRoleFilter(event.target.value)}
            >
              <option value="">All user types</option>
              <option value="TANJAI_ADMIN">TanjAI admin</option>
              <option value="BRAND_OWNER">Brand owner</option>
              <option value="UFULFILL">UFULFILL</option>
              <option value="NO_ROLE">No role</option>
            </select>
          </label>
        </div>

        {isLoadingUsers ? (
          <p className="text-sm text-zinc-600">Loading users...</p>
        ) : filteredUsers.length === 0 ? (
          <EmptyState
            label={
              users.length === 0
                ? "No users found."
                : "No users match the current search and type filter."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-3 py-3 font-semibold">Name</th>
                  <th className="px-3 py-3 font-semibold">Email</th>
                  <th className="px-3 py-3 font-semibold">Role</th>
                  <th className="px-3 py-3 font-semibold">Stores</th>
                  <th className="px-3 py-3 font-semibold">Created</th>
                  <th className="px-3 py-3 font-semibold">Last sign in</th>
                  <th className="px-3 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {filteredUsers.map((managedUser) => {
                  const isCurrentUser =
                    managedUser.id === currentUser.id ||
                    managedUser.email.toLowerCase() ===
                      currentUser.email.toLowerCase();
                  return (
                  <tr className="hover:bg-zinc-50" key={managedUser.id}>
                    <td className="px-3 py-3 font-medium text-zinc-900">
                      {managedUser.name || "—"}
                    </td>
                    <td className="px-3 py-3 text-zinc-700">
                      {managedUser.email}
                    </td>
                    <td className="px-3 py-3 text-zinc-700">
                      {managedUser.role
                        ? managedUser.role.replaceAll("_", " ")
                        : "No role"}
                    </td>
                    <td
                      className="max-w-xs px-3 py-3 text-zinc-700"
                      title={(managedUser.storeIds ?? [])
                        .map((storeId) => storeNameById.get(storeId) ?? storeId)
                        .join(", ")}
                    >
                      {managedUser.role === "BRAND_OWNER"
                        ? (managedUser.storeIds ?? [])
                            .map(
                              (storeId) =>
                                storeNameById.get(storeId) ?? "Unknown store",
                            )
                            .join(", ") || "No stores"
                        : "—"}
                    </td>
                    <td className="px-3 py-3 text-zinc-700">
                      {formatDate(managedUser.createdAt)}
                    </td>
                    <td className="px-3 py-3 text-zinc-700">
                      {managedUser.lastSignInAt
                        ? formatDate(managedUser.lastSignInAt)
                        : "Never"}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          className="h-8 rounded-md border border-zinc-300 px-3 text-xs font-medium transition hover:bg-white"
                          type="button"
                          onClick={() => {
                            setActionError("");
                            setModifyName(managedUser.name);
                            setModifyEmail(managedUser.email);
                            setModifyPassword("");
                            setModifyRole(managedUser.role || "BRAND_OWNER");
                            setModifyStoreIds(managedUser.storeIds ?? []);
                            setIsModifyStorePickerOpen(false);
                            setModifyUser(managedUser);
                          }}
                        >
                          Modify
                        </button>
                        <button
                          className="h-8 rounded-md border border-red-200 px-3 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={isCurrentUser}
                          title={
                            isCurrentUser
                              ? "You cannot remove your own account."
                              : "Remove user"
                          }
                          type="button"
                          onClick={() => {
                            setActionError("");
                            setDeleteUser(managedUser);
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {modifyUser ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4">
          <form
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-5 shadow-xl"
            onSubmit={(event) => {
              event.preventDefault();
              void updateUser();
            }}
          >
            <h2 className="text-lg font-semibold">Modify user</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Update the account information and access permissions.
            </p>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <label className="grid gap-1 text-xs font-medium text-zinc-500">
                Name
                <input
                  autoFocus
                  className="h-10 rounded-md border border-zinc-300 px-3 text-sm text-zinc-900 outline-none focus:border-zinc-900"
                  type="text"
                  value={modifyName}
                  onChange={(event) => setModifyName(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-zinc-500">
                Email
                <input
                  required
                  className="h-10 rounded-md border border-zinc-300 px-3 text-sm text-zinc-900 outline-none focus:border-zinc-900"
                  type="email"
                  value={modifyEmail}
                  onChange={(event) => setModifyEmail(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-zinc-500">
                New password
                <input
                  className="h-10 rounded-md border border-zinc-300 px-3 text-sm text-zinc-900 outline-none focus:border-zinc-900"
                  minLength={8}
                  placeholder="Leave blank to keep the current password"
                  type="password"
                  value={modifyPassword}
                  onChange={(event) => setModifyPassword(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-zinc-500">
                Role
                <select
                  className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-zinc-900"
                  value={modifyRole}
                  onChange={(event) => {
                    const nextRole = event.target.value;
                    setModifyRole(nextRole);
                    if (nextRole !== "BRAND_OWNER") {
                      setModifyStoreIds([]);
                      setIsModifyStorePickerOpen(false);
                    }
                  }}
                >
                  <option value="BRAND_OWNER">Brand owner</option>
                  <option value="UFULFILL">UFULFILL</option>
                  <option value="TANJAI_ADMIN">TanjAI admin</option>
                </select>
              </label>

              {modifyRole === "BRAND_OWNER" ? (
                <div className="relative grid gap-1 md:col-span-2">
                  <span className="text-xs font-medium text-zinc-500">
                    Associated stores
                  </span>
                  <button
                    aria-expanded={isModifyStorePickerOpen}
                    className="flex h-10 items-center justify-between rounded-md border border-zinc-300 bg-white px-3 text-left text-sm text-zinc-900 outline-none hover:bg-zinc-50 focus:border-zinc-900"
                    disabled={storeOptions.length === 0}
                    type="button"
                    onClick={() =>
                      setIsModifyStorePickerOpen((value) => !value)
                    }
                  >
                    <span className="truncate">
                      {modifyStoreIds.length === 0
                        ? storeOptions.length === 0
                          ? "No stores available"
                          : "Select one or more stores"
                        : modifyStoreIds.length === 1
                          ? (storeOptions.find(
                              (store) => store.id === modifyStoreIds[0],
                            )?.name ?? "1 store selected")
                          : `${modifyStoreIds.length} stores selected`}
                    </span>
                    <span aria-hidden="true" className="ml-3 text-zinc-500">
                      &#9662;
                    </span>
                  </button>

                  {isModifyStorePickerOpen ? (
                    <div className="absolute left-0 right-0 top-[4.25rem] z-20 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg">
                      <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
                        <span className="text-xs text-zinc-500">
                          {modifyStoreIds.length} selected
                        </span>
                        <div className="flex gap-3">
                          <button
                            className="text-xs font-medium text-zinc-600 hover:text-zinc-950"
                            type="button"
                            onClick={() =>
                              setModifyStoreIds(
                                storeOptions.map((store) => store.id),
                              )
                            }
                          >
                            Select all
                          </button>
                          <button
                            className="text-xs font-medium text-zinc-600 hover:text-zinc-950"
                            type="button"
                            onClick={() => setModifyStoreIds([])}
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <div className="max-h-52 overflow-y-auto p-1">
                        {storeOptions.map((store) => (
                          <label
                            className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm hover:bg-zinc-50"
                            key={store.id}
                          >
                            <input
                              checked={modifyStoreIds.includes(store.id)}
                              className="h-4 w-4 accent-zinc-950"
                              type="checkbox"
                              onChange={(event) =>
                                setModifyStoreIds((current) =>
                                  event.target.checked
                                    ? [...current, store.id]
                                    : current.filter((id) => id !== store.id),
                                )
                              }
                            />
                            <span className="truncate">{store.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            {actionError ? (
              <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {actionError}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="h-10 rounded-md border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50"
                disabled={isUpdatingUser}
                type="button"
                onClick={() => {
                  setModifyUser(null);
                  setIsModifyStorePickerOpen(false);
                }}
              >
                Cancel
              </button>
              <button
                className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-medium text-white disabled:bg-zinc-400"
                disabled={
                  isUpdatingUser ||
                  (modifyRole === "BRAND_OWNER" &&
                    modifyStoreIds.length === 0)
                }
                type="submit"
              >
                {isUpdatingUser ? "Saving..." : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {deleteUser ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-lg font-semibold">Remove user?</h2>
            <p className="mt-2 text-sm text-zinc-600">
              This permanently removes <strong>{deleteUser.email}</strong> and
              prevents them from signing in.
            </p>
            {actionError ? (
              <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {actionError}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="h-10 rounded-md border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50"
                disabled={isUpdatingUser}
                type="button"
                onClick={() => setDeleteUser(null)}
              >
                Cancel
              </button>
              <button
                className="h-10 rounded-md bg-red-700 px-4 text-sm font-medium text-white hover:bg-red-800 disabled:bg-red-300"
                disabled={isUpdatingUser}
                type="button"
                onClick={() => void confirmDeleteUser()}
              >
                {isUpdatingUser ? "Removing..." : "Remove user"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type PaymentFilterKey = "store" | "paymentType" | "dateFrom" | "dateTo";

const paymentFilterDefinitions: Array<{
  key: PaymentFilterKey;
  label: string;
}> = [
  { key: "paymentType", label: "Type" },
  { key: "store", label: "Store spending" },
  { key: "dateFrom", label: "Date from" },
  { key: "dateTo", label: "Date to" },
];

function uniquePaymentFilterKeys(keys: PaymentFilterKey[]) {
  return keys.filter((key, index) => keys.indexOf(key) === index);
}

function renderPaymentFilterControl(
  key: PaymentFilterKey,
  filters: Filters,
  stores: string[],
  onChange: (filters: Filters) => void,
) {
  if (key === "paymentType") {
    return (
      <FilterSelect
        label=""
        placeholder="All types"
        options={["Deposit", "Spent"]}
        value={filters.paymentType}
        onChange={(value) =>
          onChange({
            ...filters,
            paymentType: value as Filters["paymentType"],
          })
        }
      />
    );
  }

  if (key === "store") {
    return (
      <FilterSelect
        label=""
        placeholder="All stores"
        options={stores}
        value={filters.store}
        onChange={(value) => onChange({ ...filters, store: value })}
      />
    );
  }

  return (
    <FilterInput
      label=""
      type="date"
      value={filters[key]}
      onChange={(value) =>
        onChange({
          ...filters,
          [key]: value,
          ...(key === "dateFrom" &&
          value &&
          (!filters.dateTo || filters.dateTo < value)
            ? { dateTo: value }
            : {}),
        })
      }
    />
  );
}

function isProductRow(value: unknown): value is ProductRow {
  return (
    value !== null &&
    typeof value === "object" &&
    "name" in value &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

function PaymentsSection({
  currentUser,
  data,
  filters,
  isLoading,
  limitedToSpending,
  stores,
  onChange,
  onPaymentsChanged,
}: {
  currentUser: AuthenticatedUser;
  data: SectionData | null;
  filters: Filters;
  isLoading: boolean;
  limitedToSpending: boolean;
  stores: string[];
  onChange: (filters: Filters) => void;
  onPaymentsChanged: () => Promise<void>;
}) {
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false);
  const [selectedFilterKeys, setSelectedFilterKeys] = useState<
    PaymentFilterKey[]
  >(() =>
    paymentFilterDefinitions
      .filter((definition) => filters[definition.key].trim())
      .map((definition) => definition.key),
  );
  const [depositRequests, setDepositRequests] = useState<DepositRequestRow[]>([]);
  const [depositRequestRefreshKey, setDepositRequestRefreshKey] = useState(0);
  const [depositRequestError, setDepositRequestError] = useState("");
  const [depositRequestMessage, setDepositRequestMessage] = useState("");
  const [isLoadingDepositRequests, setIsLoadingDepositRequests] = useState(false);
  const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);
  const [isMyDepositRequestsModalOpen, setIsMyDepositRequestsModalOpen] =
    useState(false);
  const [isAdminDepositRequestsModalOpen, setIsAdminDepositRequestsModalOpen] =
    useState(false);
  const [depositDate, setDepositDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [depositAmount, setDepositAmount] = useState("");
  const [depositProof, setDepositProof] = useState<File | null>(null);
  const [isSubmittingDeposit, setIsSubmittingDeposit] = useState(false);
  const [reviewRequest, setReviewRequest] = useState<DepositRequestRow | null>(
    null,
  );
  const [reviewDecision, setReviewDecision] = useState<
    "APPROVED" | "REJECTED"
  >("APPROVED");
  const [reviewReason, setReviewReason] = useState("");
  const [isReviewingDeposit, setIsReviewingDeposit] = useState(false);
  const allowedFilterDefinitions = useMemo(
    () =>
      limitedToSpending
        ? paymentFilterDefinitions.filter(
            (definition) => definition.key !== "paymentType",
          )
        : paymentFilterDefinitions,
    [limitedToSpending],
  );
  const rows = data?.rows ?? [];
  const meta = data?.meta ?? {};
  const activeFilterKeys = selectedFilterKeys.filter((key) =>
    allowedFilterDefinitions.some((definition) => definition.key === key),
  );
  const availableFilters = allowedFilterDefinitions.filter(
    (definition) => !activeFilterKeys.includes(definition.key),
  );
  const appliedCount = allowedFilterDefinitions.filter((definition) =>
    filters[definition.key].trim(),
  ).length;

  useEffect(() => {
    if (!['TANJAI_ADMIN', 'BRAND_OWNER'].includes(currentUser.role)) return;
    let isMounted = true;

    async function loadDepositRequests() {
      setIsLoadingDepositRequests(true);
      setDepositRequestError("");
      const response = await apiFetch(`${apiBaseUrl}/deposit-requests`);
      if (!response.ok) {
        if (isMounted) {
          setDepositRequestError(
            await responseErrorMessage(
              response,
              "Unable to load deposit requests.",
            ),
          );
        }
      } else {
        const requests = (await response.json()) as DepositRequestRow[];
        if (isMounted) setDepositRequests(requests);
      }
      if (isMounted) setIsLoadingDepositRequests(false);
    }

    void loadDepositRequests();
    return () => {
      isMounted = false;
    };
  }, [currentUser.role, depositRequestRefreshKey]);

  async function submitDepositRequest() {
    if (!depositProof) {
      setDepositRequestError("Select a deposit proof file.");
      return;
    }
    if (depositProof.size > 5 * 1024 * 1024) {
      setDepositRequestError("The deposit proof must be no larger than 5 MB.");
      return;
    }
    setIsSubmittingDeposit(true);
    setDepositRequestError("");
    setDepositRequestMessage("");
    try {
      const response = await apiFetch(`${apiBaseUrl}/deposit-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: depositDate,
          amount: Number(depositAmount),
          proof: {
            fileName: depositProof.name,
            mimeType: depositProof.type,
            base64: await fileToBase64(depositProof),
          },
        }),
      });
      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, "Unable to submit deposit."),
        );
      }
      setIsDepositModalOpen(false);
      setDepositAmount("");
      setDepositProof(null);
      setDepositRequestMessage(
        "Deposit submitted. It will appear in Payments after admin approval.",
      );
      setDepositRequestRefreshKey((value) => value + 1);
    } catch (error) {
      setDepositRequestError(
        error instanceof Error ? error.message : "Unable to submit deposit.",
      );
    } finally {
      setIsSubmittingDeposit(false);
    }
  }

  async function reviewDeposit(decision: "APPROVED" | "REJECTED") {
    if (!reviewRequest) return;
    if (decision === "REJECTED" && !reviewReason.trim()) {
      setReviewDecision("REJECTED");
      setDepositRequestError("Enter a denial reason before denying the deposit.");
      return;
    }
    setIsReviewingDeposit(true);
    setDepositRequestError("");
    setDepositRequestMessage("");
    try {
      const response = await apiFetch(
        `${apiBaseUrl}/deposit-requests/${encodeURIComponent(reviewRequest.id)}/review`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            reason: reviewReason,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, "Unable to review deposit."),
        );
      }
      setReviewRequest(null);
      setReviewReason("");
      setDepositRequestMessage(
        decision === "APPROVED"
          ? "Deposit approved and added to Payments."
          : "Deposit request denied.",
      );
      setDepositRequestRefreshKey((value) => value + 1);
      await onPaymentsChanged();
    } catch (error) {
      setDepositRequestError(
        error instanceof Error ? error.message : "Unable to review deposit.",
      );
    } finally {
      setIsReviewingDeposit(false);
    }
  }

  async function openDepositProof(request: DepositRequestRow) {
    setDepositRequestError("");
    const response = await apiFetch(
      `${apiBaseUrl}/deposit-requests/${encodeURIComponent(request.id)}/proof`,
    );
    if (!response.ok) {
      setDepositRequestError(
        await responseErrorMessage(response, "Unable to open deposit proof."),
      );
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  useEffect(() => {
    const valuedKeys = allowedFilterDefinitions
      .filter((definition) => filters[definition.key].trim())
      .map((definition) => definition.key);
    if (valuedKeys.length === 0) return;
    setSelectedFilterKeys((current) =>
      uniquePaymentFilterKeys([...current, ...valuedKeys]),
    );
  }, [allowedFilterDefinitions, filters]);

  function addFilter(key: PaymentFilterKey) {
    setSelectedFilterKeys((current) =>
      uniquePaymentFilterKeys([...current, key]),
    );
    setIsFilterMenuOpen(false);
  }

  function removeFilter(key: PaymentFilterKey) {
    setSelectedFilterKeys((current) =>
      current.filter((filterKey) => filterKey !== key),
    );
    onChange({ ...filters, [key]: "" });
  }

  function clearPaymentFilters() {
    setSelectedFilterKeys([]);
    setIsFilterMenuOpen(false);
    onChange({
      ...filters,
      store: "",
      dateFrom: "",
      dateTo: "",
      paymentType: "",
    });
  }

  const paymentFilterAction = (
    <div className="relative">
      <button
        className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition ${
          appliedCount > 0
            ? "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700"
            : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
        }`}
        type="button"
        onClick={() => setIsFiltersOpen((value) => !value)}
      >
        <FilterIcon />
        Filter
        {appliedCount > 0 ? (
          <span className="grid h-4 min-w-4 place-items-center rounded-full bg-white px-1 text-[10px] text-zinc-900">
            {appliedCount}
          </span>
        ) : null}
      </button>

      {isFiltersOpen ? (
        <div className="absolute right-0 top-10 z-30 w-[min(90vw,44rem)] rounded-lg border border-zinc-200 bg-white p-4 text-left shadow-xl">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Filter payments</h3>
            <button
              aria-label="Close payment filters"
              className="grid h-7 w-7 place-items-center rounded-md border border-zinc-300 text-zinc-600 hover:bg-zinc-50"
              type="button"
              onClick={() => {
                setIsFiltersOpen(false);
                setIsFilterMenuOpen(false);
              }}
            >
              <CloseIcon />
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="relative">
              <button
                className="h-8 rounded-md border border-zinc-300 bg-white px-3 text-xs font-medium transition hover:bg-zinc-50"
                type="button"
                onClick={() => setIsFilterMenuOpen((value) => !value)}
              >
                + Add filter
              </button>
              {isFilterMenuOpen ? (
                <div className="absolute left-0 top-10 z-40 w-64 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg">
                  {availableFilters.length > 0 ? (
                    availableFilters.map((definition) => (
                      <button
                        className="block w-full px-3 py-2 text-left text-sm transition hover:bg-zinc-50"
                        key={definition.key}
                        type="button"
                        onClick={() => addFilter(definition.key)}
                      >
                        {definition.label}
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-2 text-sm text-zinc-500">
                      All filters selected
                    </div>
                  )}
                </div>
              ) : null}
            </div>
            <button
              className="h-8 rounded-md border border-zinc-300 px-3 text-xs font-medium transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={activeFilterKeys.length === 0 && appliedCount === 0}
              type="button"
              onClick={clearPaymentFilters}
            >
              Clear
            </button>
          </div>

          {activeFilterKeys.length > 0 ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {activeFilterKeys.map((key) => {
                const definition = paymentFilterDefinitions.find(
                  (item) => item.key === key,
                );
                if (!definition) return null;
                return (
                  <div className="grid gap-1" key={key}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-zinc-500">
                        {definition.label}
                      </span>
                      <button
                        className="text-xs font-medium text-zinc-500 transition hover:text-zinc-950"
                        type="button"
                        onClick={() => removeFilter(key)}
                      >
                        Remove
                      </button>
                    </div>
                    {renderPaymentFilterControl(key, filters, stores, onChange)}
                  </div>
                );
              })}
            </div>
          ) : null}

          {activeFilterKeys.includes("store") ? (
            <p className="mt-2 text-xs text-zinc-500">
              Store applies to spent transactions. Deposits remain visible
              unless Type is set to Spent.
            </p>
          ) : null}

          <div className="mt-4 flex justify-end">
            <button
              className="h-8 rounded-md bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-700"
              type="button"
              onClick={() => {
                setIsFiltersOpen(false);
                setIsFilterMenuOpen(false);
              }}
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          {depositRequestMessage ? (
            <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {depositRequestMessage}
            </p>
          ) : null}
          {depositRequestError ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {depositRequestError}
            </p>
          ) : null}
        </div>
        {currentUser.role === "BRAND_OWNER" ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              className="h-10 rounded-md border border-zinc-300 bg-white px-4 text-sm font-medium hover:bg-zinc-50"
              type="button"
              onClick={() => {
                setDepositRequestError("");
                setIsMyDepositRequestsModalOpen(true);
              }}
            >
              My deposit requests ({depositRequests.length})
            </button>
            <button
              className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800"
              type="button"
              onClick={() => {
                setDepositRequestError("");
                setDepositRequestMessage("");
                setIsDepositModalOpen(true);
              }}
            >
              + New deposit
            </button>
          </div>
        ) : currentUser.role === "TANJAI_ADMIN" ? (
          <button
            className="h-10 shrink-0 rounded-md border border-zinc-300 bg-white px-4 text-sm font-medium hover:bg-zinc-50"
            type="button"
            onClick={() => {
              setDepositRequestError("");
              setIsAdminDepositRequestsModalOpen(true);
            }}
          >
            Deposit requests (
            {
              depositRequests.filter(
                (request) => request.status === "PENDING",
              ).length
            }{" "}
            pending)
          </button>
        ) : null}
      </div>

      <div
        className={`grid gap-3 ${
          limitedToSpending ? "sm:grid-cols-1" : "sm:grid-cols-2 xl:grid-cols-4"
        }`}
      >
        {!limitedToSpending ? (
          <>
            <Metric
              label="Remaining balance"
              value={formatCurrency(Number(meta.remainingBalance ?? 0))}
            />
            <Metric
              label="Owner deposits"
              value={formatCurrency(Number(meta.deposits ?? 0))}
            />
          </>
        ) : null}
        <Metric
          label="Total spent"
          value={formatCurrency(Number(meta.storeInvoices ?? 0))}
        />
        {!limitedToSpending ? (
          <Metric
            label="Net movement"
            value={formatCurrency(Number(meta.netMovement ?? 0))}
          />
        ) : null}
      </div>

      {currentUser.role === "TANJAI_ADMIN" &&
      isAdminDepositRequestsModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4"
          role="presentation"
          onMouseDown={() => setIsAdminDepositRequestsModalOpen(false)}
        >
          <div
            aria-modal="true"
            className="flex max-h-[85vh] w-full max-w-6xl flex-col rounded-lg bg-white p-5 shadow-xl"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">
                  Deposit requests (
                  {
                    depositRequests.filter(
                      (request) => request.status === "PENDING",
                    ).length
                  }{" "}
                  pending)
                </h2>
                <p className="mt-1 text-sm text-zinc-500">
                  Review proofs and approve or reject Brand Owner deposits.
                </p>
              </div>
              <button
                className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-50"
                type="button"
                onClick={() => setIsAdminDepositRequestsModalOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="mt-5 min-h-0 overflow-auto rounded-md border border-zinc-200 p-4">
        {isLoadingDepositRequests ? (
          <p className="text-sm text-zinc-600">Loading deposit requests...</p>
        ) : depositRequests.length === 0 ? (
          <EmptyState
            label={
              currentUser.role === "TANJAI_ADMIN"
                ? "No deposit requests submitted yet."
                : "No deposit requests submitted yet."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-3 py-3 font-semibold">Date</th>
                  {currentUser.role === "TANJAI_ADMIN" ? (
                    <th className="px-3 py-3 font-semibold">Brand owner</th>
                  ) : null}
                  <th className="px-3 py-3 font-semibold">Amount</th>
                  <th className="px-3 py-3 font-semibold">Proof</th>
                  <th className="px-3 py-3 font-semibold">Status</th>
                  <th className="px-3 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {depositRequests.map((request) => (
                  <tr key={request.id}>
                    <td className="px-3 py-3">
                      {formatDate(request.transactionDate)}
                    </td>
                    {currentUser.role === "TANJAI_ADMIN" ? (
                      <td className="px-3 py-3">{request.requestedByEmail}</td>
                    ) : null}
                    <td className="px-3 py-3 font-medium">
                      {formatCurrency(request.amount)}
                    </td>
                    <td className="px-3 py-3">
                      <button
                        className="text-sm font-medium underline underline-offset-2"
                        type="button"
                        onClick={() => void openDepositProof(request)}
                      >
                        {request.proofFileName}
                      </button>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-medium ${
                          request.status === "APPROVED"
                            ? "bg-emerald-50 text-emerald-700"
                            : request.status === "REJECTED"
                              ? "bg-red-50 text-red-700"
                              : "bg-amber-50 text-amber-700"
                        }`}
                        title={request.rejectionReason ?? undefined}
                      >
                        {request.status}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right">
                      {currentUser.role === "TANJAI_ADMIN" &&
                      request.status === "PENDING" ? (
                        <button
                          className="h-8 rounded-md border border-zinc-300 px-3 text-xs font-medium hover:bg-zinc-50"
                          type="button"
                          onClick={() => {
                            setReviewDecision("APPROVED");
                            setReviewReason("");
                            setIsAdminDepositRequestsModalOpen(false);
                            setReviewRequest(request);
                          }}
                        >
                          Review
                        </button>
                      ) : request.rejectionReason ? (
                        <span
                          className="text-xs text-zinc-500"
                          title={request.rejectionReason}
                        >
                          View reason
                        </span>
                      ) : (
                        <span className="text-zinc-400">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
            </div>
          </div>
        </div>
      ) : null}

      {isLoading ? (
        <Panel action={paymentFilterAction} title="Deposits & Spending">
          <p className="text-sm text-zinc-600">Loading payments...</p>
        </Panel>
      ) : !data || rows.length === 0 ? (
        <Panel action={paymentFilterAction} title="Deposits & Spending">
          <EmptyState label="No deposits or spending found." />
        </Panel>
      ) : (
        <Panel
          action={paymentFilterAction}
          title={`${data.title} (${formatNumber(
            Number(data.totalRows ?? rows.length),
          )})`}
        >
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                  {data.columns.map((column) => (
                    <th
                      className="whitespace-nowrap px-3 py-3 font-semibold"
                      key={column.key}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {rows.map((row) => (
                  <tr className="hover:bg-zinc-50" key={recordRowKey(row) as string}>
                    {data.columns.map((column) => (
                      <td
                        className="max-w-xs whitespace-nowrap px-3 py-3 text-zinc-700"
                        key={column.key}
                        title={String(row[column.key] ?? "")}
                      >
                        {column.key === "amount" ||
                        column.key === "balance"
                          ? formatPaymentCurrencyCell(row[column.key])
                          : formatCellValue(row[column.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {isMyDepositRequestsModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4"
          role="presentation"
          onMouseDown={() => setIsMyDepositRequestsModalOpen(false)}
        >
          <div
            aria-modal="true"
            className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-lg bg-white p-5 shadow-xl"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">
                  My deposit requests ({depositRequests.length})
                </h2>
                <p className="mt-1 text-sm text-zinc-500">
                  Track submitted deposits and their approval status.
                </p>
              </div>
              <button
                className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-50"
                type="button"
                onClick={() => setIsMyDepositRequestsModalOpen(false)}
              >
                Close
              </button>
            </div>

            {depositRequestError ? (
              <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {depositRequestError}
              </p>
            ) : null}

            <div className="mt-5 min-h-0 overflow-auto rounded-md border border-zinc-200">
              {isLoadingDepositRequests ? (
                <p className="p-6 text-sm text-zinc-600">
                  Loading deposit requests...
                </p>
              ) : depositRequests.length === 0 ? (
                <div className="p-6">
                  <EmptyState label="No deposit requests submitted yet." />
                </div>
              ) : (
                <table className="min-w-full text-left text-sm">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                      <th className="px-3 py-3 font-semibold">Date</th>
                      <th className="px-3 py-3 font-semibold">Amount</th>
                      <th className="px-3 py-3 font-semibold">Proof</th>
                      <th className="px-3 py-3 font-semibold">Status</th>
                      <th className="px-3 py-3 font-semibold">Admin note</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {depositRequests.map((request) => (
                      <tr key={request.id}>
                        <td className="whitespace-nowrap px-3 py-3">
                          {formatDate(request.transactionDate)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 font-medium">
                          {formatCurrency(request.amount)}
                        </td>
                        <td className="px-3 py-3">
                          <button
                            className="max-w-48 truncate font-medium underline underline-offset-2"
                            title={request.proofFileName}
                            type="button"
                            onClick={() => void openDepositProof(request)}
                          >
                            {request.proofFileName}
                          </button>
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={`rounded-full px-2 py-1 text-xs font-medium ${
                              request.status === "APPROVED"
                                ? "bg-emerald-50 text-emerald-700"
                                : request.status === "REJECTED"
                                  ? "bg-red-50 text-red-700"
                                  : "bg-amber-50 text-amber-700"
                            }`}
                          >
                            {request.status}
                          </span>
                        </td>
                        <td className="max-w-xs px-3 py-3 text-zinc-600">
                          {request.rejectionReason ?? "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {isDepositModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4">
          <form
            className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl"
            onSubmit={(event) => {
              event.preventDefault();
              void submitDepositRequest();
            }}
          >
            <h2 className="text-lg font-semibold">New deposit</h2>
            <p className="mt-1 text-sm text-zinc-500">
              The deposit will remain pending until a TanjAI admin validates it.
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1 text-xs font-medium text-zinc-500">
                Deposit date
                <input
                  required
                  className="h-10 rounded-md border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-900"
                  type="date"
                  value={depositDate}
                  onChange={(event) => setDepositDate(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-zinc-500">
                Amount
                <input
                  required
                  className="h-10 rounded-md border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-900"
                  min="0.01"
                  step="0.01"
                  type="number"
                  value={depositAmount}
                  onChange={(event) => setDepositAmount(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-zinc-500 sm:col-span-2">
                Proof
                <input
                  required
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
                  type="file"
                  onChange={(event) =>
                    setDepositProof(event.target.files?.[0] ?? null)
                  }
                />
                <span className="font-normal">PDF, JPG, PNG, or WEBP; maximum 5 MB.</span>
              </label>
            </div>
            {depositRequestError ? (
              <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {depositRequestError}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="h-10 rounded-md border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50"
                disabled={isSubmittingDeposit}
                type="button"
                onClick={() => setIsDepositModalOpen(false)}
              >
                Cancel
              </button>
              <button
                className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-medium text-white disabled:bg-zinc-400"
                disabled={isSubmittingDeposit}
                type="submit"
              >
                {isSubmittingDeposit ? "Submitting..." : "Submit deposit"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {reviewRequest ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4">
          <div
            className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl"
          >
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-lg font-semibold">Review deposit</h2>
              <button
                aria-label="Close review"
                className="flex h-9 w-9 items-center justify-center rounded-md border border-zinc-300 text-xl leading-none hover:bg-zinc-50"
                disabled={isReviewingDeposit}
                type="button"
                onClick={() => {
                  setReviewRequest(null);
                  setReviewDecision("APPROVED");
                  setReviewReason("");
                  setDepositRequestError("");
                }}
              >
                ×
              </button>
            </div>
            <div className="mt-4 rounded-md border border-zinc-200 p-4 text-sm">
              <p><strong>Brand owner:</strong> {reviewRequest.requestedByEmail}</p>
              <p className="mt-1"><strong>Date:</strong> {formatDate(reviewRequest.transactionDate)}</p>
              <p className="mt-1"><strong>Amount:</strong> {formatCurrency(reviewRequest.amount)}</p>
              <button
                className="mt-3 font-medium underline underline-offset-2"
                type="button"
                onClick={() => void openDepositProof(reviewRequest)}
              >
                Open proof: {reviewRequest.proofFileName}
              </button>
            </div>
            {reviewDecision === "REJECTED" ? (
              <label className="mt-4 grid gap-1 text-xs font-medium text-zinc-500">
                Denial reason
                <textarea
                  required
                  className="min-h-24 rounded-md border border-zinc-300 p-3 text-sm text-zinc-900"
                  value={reviewReason}
                  onChange={(event) => setReviewReason(event.target.value)}
                />
              </label>
            ) : null}
            {depositRequestError ? (
              <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {depositRequestError}
              </p>
            ) : null}
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:bg-zinc-400"
                disabled={isReviewingDeposit}
                type="button"
                onClick={() => void reviewDeposit("APPROVED")}
              >
                {isReviewingDeposit ? "Saving..." : "Accept"}
              </button>
              <button
                className="h-10 rounded-md border border-red-700 px-4 text-sm font-medium text-red-700 hover:bg-red-50 disabled:border-zinc-300 disabled:text-zinc-400"
                disabled={isReviewingDeposit}
                type="button"
                onClick={() => {
                  if (reviewDecision !== "REJECTED") {
                    setReviewDecision("REJECTED");
                    setDepositRequestError("");
                    return;
                  }
                  void reviewDeposit("REJECTED");
                }}
              >
                {isReviewingDeposit ? "Saving..." : "Deny"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.includes(",") ? result.slice(result.indexOf(",") + 1) : result;
      if (!base64) {
        reject(new Error("Unable to read the selected proof file."));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Unable to read the selected proof file."));
    reader.readAsDataURL(file);
  });
}

function formatPaymentCurrencyCell(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? formatCurrency(amount) : formatCellValue(value);
}

function SectionTable({
  action,
  data,
  isLoading,
  onSelectProduct,
  title,
}: {
  action?: ReactNode;
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
      <Panel action={action} title={title}>
        <EmptyState label={`No ${title.toLowerCase()} found.`} />
      </Panel>
    );
  }

  const visibleRows = uniqueByKey(data.rows, recordRowKey);

  return (
    <Panel
      action={action}
      title={`${data.title} (${formatNumber(visibleRows.length)})`}
    >
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
