/**
 * Product Finder scoring — pure functions (no DB / no paid APIs).
 * Similarity is title/token based against the seller's own catalog.
 */

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type FinderConfidence = {
  level: ConfidenceLevel;
  score: number;
  reasons: string[];
};

export type FinderEconomicsInput = {
  resalePrice: number | null;
  feesPerUnit: number | null;
  buyPrice: number | null;
  /** Used only when feesPerUnit is null — marks low confidence. */
  feeFallbackRate?: number;
};

export type FinderEconomics = {
  resalePrice: number | null;
  feesPerUnit: number | null;
  buyPrice: number | null;
  profitPerUnit: number | null;
  roi: number | null;
  usedFeeFallback: boolean;
};

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'pack',
  'set',
  'new',
  'amazon',
  'ml',
  'oz',
  'fl',
]);

export function tokenizeFinderText(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

export function scoreTitleSimilarity(seedTitle: string, candidateTitle: string): number {
  const seed = tokenizeFinderText(seedTitle);
  const cand = tokenizeFinderText(candidateTitle);
  if (seed.length === 0 || cand.length === 0) return 0;

  const candSet = new Set(cand);
  let hits = 0;
  for (const t of seed) {
    if (candSet.has(t)) hits += 1;
    else if ([...candSet].some((c) => c.includes(t) || t.includes(c))) hits += 0.5;
  }
  const coverage = hits / seed.length;
  // Boost shared distinctive multi-char tokens
  let bonus = 0;
  for (const t of seed) {
    if (t.length >= 4 && candSet.has(t)) bonus += 1.5;
  }
  return Math.round((coverage * 40 + bonus) * 10) / 10;
}

export function computeFinderEconomics(input: FinderEconomicsInput): FinderEconomics {
  const resale =
    input.resalePrice != null && Number.isFinite(input.resalePrice) && input.resalePrice > 0
      ? input.resalePrice
      : null;
  const buy =
    input.buyPrice != null && Number.isFinite(input.buyPrice) && input.buyPrice > 0
      ? input.buyPrice
      : null;

  let usedFeeFallback = false;
  let fees: number | null =
    input.feesPerUnit != null && Number.isFinite(input.feesPerUnit) && input.feesPerUnit > 0
      ? Math.abs(input.feesPerUnit)
      : null;

  if (fees == null && resale != null) {
    const rate =
      input.feeFallbackRate != null && Number.isFinite(input.feeFallbackRate)
        ? input.feeFallbackRate
        : 0.35;
    fees = Math.round(resale * rate * 100) / 100;
    usedFeeFallback = true;
  }

  if (resale == null || buy == null || fees == null) {
    return {
      resalePrice: resale,
      feesPerUnit: fees,
      buyPrice: buy,
      profitPerUnit: null,
      roi: null,
      usedFeeFallback,
    };
  }

  const profit = Math.round((resale - fees - buy) * 100) / 100;
  const roi = buy > 0 ? Math.round((profit / buy) * 1000) / 1000 : null;
  return {
    resalePrice: resale,
    feesPerUnit: fees,
    buyPrice: buy,
    profitPerUnit: profit,
    roi,
    usedFeeFallback,
  };
}

export function buildFinderConfidence(opts: {
  similarScore: number;
  ungated: boolean | null;
  eligibilityAgeHours: number | null;
  hasFeeEstimate: boolean;
  usedFeeFallback: boolean;
  hasBuyPrice: boolean;
  unitsSold30d: number;
  unitsSold90d: number;
  historicalAvgProfit: number | null;
  meetsProfitGate: boolean;
}): FinderConfidence {
  let score = 0;
  const reasons: string[] = [];

  if (opts.similarScore >= 20) {
    score += 20;
    reasons.push('Strong title similarity to seed');
  } else if (opts.similarScore >= 10) {
    score += 12;
    reasons.push('Moderate title similarity to seed');
  } else if (opts.similarScore > 0) {
    score += 5;
    reasons.push('Weak title similarity');
  }

  if (opts.ungated === true) {
    score += 20;
    if (opts.eligibilityAgeHours != null && opts.eligibilityAgeHours <= 168) {
      score += 5;
      reasons.push('Ungated (eligibility checked within 7 days)');
    } else {
      reasons.push('Ungated (eligibility on file)');
    }
  } else if (opts.ungated === false) {
    score -= 25;
    reasons.push('Likely gated / cannot restock');
  } else {
    reasons.push('Ungated status unknown — refresh selling eligibility');
  }

  if (opts.hasFeeEstimate && !opts.usedFeeFallback) {
    score += 15;
    reasons.push('Amazon fee estimate on file');
  } else if (opts.usedFeeFallback) {
    score += 3;
    reasons.push('Fees estimated with fallback % (lower confidence)');
  } else {
    reasons.push('No fee estimate');
  }

  if (opts.hasBuyPrice) {
    score += 10;
    reasons.push('Buy/deal price available for profit math');
  } else {
    reasons.push('No buy price — set a deal price to score profit');
  }

  if (opts.unitsSold30d > 0) {
    score += 15;
    reasons.push(`Sold ${opts.unitsSold30d} units in last 30d`);
  } else if (opts.unitsSold90d > 0) {
    score += 8;
    reasons.push(`Sold ${opts.unitsSold90d} units in last 90d`);
  } else {
    reasons.push('No recent sales in account history');
  }

  if (opts.historicalAvgProfit != null && opts.historicalAvgProfit > 0) {
    score += 10;
    reasons.push('Positive historical profit on this ASIN');
  }

  if (opts.meetsProfitGate) {
    score += 10;
    reasons.push('Meets your profit / ROI gates at deal price');
  }

  score = Math.max(0, Math.min(100, score));
  const level: ConfidenceLevel =
    score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';

  return { level, score, reasons };
}

export function passesFinderGates(opts: {
  requireUngated: boolean;
  ungated: boolean | null;
  minProfitPerUnit: number;
  minRoi: number;
  profitPerUnit: number | null;
  roi: number | null;
}): boolean {
  if (opts.requireUngated && opts.ungated === false) return false;
  if (opts.profitPerUnit == null) return false;
  if (opts.profitPerUnit < opts.minProfitPerUnit) return false;
  if (opts.minRoi > 0 && (opts.roi == null || opts.roi < opts.minRoi)) return false;
  return true;
}
