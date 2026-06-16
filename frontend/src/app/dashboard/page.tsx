"use client";

import { useEffect, useState } from "react";
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

type DashboardSummary = {
  totalOrders: number;
  totalRequests: number;
  anomaliesDetected: number;
  pendingOrders: number;
  ordersOverTime: ChartPoint[];
  ordersByStatus: ChartPoint[];
  requestsOverview: ChartPoint[];
  anomaliesBySeverity: ChartPoint[];
  recentActivity: ActivityItem[];
  attentionRequired: AttentionItem[];
};

type SummaryCard = {
  title: string;
  value: number;
  icon: "orders" | "requests" | "anomalies" | "pending";
};

const emptySummary: DashboardSummary = {
  totalOrders: 0,
  totalRequests: 0,
  anomaliesDetected: 0,
  pendingOrders: 0,
  ordersOverTime: [],
  ordersByStatus: [],
  requestsOverview: [],
  anomaliesBySeverity: [],
  recentActivity: [],
  attentionRequired: [],
};

const chartColors = ["#18181b", "#3f3f46", "#71717a", "#a1a1aa"];

const apiBaseUrl = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3005"
).replace(/\/$/, "");

function getUserDisplayName(user: User | null) {
  const firstName = user?.user_metadata?.first_name;
  const lastName = user?.user_metadata?.last_name;
  const fullName = [firstName, lastName].filter(Boolean).join(" ");

  return fullName || user?.email || "User";
}

function formatDate(value: string | null) {
  if (!value) {
    return "No date";
  }

  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function normalizeSummary(summary: Partial<DashboardSummary>): DashboardSummary {
  return {
    totalOrders: summary.totalOrders ?? 0,
    totalRequests: summary.totalRequests ?? 0,
    anomaliesDetected: summary.anomaliesDetected ?? 0,
    pendingOrders: summary.pendingOrders ?? 0,
    ordersOverTime: summary.ordersOverTime ?? [],
    ordersByStatus: summary.ordersByStatus ?? [],
    requestsOverview: summary.requestsOverview ?? [],
    anomaliesBySeverity: summary.anomaliesBySeverity ?? [],
    recentActivity: summary.recentActivity ?? [],
    attentionRequired: summary.attentionRequired ?? [],
  };
}

function SummaryIcon({ icon }: { icon: SummaryCard["icon"] }) {
  const commonClass = "h-5 w-5";

  if (icon === "orders") {
    return (
      <svg className={commonClass} viewBox="0 0 24 24" fill="none">
        <path
          d="M7 7h10v12H7V7Z"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path
          d="M9 7a3 3 0 0 1 6 0"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (icon === "requests") {
    return (
      <svg className={commonClass} viewBox="0 0 24 24" fill="none">
        <path
          d="M5 6h14v9H8l-3 3V6Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (icon === "anomalies") {
    return (
      <svg className={commonClass} viewBox="0 0 24 24" fill="none">
        <path
          d="M12 4 21 20H3L12 4Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="M12 9v5m0 3h.01"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg className={commonClass} viewBox="0 0 24 24" fill="none">
      <path
        d="M7 4h10v16H7V4Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M9.5 9H15m-5.5 4H14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Panel({
  title,
  children,
}: Readonly<{
  title: string;
  children: React.ReactNode;
}>) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-48 items-center justify-center rounded-md border border-dashed border-zinc-200 text-sm text-zinc-500">
      {label}
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [summary, setSummary] = useState<DashboardSummary>(emptySummary);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

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

        if (isMounted) {
          setUser(data.user);
        }

        const session = await supabase.auth.getSession();
        const response = await fetch(`${apiBaseUrl}/dashboard/summary`, {
          headers: session.data.session?.access_token
            ? { Authorization: `Bearer ${session.data.session.access_token}` }
            : undefined,
        });

        if (!response.ok) {
          throw new Error("Unable to load dashboard summary.");
        }

        const dashboardSummary = (await response.json()) as Partial<DashboardSummary>;

        if (isMounted) {
          setSummary(normalizeSummary(dashboardSummary));
        }
      } catch (error) {
        if (isMounted) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Unable to load dashboard."
          );
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadDashboard();

    return () => {
      isMounted = false;
    };
  }, [router]);

  async function handleLogout() {
    setErrorMessage("");

    try {
      const supabase = getSupabaseBrowserClient();
      await supabase.auth.signOut();
      router.replace("/login");
      router.refresh();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to sign out right now."
      );
    }
  }

  const cards: SummaryCard[] = [
    {
      title: "Total orders",
      value: summary.totalOrders,
      icon: "orders",
    },
    {
      title: "Total requests",
      value: summary.totalRequests,
      icon: "requests",
    },
    {
      title: "Anomalies detected",
      value: summary.anomaliesDetected,
      icon: "anomalies",
    },
    {
      title: "Pending orders",
      value: summary.pendingOrders,
      icon: "pending",
    },
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
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 md:hidden">
                TanjAI Stock
              </p>
              <h1 className="text-2xl font-semibold">Dashboard</h1>
            </div>
            <div className="flex items-center justify-between gap-4">
              <p className="truncate text-sm text-zinc-600">
                {getUserDisplayName(user)}
              </p>
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
          {isLoading ? (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-600">
              Loading dashboard...
            </div>
          ) : errorMessage ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-700">
              {errorMessage}
            </div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {cards.map((card) => (
                  <article
                    className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm"
                    key={card.title}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm font-medium text-zinc-500">
                        {card.title}
                      </p>
                      <div className="flex h-10 w-10 items-center justify-center rounded-md bg-zinc-100 text-zinc-700">
                        <SummaryIcon icon={card.icon} />
                      </div>
                    </div>
                    <p className="mt-5 text-3xl font-semibold">{card.value}</p>
                  </article>
                ))}
              </div>

              <div className="grid gap-5 xl:grid-cols-2">
                <Panel title="Orders over time">
                  {summary.ordersOverTime.length > 0 ? (
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={summary.ordersOverTime}>
                          <XAxis dataKey="label" tickLine={false} />
                          <YAxis allowDecimals={false} tickLine={false} />
                          <Tooltip />
                          <Line
                            dataKey="total"
                            stroke="#18181b"
                            strokeWidth={2}
                            type="monotone"
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <EmptyState label="No order history yet." />
                  )}
                </Panel>

                <Panel title="Orders by status">
                  {summary.ordersByStatus.length > 0 ? (
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={summary.ordersByStatus}
                            dataKey="total"
                            innerRadius={55}
                            nameKey="label"
                            outerRadius={85}
                          >
                            {summary.ordersByStatus.map((entry, index) => (
                              <Cell
                                fill={chartColors[index % chartColors.length]}
                                key={entry.label}
                              />
                            ))}
                          </Pie>
                          <Tooltip />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <EmptyState label="No order statuses yet." />
                  )}
                </Panel>

                <Panel title="Requests overview">
                  {summary.requestsOverview.length > 0 ? (
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={summary.requestsOverview}>
                          <XAxis dataKey="label" tickLine={false} />
                          <YAxis allowDecimals={false} tickLine={false} />
                          <Tooltip />
                          <Bar dataKey="total" fill="#18181b" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <EmptyState label="No requests yet." />
                  )}
                </Panel>

                <Panel title="Anomalies by severity">
                  {summary.anomaliesBySeverity.length > 0 ? (
                    <div className="space-y-4">
                      {summary.anomaliesBySeverity.map((item) => {
                        const maxTotal = Math.max(
                          ...summary.anomaliesBySeverity.map(
                            (severity) => severity.total
                          )
                        );
                        const width = maxTotal
                          ? `${Math.round((item.total / maxTotal) * 100)}%`
                          : "0%";

                        return (
                          <div key={item.label}>
                            <div className="flex items-center justify-between text-sm">
                              <span className="font-medium">{item.label}</span>
                              <span className="text-zinc-500">{item.total}</span>
                            </div>
                            <div className="mt-2 h-2 rounded-full bg-zinc-100">
                              <div
                                className="h-2 rounded-full bg-zinc-900"
                                style={{ width }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <EmptyState label="No anomalies yet." />
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
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
