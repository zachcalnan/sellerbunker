/**
 * Pure Keepa history → deal-check math (no network).
 * Price source preference: NEW_FBA (csv[10]) when present, else marketplace NEW (csv[1]).
 * Never uses Amazon 1P (csv[0]) as the sell assumption.
 */

export const KEEPA_CSV = {
  AMAZON: 0,
  NEW: 1,
  SALES: 3,
  NEW_FBA: 10,
  BUY_BOX_SHIPPING: 18,
} as const;

/** Keepa epoch: minutes since 2010-10-21. */
export const KEEPA_EPOCH_MS = Date.UTC(2010, 9, 21);

export type KeepaPriceSource = 'keepa_new_fba' | 'keepa_new';

export type DealCheckPriceStats = {
  source: KeepaPriceSource;
  sampleDays: number;
  lookbackDays: number;
  currentPrice: number | null;
  medianPrice: number | null;
  goodResalePrice: number | null;
  bestCaseResalePrice: number | null;
  /** Share of in-stock days marketplace New/FBA was ≥ goodResalePrice (0–100). */
  probabilityPct: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  /** December-only good band (75th), when enough Dec samples exist. */
  decemberGoodResalePrice: number | null;
  decemberSampleDays: number;
  /** 0–1 blend weight toward December band used in goodResalePrice. */
  decemberWeight: number;
};

/** Pull good/best targets toward December highs (Q4 peak season). */
export const DECEMBER_BLEND_WEIGHT = 0.4;
/** Need at least this many December in-stock days to apply the blend. */
export const DECEMBER_MIN_SAMPLE_DAYS = 7;

export type DealCheckEconomics = {
  buyPrice: number;
  resalePrice: number;
  feesPerUnit: number;
  profitPerUnit: number;
  roi: number;
  meetsRoiGate: boolean;
  usedFeeFallback: boolean;
};

const ROI_GATE = 0.15;

export function keepaMinutesToUnixMs(keepaMinutes: number): number {
  return KEEPA_EPOCH_MS + keepaMinutes * 60_000;
}

export function unixMsToKeepaMinutes(unixMs: number): number {
  return Math.floor((unixMs - KEEPA_EPOCH_MS) / 60_000);
}

/** Keepa stores most locales in minor units (pence). Japan is whole yen. */
export function keepaRawToMajor(raw: number, domainId: number): number {
  if (!Number.isFinite(raw) || raw < 0) return NaN;
  if (domainId === 5) return raw;
  return raw / 100;
}

export function marketplaceIdToKeepaDomain(marketplaceId: string | null | undefined): number {
  const id = String(marketplaceId ?? '').trim();
  switch (id) {
    case 'ATVPDKIKX0DER':
      return 1; // US
    case 'A1F83G8C2ARO7P':
      return 2; // UK
    case 'A1PA6795UKMFR9':
      return 3; // DE
    case 'A13V1IB3VIYZZH':
      return 4; // FR
    case 'A1VC38T7YXB528':
      return 5; // JP
    case 'A2EUQ1WTGCTBG2':
      return 6; // CA
    case 'APJ6JRA9NG5V4':
      return 8; // IT
    case 'A1RKKUPIHCS9HS':
      return 9; // ES
    default:
      return 2; // default UK for this app
  }
}

export function currencyForKeepaDomain(domainId: number): string {
  switch (domainId) {
    case 1:
      return 'USD';
    case 2:
      return 'GBP';
    case 3:
      return 'EUR';
    case 4:
      return 'EUR';
    case 5:
      return 'JPY';
    case 6:
      return 'CAD';
    case 8:
      return 'EUR';
    case 9:
      return 'EUR';
    default:
      return 'GBP';
  }
}

type TimedPrice = { tMs: number; price: number };

/**
 * Parse Keepa csv row [t, value, t, value, ...] into timed major-unit prices.
 * Drops -1 / missing offer points.
 */
export function parseKeepaCsvPriceSeries(
  csvRow: unknown,
  domainId: number,
): TimedPrice[] {
  if (!Array.isArray(csvRow) || csvRow.length < 2) return [];
  const out: TimedPrice[] = [];
  for (let i = 0; i + 1 < csvRow.length; i += 2) {
    const tRaw = Number(csvRow[i]);
    const vRaw = Number(csvRow[i + 1]);
    if (!Number.isFinite(tRaw) || !Number.isFinite(vRaw) || vRaw < 0) continue;
    const price = keepaRawToMajor(vRaw, domainId);
    if (!Number.isFinite(price) || price <= 0) continue;
    out.push({ tMs: keepaMinutesToUnixMs(tRaw), price });
  }
  out.sort((a, b) => a.tMs - b.tMs);
  return out;
}

/**
 * Expand change-point history into one sample per calendar day (forward-fill).
 * Only days with a known in-stock price are included.
 */
export function dailyForwardFillTimedPrices(
  series: TimedPrice[],
  opts: { lookbackDays: number; nowMs?: number },
): TimedPrice[] {
  if (series.length === 0) return [];
  const nowMs = opts.nowMs ?? Date.now();
  const lookbackDays = Math.max(7, Math.min(365, Math.floor(opts.lookbackDays)));
  const startMs = nowMs - lookbackDays * 86_400_000;

  // Last known price before window (if any)
  let idx = 0;
  let last: number | null = null;
  while (idx < series.length && series[idx].tMs < startMs) {
    last = series[idx].price;
    idx += 1;
  }

  const dayMs = 86_400_000;
  const samples: TimedPrice[] = [];
  for (let dayStart = startMs; dayStart <= nowMs; dayStart += dayMs) {
    const dayEnd = dayStart + dayMs;
    while (idx < series.length && series[idx].tMs < dayEnd) {
      last = series[idx].price;
      idx += 1;
    }
    if (last != null && last > 0) samples.push({ tMs: dayStart, price: last });
  }
  return samples;
}

export function dailyForwardFillPrices(
  series: TimedPrice[],
  opts: { lookbackDays: number; nowMs?: number },
): number[] {
  return dailyForwardFillTimedPrices(series, opts).map((s) => s.price);
}

function isUtcDecember(tMs: number): boolean {
  return new Date(tMs).getUTCMonth() === 11;
}

/** Blend all-year band with December band: (1-w)*all + w*dec. */
export function blendWithDecember(opts: {
  allBand: number | null;
  decemberBand: number | null;
  weight?: number;
}): number | null {
  const w = Math.max(0, Math.min(1, opts.weight ?? DECEMBER_BLEND_WEIGHT));
  const all = opts.allBand;
  const dec = opts.decemberBand;
  if (all == null && dec == null) return null;
  if (all == null) return dec;
  if (dec == null || w <= 0) return all;
  return (1 - w) * all + w * dec;
}

export function percentileNearest(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const clamped = Math.max(0, Math.min(1, p));
  const i = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.round((sortedAsc.length - 1) * clamped)),
  );
  return sortedAsc[i] ?? null;
}

/** Whole major units for a “good level” sell target (£79 style). */
export function roundDealTarget(price: number, domainId: number): number {
  if (!Number.isFinite(price) || price <= 0) return price;
  if (domainId === 5) return Math.round(price);
  return Math.max(1, Math.round(price));
}

export function pickKeepaPriceSeries(
  csv: unknown,
  domainId: number,
): { source: KeepaPriceSource; series: TimedPrice[] } {
  const rows = Array.isArray(csv) ? csv : [];
  const fba = parseKeepaCsvPriceSeries(rows[KEEPA_CSV.NEW_FBA], domainId);
  if (fba.length >= 3) {
    return { source: 'keepa_new_fba', series: fba };
  }
  const neu = parseKeepaCsvPriceSeries(rows[KEEPA_CSV.NEW], domainId);
  return { source: 'keepa_new', series: neu };
}

export function computeDealCheckPriceStats(input: {
  csv: unknown;
  domainId: number;
  lookbackDays?: number;
  nowMs?: number;
  /** Good-case percentile (default 0.75). */
  goodPercentile?: number;
  /** Best-case percentile (default 0.9). */
  bestPercentile?: number;
  /** 0–1 weight toward December band (default DECEMBER_BLEND_WEIGHT). */
  decemberWeight?: number;
}): DealCheckPriceStats {
  // 365d so November checks still see last December’s peak season.
  const lookbackDays = input.lookbackDays ?? 365;
  const decemberWeight = Math.max(
    0,
    Math.min(1, input.decemberWeight ?? DECEMBER_BLEND_WEIGHT),
  );
  const { source, series } = pickKeepaPriceSeries(input.csv, input.domainId);
  const timed = dailyForwardFillTimedPrices(series, {
    lookbackDays,
    nowMs: input.nowMs,
  });
  const daily = timed.map((s) => s.price);
  const sorted = [...daily].sort((a, b) => a - b);
  const goodAll = percentileNearest(sorted, input.goodPercentile ?? 0.75);
  const bestAll = percentileNearest(sorted, input.bestPercentile ?? 0.9);

  const decemberPrices = timed
    .filter((s) => isUtcDecember(s.tMs))
    .map((s) => s.price);
  const decSorted = [...decemberPrices].sort((a, b) => a - b);
  const hasDecember =
    decSorted.length >= DECEMBER_MIN_SAMPLE_DAYS;
  const goodDec = hasDecember
    ? percentileNearest(decSorted, input.goodPercentile ?? 0.75)
    : null;
  const bestDec = hasDecember
    ? percentileNearest(decSorted, input.bestPercentile ?? 0.9)
    : null;

  const appliedWeight = hasDecember ? decemberWeight : 0;
  const goodBlended = blendWithDecember({
    allBand: goodAll,
    decemberBand: goodDec,
    weight: appliedWeight,
  });
  const bestBlended = blendWithDecember({
    allBand: bestAll,
    decemberBand: bestDec,
    weight: appliedWeight,
  });

  const good =
    goodBlended != null ? roundDealTarget(goodBlended, input.domainId) : null;
  const best =
    bestBlended != null ? roundDealTarget(bestBlended, input.domainId) : null;
  const decemberGood =
    goodDec != null ? roundDealTarget(goodDec, input.domainId) : null;

  let probabilityPct: number | null = null;
  if (good != null && daily.length > 0) {
    const hits = daily.filter((p) => p >= good).length;
    probabilityPct = Math.round((hits / daily.length) * 1000) / 10;
  }

  const median = percentileNearest(sorted, 0.5);
  const current = daily.length > 0 ? daily[daily.length - 1]! : null;

  return {
    source,
    sampleDays: daily.length,
    lookbackDays,
    currentPrice:
      current != null ? Math.round(current * 100) / 100 : null,
    medianPrice: median != null ? Math.round(median * 100) / 100 : null,
    goodResalePrice: good,
    bestCaseResalePrice: best,
    probabilityPct,
    minPrice: sorted.length ? Math.round(sorted[0]! * 100) / 100 : null,
    maxPrice: sorted.length
      ? Math.round(sorted[sorted.length - 1]! * 100) / 100
      : null,
    decemberGoodResalePrice: decemberGood,
    decemberSampleDays: decSorted.length,
    decemberWeight: appliedWeight,
  };
}

export function computeDealCheckEconomics(input: {
  buyPrice: number;
  resalePrice: number;
  feesPerUnit: number | null;
  feeFallbackRate?: number;
  roiGate?: number;
}): DealCheckEconomics {
  const buy = Math.max(0, input.buyPrice);
  const resale = Math.max(0, input.resalePrice);
  let usedFeeFallback = false;
  let fees =
    input.feesPerUnit != null && Number.isFinite(input.feesPerUnit)
      ? Math.abs(input.feesPerUnit)
      : null;
  if (fees == null || fees <= 0) {
    const rate =
      input.feeFallbackRate != null && Number.isFinite(input.feeFallbackRate)
        ? input.feeFallbackRate
        : 0.35;
    fees = Math.round(resale * rate * 100) / 100;
    usedFeeFallback = true;
  }
  const profit = Math.round((resale - fees - buy) * 100) / 100;
  const roi = buy > 0 ? Math.round((profit / buy) * 1000) / 1000 : 0;
  const gate = input.roiGate ?? ROI_GATE;
  return {
    buyPrice: buy,
    resalePrice: resale,
    feesPerUnit: fees,
    profitPerUnit: profit,
    roi,
    meetsRoiGate: roi >= gate,
    usedFeeFallback,
  };
}

export const DEAL_CHECK_ROI_GATE = ROI_GATE;
