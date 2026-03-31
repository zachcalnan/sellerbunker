/**
 * Single source of truth for “sales in period” — same rules as the Orders page
 * (marketplace-local “today”, calendar N-day windows to match Seller Central, etc.).
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
  /** When true, line is excluded from revenue / units / profit (cancelled, returned, etc.). */
  excludedFromSales?: boolean;
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
  | "all"
  | "custom";

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

  if (preset === "7d" || preset === "14d" || preset === "30d") {
    const days = preset === "7d" ? 7 : preset === "14d" ? 14 : 30;
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

/** Used by the Orders page period dropdown (same marketplace-local rules). */
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

export function aggregateOrderRows(rows: OrderRowLike[]) {
  const forRevenue = rows.filter((r) => !r.excludedFromSales);
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
  const totalProfit = forRevenue.reduce((sum, r) => sum + (r.profit ?? 0), 0);
  return { orderCount, totalSales, totalUnits, totalProfit };
}
