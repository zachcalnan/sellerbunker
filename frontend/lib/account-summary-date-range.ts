import {
  formatDateOnlyInTimeZone,
  getMarketplaceIanaTimeZone,
  parseYmdParts,
  subtractCivilDays,
} from "./marketplace-timezone";

/** Period keys used on the Orders tab — must match `GET /api/amazon/account/summary` calendar bounds. */
export type OrdersTabPeriodKey = "today" | "7" | "14" | "30";

/**
 * `start` / `end` date-only strings for account summary (marketplace-local calendar, inclusive).
 */
export function accountSummaryDateRangeForOrdersTab(
  period: OrdersTabPeriodKey,
  marketplaceId: string | null,
): { start: string; end: string } {
  const tz = getMarketplaceIanaTimeZone(marketplaceId);
  const nowMs = Date.now();
  const defaultEnd = formatDateOnlyInTimeZone(nowMs, tz);
  const todayYmd = parseYmdParts(defaultEnd);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const fmt = (y: { y: number; m: number; d: number }) =>
    `${y.y}-${pad2(y.m)}-${pad2(y.d)}`;
  if (period === "today") {
    return { start: defaultEnd, end: defaultEnd };
  }
  const days = period === "7" ? 7 : period === "14" ? 14 : 30;
  const startYmd = subtractCivilDays(todayYmd.y, todayYmd.m, todayYmd.d, days - 1);
  return { start: fmt(startYmd), end: defaultEnd };
}
