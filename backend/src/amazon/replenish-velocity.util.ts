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

export function utcDayDate(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Days the SKU was available on Amazon during the velocity window.
 *
 * Preferred: count of UTC days where fulfillable qty was > 0 (from inventory
 * availability snapshots). That matches demand = unitsSold / availableDays
 * (e.g. 1 unit over 5 available days → 0.2/day).
 *
 * Fallback (no/insufficient snapshot history): full lookback window — never
 * the old first-sale→last-sale span, which inflated slow movers to ~1/day.
 */
export function resolveInStockDaysForVelocity(opts: {
  windowDays: number;
  /** Distinct UTC days in the window with a snapshot for this ASIN. */
  observedDays: number | null;
  /** Distinct UTC days in the window with availableQty > 0 for this ASIN. */
  observedInStockDays: number | null;
}): number {
  const windowDays = Math.max(1, opts.windowDays);
  const observedDays =
    opts.observedDays != null && Number.isFinite(opts.observedDays)
      ? Math.max(0, Math.floor(opts.observedDays))
      : null;
  const observedInStockDays =
    opts.observedInStockDays != null && Number.isFinite(opts.observedInStockDays)
      ? Math.max(0, Math.floor(opts.observedInStockDays))
      : null;

  const minCoverage = Math.min(7, windowDays);
  if (
    observedDays != null &&
    observedInStockDays != null &&
    observedDays >= minCoverage &&
    observedInStockDays > 0
  ) {
    return Math.max(1, Math.min(windowDays, observedInStockDays));
  }

  return windowDays;
}

/** @deprecated Use resolveInStockDaysForVelocity */
export function estimateInStockDaysForVelocity(opts: {
  unitsSold: number;
  orderDates: Date[];
  windowDays: number;
  windowStart: Date;
  effectiveStock: number;
  now: Date;
  observedDays?: number | null;
  observedInStockDays?: number | null;
}): number {
  return resolveInStockDaysForVelocity({
    windowDays: opts.windowDays,
    observedDays: opts.observedDays ?? null,
    observedInStockDays: opts.observedInStockDays ?? null,
  });
}

export function avgDailyUnitsInStock(
  unitsSold: number,
  inStockDays: number,
  _unknownDemandFloorPerDay: number,
): number {
  if (unitsSold <= 0) return 0;
  return unitsSold / Math.max(1, inStockDays);
}
