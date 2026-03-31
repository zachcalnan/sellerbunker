/**
 * Marketplace-local calendar bounds for date-only query params (Seller Central parity).
 */
export const MARKETPLACE_ID_TO_IANA: Record<string, string> = {
  A1F83G8C2ARO7P: 'Europe/London',
  A1PA6795UKMFR9: 'Europe/Berlin',
  A13V1IB3VIYZZH: 'Europe/Paris',
  APJ6JRA9NG5V4: 'Europe/Rome',
  A1RKKUPIHCS9HS: 'Europe/Madrid',
  A1805IZSGTT6HS: 'Europe/Amsterdam',
  A28R8C7NBKEWEA: 'Europe/Dublin',
  ATVPDKIKX0DER: 'America/Los_Angeles',
  A2EUQ1WTGCTBG2: 'America/Toronto',
  A1AM78C64UM0Y8: 'America/Mexico_City',
  A1VC38T7YXB528: 'Asia/Tokyo',
  A39IBJ37TRP1C6: 'Australia/Sydney',
};

export function getMarketplaceIanaTimeZone(marketplaceId?: string | null): string {
  if (!marketplaceId) return 'UTC';
  return MARKETPLACE_ID_TO_IANA[marketplaceId] ?? 'UTC';
}

function getLocalYMD(ms: number, timeZone: string): { y: number; m: number; d: number } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(ms));
  return {
    y: Number(parts.find((p) => p.type === 'year')?.value),
    m: Number(parts.find((p) => p.type === 'month')?.value),
    d: Number(parts.find((p) => p.type === 'day')?.value),
  };
}

function ymdCompare(
  a: { y: number; m: number; d: number },
  b: { y: number; m: number; d: number },
): number {
  if (a.y !== b.y) return a.y - b.y;
  if (a.m !== b.m) return a.m - b.m;
  return a.d - b.d;
}

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

export function endOfLocalDayInclusiveUtcMs(
  targetYmd: { y: number; m: number; d: number },
  timeZone: string,
): number {
  const next = addOneCivilDay(targetYmd.y, targetYmd.m, targetYmd.d);
  const startOfNext = startOfLocalDayUtcMs(next, timeZone);
  return startOfNext - 1;
}

function parseYmdParts(dateOnly: string): { y: number; m: number; d: number } {
  const [y, m, d] = dateOnly.split('-').map(Number);
  return { y, m, d };
}

/**
 * Inclusive local calendar range for YYYY-MM-DD … YYYY-MM-DD in the marketplace timezone.
 * Caps “today” at `nowCap` when the end date is the current local day (orders through now).
 */
export function dateOnlyRangeToUtcInclusive(
  start: string,
  end: string,
  marketplaceId: string | undefined,
  nowCap: Date,
): { safeStart: Date; safeEnd: Date } {
  const tz = getMarketplaceIanaTimeZone(marketplaceId);
  const s = parseYmdParts(start);
  const e = parseYmdParts(end);
  const safeStart = new Date(startOfLocalDayUtcMs(s, tz));
  let endMs = endOfLocalDayInclusiveUtcMs(e, tz);
  const todayYmd = getLocalYMD(nowCap.getTime(), tz);
  if (ymdCompare(e, todayYmd) === 0) {
    endMs = Math.min(endMs, nowCap.getTime());
  }
  return { safeStart, safeEnd: new Date(endMs) };
}

const isDateOnlyString = (s?: string) =>
  !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Resolves dashboard `start` / `end` query params to UTC bounds.
 * Date-only YYYY-MM-DD uses marketplace-local days (Seller Central parity); ISO datetimes pass through.
 */
export function resolveDashboardRangeUtc(
  range: { start?: string; end?: string } | undefined,
  marketplaceId: string | undefined,
  nowCap: Date,
): { safeStart: Date; safeEnd: Date } {
  const parseDate = (s?: string): Date | null => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  if (
    isDateOnlyString(range?.start) &&
    isDateOnlyString(range?.end) &&
    range?.start &&
    range?.end
  ) {
    return dateOnlyRangeToUtcInclusive(
      range.start,
      range.end,
      marketplaceId,
      nowCap,
    );
  }

  const endDate = (() => {
    const d = parseDate(range?.end);
    if (!d) return nowCap;
    if (isDateOnlyString(range?.end)) {
      return new Date(`${range?.end}T23:59:59.999Z`);
    }
    return d;
  })();
  const startDate = (() => {
    const d = parseDate(range?.start);
    if (d) {
      if (isDateOnlyString(range?.start)) {
        return new Date(`${range?.start}T00:00:00.000Z`);
      }
      return d;
    }
    return new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  })();

  const safeStart =
    startDate <= endDate
      ? startDate
      : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  const safeEnd = endDate;
  return { safeStart, safeEnd };
}
