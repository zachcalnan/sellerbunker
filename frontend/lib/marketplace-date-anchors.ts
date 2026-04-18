import {
  formatDateOnlyInTimeZone,
  getMarketplaceIanaTimeZone,
  parseYmdParts,
  subtractCivilDays,
} from "./marketplace-timezone";

/** Calendar “today” / N-day starts in the selected marketplace timezone (Seller Central parity). */
export function marketplaceLocalDateAnchors(selectedMarketplaceId: string | null) {
  const marketplaceTz = getMarketplaceIanaTimeZone(selectedMarketplaceId);
  const nowMs = Date.now();
  const defaultEnd = formatDateOnlyInTimeZone(nowMs, marketplaceTz);
  const todayYmd = parseYmdParts(defaultEnd);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const fmtYmd = (y: { y: number; m: number; d: number }) =>
    `${y.y}-${pad2(y.m)}-${pad2(y.d)}`;
  return {
    marketplaceTz,
    defaultEnd,
    defaultStart30: fmtYmd(
      subtractCivilDays(todayYmd.y, todayYmd.m, todayYmd.d, 29),
    ),
    defaultStart14: fmtYmd(
      subtractCivilDays(todayYmd.y, todayYmd.m, todayYmd.d, 13),
    ),
    defaultStart7: fmtYmd(
      subtractCivilDays(todayYmd.y, todayYmd.m, todayYmd.d, 6),
    ),
    /** Inclusive rolling window of 183 marketplace-local calendar days ending today (~6 months; same pattern as 30d). */
    defaultStart183: fmtYmd(
      subtractCivilDays(todayYmd.y, todayYmd.m, todayYmd.d, 182),
    ),
    /** Inclusive rolling window of 365 marketplace-local calendar days ending today (same pattern as 30d). */
    defaultStart365: fmtYmd(
      subtractCivilDays(todayYmd.y, todayYmd.m, todayYmd.d, 364),
    ),
    yesterday: fmtYmd(
      subtractCivilDays(todayYmd.y, todayYmd.m, todayYmd.d, 1),
    ),
  };
}
