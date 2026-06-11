/** UTC calendar date key YYYY-MM-DD */
export function toUtcDateKey(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Inclusive calendar-day span between two instants (UTC dates). */
export function inclusiveUtcDaySpan(from: Date, to: Date): number {
  const a = toUtcDateKey(from);
  const b = toUtcDateKey(to);
  return Math.max(1, Math.floor((b - a) / 86_400_000) + 1);
}

/**
 * Estimate days the SKU was in stock during a velocity window.
 * Uses sale dates + (if still stocked) days from first sale through today — not full calendar window.
 */
export function estimateInStockDaysForVelocity(opts: {
  unitsSold: number;
  orderDates: Date[];
  windowDays: number;
  windowStart: Date;
  effectiveStock: number;
  now: Date;
}): number {
  const { unitsSold, orderDates, windowDays, windowStart, effectiveStock, now } =
    opts;

  if (unitsSold <= 0 || orderDates.length === 0) {
    return Math.max(1, windowDays);
  }

  const daysWithSales = new Set(
    orderDates.map((d) => d.toISOString().slice(0, 10)),
  ).size;

  const sorted = [...orderDates].sort((a, b) => a.getTime() - b.getTime());
  const firstSale = sorted[0]!;
  const lastSale = sorted[sorted.length - 1]!;

  const firstInWindow =
    firstSale.getTime() < windowStart.getTime() ? windowStart : firstSale;
  const stockThrough = effectiveStock > 0 ? now : lastSale;

  let span = inclusiveUtcDaySpan(firstInWindow, stockThrough);
  span = Math.min(windowDays, Math.max(daysWithSales, span));
  return Math.max(1, span);
}

export function avgDailyUnitsInStock(
  unitsSold: number,
  inStockDays: number,
  unknownDemandFloorPerDay: number,
): number {
  if (unitsSold <= 0) return 0;
  return unitsSold / Math.max(1, inStockDays);
}
