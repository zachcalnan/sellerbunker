/**
 * Single source of truth for “sales in period” — same rules as the Orders page
 * (rolling N×24h from now, UTC “today”, etc.).
 */

export type OrderRowLike = {
  orderDate: string;
  quantity: number;
  salePrice: number;
  profit: number | null;
  /** When true, line is shown but excluded from sales / units / profit totals (cancelled/returned). */
  excludedFromSales?: boolean;
};

export type DashboardRangePreset =
  | "today"
  | "yesterday"
  | "7d"
  | "14d"
  | "30d"
  | "all"
  | "custom";

/** Orders tab period keys (rolling days except today). */
export type OrdersTabPeriod = "today" | "7" | "14" | "30";

const oneDayMs = 24 * 60 * 60 * 1000;

export function filterOrderRowsForDashboardPreset(
  rows: OrderRowLike[],
  preset: DashboardRangePreset,
  custom?: { start: string; end: string },
): OrderRowLike[] {
  const now = Date.now();

  if (preset === "all") return rows;

  if (preset === "today") {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    const startMs = d.getTime();
    return rows.filter((r) => {
      const t = new Date(r.orderDate).getTime();
      return t >= startMs && t < startMs + oneDayMs;
    });
  }

  if (preset === "yesterday") {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    const todayStart = d.getTime();
    const yesterdayStart = todayStart - oneDayMs;
    return rows.filter((r) => {
      const t = new Date(r.orderDate).getTime();
      return t >= yesterdayStart && t < todayStart;
    });
  }

  if (preset === "7d" || preset === "14d" || preset === "30d") {
    const days = preset === "7d" ? 7 : preset === "14d" ? 14 : 30;
    const startMs = now - days * oneDayMs;
    return rows.filter((r) => {
      const t = new Date(r.orderDate).getTime();
      return t >= startMs && t <= now;
    });
  }

  // custom: date-only YYYY-MM-DD (same as dashboard URL / summary)
  const cs = custom?.start;
  const ce = custom?.end;
  if (!cs || !ce) return rows;
  const startBoundary = new Date(`${cs}T00:00:00.000Z`).getTime();
  const endBoundary = new Date(`${ce}T23:59:59.999Z`).getTime();
  return rows.filter((r) => {
    const t = new Date(r.orderDate).getTime();
    return t >= startBoundary && t <= endBoundary;
  });
}

/** Used by the Orders page period dropdown (rolling day counts). */
export function filterOrderRowsForOrdersTabPeriod(
  rows: OrderRowLike[],
  period: OrdersTabPeriod,
): OrderRowLike[] {
  const now = Date.now();

  if (period === "today") {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    const startMs = d.getTime();
    return rows.filter((r) => {
      const t = new Date(r.orderDate).getTime();
      return t >= startMs && t < startMs + oneDayMs;
    });
  }

  const days = Number(period) || 30;
  const startMs = now - days * oneDayMs;
  return rows.filter((r) => {
    const t = new Date(r.orderDate).getTime();
    return t >= startMs && t <= now;
  });
}

export function aggregateOrderRows(rows: OrderRowLike[]) {
  const counting = rows.filter((r) => !r.excludedFromSales);
  const orderCount = counting.length;
  const totalSales = counting.reduce(
    (sum, r) => sum + r.salePrice * r.quantity,
    0,
  );
  const totalUnits = counting.reduce(
    (sum, r) => sum + (Number.isFinite(r.quantity) ? r.quantity : 0),
    0,
  );
  const totalProfit = counting.reduce((sum, r) => sum + (r.profit ?? 0), 0);
  return { orderCount, totalSales, totalUnits, totalProfit };
}
