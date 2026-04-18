/**
 * Single source of truth for “sales in period” in a dashboard range preset
 * (marketplace-local “today”, calendar N-day windows to match Seller Central, etc.).
 * The Orders page and dashboard widgets use `filterOrderRowsForDashboardPreset` with these presets.
 */

import {
  endOfLocalDayInclusiveUtcMs,
  getLocalYmdFromUtcMs,
  parseYmdParts,
  startOfLocalDayUtcMs,
  subtractCivilDays,
} from "./marketplace-timezone";

export type OrderRowLike = {
  orderDate: string;
  quantity: number;
  salePrice: number;
  profit: number | null;
  /** Amazon order id — used for distinct order counts (SC-style). */
  orderId?: string;
  /** When true, line is excluded from revenue / units (cancelled, returned, refunds, etc.). */
  excludedFromSales?: boolean;
  /**
   * When true, line is excluded from profit rollup. Refund lines set `excludedFromSales` but keep this false
   * so clawback profit still counts toward period profit.
   */
  excludedFromProfitMetrics?: boolean;
  /**
   * When true, line does not count toward “orders” (Seller Central headline). Only cancelled parents
   * set this; Pending, Shipped, PendingReturn, returns, etc. still count as an order.
   */
  excludedFromOrderCount?: boolean;
};

export type DashboardRangePreset =
  | "today"
  | "yesterday"
  | "7d"
  | "14d"
  | "30d"
  | "6m"
  | "12m"
  | "all"
  | "custom";

/** Same presets/labels as the dashboard Performance Snapshot — use for any matching period dropdown. */
export const DASHBOARD_RANGE_PERIOD_SELECT_OPTIONS: {
  value: DashboardRangePreset;
  label: string;
}[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "7 days" },
  { value: "14d", label: "Two weeks" },
  { value: "30d", label: "30 days" },
  { value: "6m", label: "Last 6 months" },
  { value: "12m", label: "Last 12 months" },
  { value: "all", label: "Lifetime (all time)" },
  { value: "custom", label: "Custom" },
];

/** Orders tab period keys (rolling days except today). */
export type OrdersTabPeriod = "today" | "7" | "14" | "30";

export type PeriodFilterOptions = {
  /** IANA zone for marketplace-local calendar (Seller Central parity). Default UTC. */
  timeZone?: string;
};

export function filterOrderRowsForDashboardPreset(
  rows: OrderRowLike[],
  preset: DashboardRangePreset,
  custom?: { start: string; end: string },
  options?: PeriodFilterOptions,
): OrderRowLike[] {
  const tz = options?.timeZone ?? "UTC";
  const now = Date.now();

  if (preset === "all") return rows;

  if (preset === "today") {
    const ymd = getLocalYmdFromUtcMs(now, tz);
    const startMs = startOfLocalDayUtcMs(ymd, tz);
    const endMs = Math.min(now, endOfLocalDayInclusiveUtcMs(ymd, tz));
    return rows.filter((r) => {
      const t = new Date(r.orderDate).getTime();
      return t >= startMs && t <= endMs;
    });
  }

  if (preset === "yesterday") {
    const todayYmd = getLocalYmdFromUtcMs(now, tz);
    const yest = subtractCivilDays(todayYmd.y, todayYmd.m, todayYmd.d, 1);
    const startMs = startOfLocalDayUtcMs(yest, tz);
    const endMs = endOfLocalDayInclusiveUtcMs(yest, tz);
    return rows.filter((r) => {
      const t = new Date(r.orderDate).getTime();
      return t >= startMs && t <= endMs;
    });
  }

  if (preset === "7d" || preset === "14d" || preset === "30d" || preset === "6m" || preset === "12m") {
    const days =
      preset === "7d"
        ? 7
        : preset === "14d"
          ? 14
          : preset === "30d"
            ? 30
            : preset === "6m"
              ? 183
              : 365;
    const todayYmd = getLocalYmdFromUtcMs(now, tz);
    const startYmd = subtractCivilDays(todayYmd.y, todayYmd.m, todayYmd.d, days - 1);
    const startMs = startOfLocalDayUtcMs(startYmd, tz);
    const endMs = Math.min(now, endOfLocalDayInclusiveUtcMs(todayYmd, tz));
    return rows.filter((r) => {
      const t = new Date(r.orderDate).getTime();
      return t >= startMs && t <= endMs;
    });
  }

  const cs = custom?.start;
  const ce = custom?.end;
  if (!cs || !ce) return rows;
  const startYmd = parseYmdParts(cs);
  const endYmd = parseYmdParts(ce);
  const startBoundary = startOfLocalDayUtcMs(startYmd, tz);
  const todayYmd = getLocalYmdFromUtcMs(now, tz);
  const endIsToday =
    endYmd.y === todayYmd.y &&
    endYmd.m === todayYmd.m &&
    endYmd.d === todayYmd.d;
  const endBoundary = endIsToday
    ? Math.min(now, endOfLocalDayInclusiveUtcMs(endYmd, tz))
    : endOfLocalDayInclusiveUtcMs(endYmd, tz);
  return rows.filter((r) => {
    const t = new Date(r.orderDate).getTime();
    return t >= startBoundary && t <= endBoundary;
  });
}

/** Legacy helper for older “N-day” keys; prefer `filterOrderRowsForDashboardPreset` + `DashboardRangePreset`. */
export function filterOrderRowsForOrdersTabPeriod(
  rows: OrderRowLike[],
  period: OrdersTabPeriod,
  options?: PeriodFilterOptions,
): OrderRowLike[] {
  const tz = options?.timeZone ?? "UTC";
  const now = Date.now();

  if (period === "today") {
    const ymd = getLocalYmdFromUtcMs(now, tz);
    const startMs = startOfLocalDayUtcMs(ymd, tz);
    const endMs = Math.min(now, endOfLocalDayInclusiveUtcMs(ymd, tz));
    return rows.filter((r) => {
      const t = new Date(r.orderDate).getTime();
      return t >= startMs && t <= endMs;
    });
  }

  const days = Number(period) || 30;
  const todayYmd = getLocalYmdFromUtcMs(now, tz);
  const startYmd = subtractCivilDays(todayYmd.y, todayYmd.m, todayYmd.d, days - 1);
  const startMs = startOfLocalDayUtcMs(startYmd, tz);
  const endMs = Math.min(now, endOfLocalDayInclusiveUtcMs(todayYmd, tz));
  return rows.filter((r) => {
    const t = new Date(r.orderDate).getTime();
    return t >= startMs && t <= endMs;
  });
}

function isProfitExcluded(r: OrderRowLike): boolean {
  if (r.excludedFromProfitMetrics === true) return true;
  if (r.excludedFromProfitMetrics === false) return false;
  return Boolean(r.excludedFromSales);
}

export function aggregateOrderRows(rows: OrderRowLike[]) {
  const forRevenue = rows.filter(
    (r) =>
      !r.excludedFromSales &&
      Number.isFinite(r.salePrice) &&
      r.salePrice > 0,
  );
  const forProfit = rows.filter((r) => !isProfitExcluded(r));
  const forOrderCount = rows.filter((r) => {
    if (r.excludedFromOrderCount === true) return false;
    if (r.excludedFromOrderCount === false) return true;
    return !r.excludedFromSales;
  });
  const orderIds = new Set<string>();
  let linesWithoutOrderId = 0;
  for (const r of forOrderCount) {
    const oid = r.orderId?.trim();
    if (oid) orderIds.add(oid);
    else linesWithoutOrderId += 1;
  }
  const orderCount =
    orderIds.size > 0 || linesWithoutOrderId > 0
      ? orderIds.size + linesWithoutOrderId
      : forOrderCount.length;
  const totalSales = forRevenue.reduce(
    (sum, r) => sum + r.salePrice * r.quantity,
    0,
  );
  const totalUnits = forRevenue.reduce(
    (sum, r) => sum + (Number.isFinite(r.quantity) ? r.quantity : 0),
    0,
  );
  const totalProfit = forProfit.reduce((sum, r) => sum + (r.profit ?? 0), 0);
  return { orderCount, totalSales, totalUnits, totalProfit };
}
