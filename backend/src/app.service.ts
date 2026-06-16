import { Injectable } from '@nestjs/common';

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

type DatabaseRow = {
  id?: string | number;
  status?: string | null;
  severity?: string | null;
  created_at?: string | null;
};

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  async getDashboardSummary(): Promise<DashboardSummary> {
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
      totalRequests: requests.length,
      anomaliesDetected: anomalies.length,
      pendingOrders,
      ordersOverTime: this.groupByDate(orders),
      ordersByStatus: this.groupByField(orders, 'status'),
      requestsOverview: this.groupByField(requests, 'status'),
      anomaliesBySeverity: this.groupByField(anomalies, 'severity'),
      recentActivity: this.getRecentActivity(orders, requests, anomalies),
      attentionRequired: this.getAttentionItems(
        pendingOrders,
        openRequests,
        unresolvedAnomalies,
      ),
    };
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
}
