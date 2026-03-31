/**
 * IANA zones aligned with Seller Central–style marketplace “local” calendar days.
 * Used for date-only ranges and “today” filters so counts match SC (not UTC midnight).
 */
export const MARKETPLACE_ID_TO_IANA: Record<string, string> = {
  A1F83G8C2ARO7P: "Europe/London",
  A1PA6795UKMFR9: "Europe/Berlin",
  A13V1IB3VIYZZH: "Europe/Paris",
  APJ6JRA9NG5V4: "Europe/Rome",
  A1RKKUPIHCS9HS: "Europe/Madrid",
  A1805IZSGTT6HS: "Europe/Amsterdam",
  A28R8C7NBKEWEA: "Europe/Dublin",
  ATVPDKIKX0DER: "America/Los_Angeles",
  A2EUQ1WTGCTBG2: "America/Toronto",
  A1AM78C64UM0Y8: "America/Mexico_City",
  A1VC38T7YXB528: "Asia/Tokyo",
  A39IBJ37TRP1C6: "Australia/Sydney",
};

export function getMarketplaceIanaTimeZone(marketplaceId: string | null | undefined): string {
  if (!marketplaceId) return "UTC";
  return MARKETPLACE_ID_TO_IANA[marketplaceId] ?? "UTC";
}

export function getLocalYmdFromUtcMs(ms: number, timeZone: string): { y: number; m: number; d: number } {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(ms));
  return {
    y: Number(parts.find((p) => p.type === "year")?.value),
    m: Number(parts.find((p) => p.type === "month")?.value),
    d: Number(parts.find((p) => p.type === "day")?.value),
  };
}

function getLocalYMD(ms: number, timeZone: string): { y: number; m: number; d: number } {
  return getLocalYmdFromUtcMs(ms, timeZone);
}

function ymdCompare(
  a: { y: number; m: number; d: number },
  b: { y: number; m: number; d: number },
): number {
  if (a.y !== b.y) return a.y - b.y;
  if (a.m !== b.m) return a.m - b.m;
  return a.d - b.d;
}

/** First UTC ms where the local calendar date in `timeZone` is `targetYmd`. */
export function startOfLocalDayUtcMs(
  targetYmd: { y: number; m: number; d: number },
  timeZone: string,
): number {
  const { y, m, d } = targetYmd;
  let lo = Date.UTC(y, m - 1, d, 12, 0, 0, 0) - 14 * 24 * 60 * 60 * 1000;
  let hi = Date.UTC(y, m - 1, d, 12, 0, 0, 0) + 14 * 24 * 60 * 60 * 1000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const p = getLocalYMD(mid, timeZone);
    if (ymdCompare(p, targetYmd) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function addOneCivilDay(y: number, m: number, d: number): { y: number; m: number; d: number } {
  const u = new Date(Date.UTC(y, m - 1, d + 1));
  return { y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate() };
}

/** Last UTC ms (inclusive) of local calendar day `targetYmd` in `timeZone`. */
export function endOfLocalDayInclusiveUtcMs(
  targetYmd: { y: number; m: number; d: number },
  timeZone: string,
): number {
  const next = addOneCivilDay(targetYmd.y, targetYmd.m, targetYmd.d);
  const startOfNext = startOfLocalDayUtcMs(next, timeZone);
  return startOfNext - 1;
}

export function formatDateOnlyInTimeZone(ms: number, timeZone: string): string {
  const { y, m, d } = getLocalYMD(ms, timeZone);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseYmdParts(dateOnly: string): { y: number; m: number; d: number } {
  const [y, m, d] = dateOnly.split("-").map(Number);
  return { y, m, d };
}

/** Subtract `days` civil calendar days from Y-M-D (Gregorian). */
export function subtractCivilDays(
  y: number,
  m: number,
  d: number,
  days: number,
): { y: number; m: number; d: number } {
  const u = new Date(Date.UTC(y, m - 1, d - days));
  return { y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate() };
}
