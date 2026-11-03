import {
  ExtractedPurchaseDraft,
  ExtractedPurchaseLine,
} from './purchase-screenshot-extract.util';
import {
  bestCatalogMatch,
  normalizeMatchText,
} from './supplier-product-catalog';

export type DbProductHint = {
  asin: string | null;
  sku: string;
  title: string | null;
};

export type ListingCandidate = {
  asin: string;
  sku: string;
  title: string;
  score: number;
};

/** Distinctive tokens get more weight when matching OCR titles to listings. */
const BOOST_TOKENS = new Set([
  'oneskin',
  'os',
  '01',
  'eye',
  'body',
  'face',
  'healf',
  'peptide',
  'topical',
  'supplement',
  'moisturizer',
  'moisturiser',
  'spf',
  'otamatone',
  'classic',
  'thomann',
  'regular',
  'pura',
  'dor',
  'biotin',
  'shampoo',
  'iherb',
]);

export function scoreDbTitle(query: string, candidate: string): number {
  const q = normalizeMatchText(query);
  const c = normalizeMatchText(candidate);
  if (!q || !c) return 0;
  if (q === c) return 40;
  if (c.includes(q) || q.includes(c)) return 28;

  const qTokens = q.split(' ').filter((t) => t.length >= 2);
  const cTokens = new Set(c.split(' ').filter((t) => t.length >= 2));
  if (qTokens.length === 0) return 0;

  let hits = 0;
  let weighted = 0;
  for (const t of qTokens) {
    if (!cTokens.has(t) && ![...cTokens].some((ct) => ct.includes(t) || t.includes(ct))) {
      continue;
    }
    hits += 1;
    weighted += BOOST_TOKENS.has(t) ? 5 : 2;
  }
  if (hits === 0) return 0;

  const coverage = hits / qTokens.length;
  const score = weighted + Math.round(coverage * 12);
  // Need decent overlap so short generic words don't win.
  if (coverage < 0.34 && hits < 2) return 0;
  return score;
}

export function rankListingMatches(
  queryTitle: string | undefined | null,
  dbProducts: DbProductHint[],
  opts?: { knownAsin?: string | null; limit?: number },
): ListingCandidate[] {
  const limit = opts?.limit ?? 5;
  const knownAsin = opts?.knownAsin?.toUpperCase() ?? '';
  const byAsin = new Map<string, ListingCandidate>();

  for (const p of dbProducts) {
    if (!p.asin || !p.title) continue;
    const asin = p.asin.toUpperCase();
    let score = scoreDbTitle(queryTitle ?? '', p.title);
    if (knownAsin && asin === knownAsin) score += 25;
    if (score <= 0) continue;
    const prev = byAsin.get(asin);
    if (!prev || score > prev.score) {
      byAsin.set(asin, {
        asin,
        sku: p.sku,
        title: p.title,
        score,
      });
    }
  }

  return [...byAsin.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/**
 * Auto-apply a listing when the top match is strong and clearly ahead of #2.
 */
export function shouldAutoApplyListing(
  ranked: ListingCandidate[],
): ListingCandidate | null {
  const top = ranked[0];
  if (!top) return null;
  if (top.score < 12) return null;
  const second = ranked[1];
  if (second && top.score - second.score < 3 && top.score < 20) return null;
  return top;
}

export function enrichDraftWithCatalogAndDb(
  draft: ExtractedPurchaseDraft,
  dbProducts: DbProductHint[] = [],
): ExtractedPurchaseDraft {
  const warnings = [...draft.warnings];
  const lines: ExtractedPurchaseLine[] = draft.lines.map((line) => {
    const next: ExtractedPurchaseLine = { ...line };
    let matchedVia = '';

    // 1) Prefer OCR title → listings match when we have a title from the image.
    const rankedFromTitle = rankListingMatches(next.productTitle, dbProducts, {
      knownAsin: next.asin,
    });
    const autoListing = next.productTitle?.trim()
      ? shouldAutoApplyListing(rankedFromTitle)
      : null;

    if (autoListing) {
      if (!next.asin) {
        next.asin = autoListing.asin;
        matchedVia = `listing ASIN ${autoListing.asin}`;
      }
      // Prefer the Amazon listing title for sheet/COGS consistency.
      if (
        !next.productTitle?.trim() ||
        scoreDbTitle(next.productTitle, autoListing.title) >= 12
      ) {
        if (next.productTitle?.trim() !== autoListing.title) {
          next.productTitle = autoListing.title;
          matchedVia = matchedVia
            ? `${matchedVia} + listing title`
            : `listing title (${autoListing.title})`;
        }
      }
      if (!next.sku?.trim()) next.sku = autoListing.sku;
    }

    // 2) Catalog fill (Healf EYE/BODY) when still missing — price/token based.
    const catalogHit = bestCatalogMatch({
      productTitle: next.productTitle,
      supplier: draft.supplier,
      unitRrpIncVat: next.unitRrpIncVat,
      unitCostIncVat: next.unitCostIncVat,
      lineTotalIncVat: next.lineTotalIncVat,
      qty: next.qty,
      minScore: 8,
    });

    if (catalogHit) {
      if (!next.asin) {
        next.asin = catalogHit.product.asin;
        matchedVia = matchedVia
          ? `${matchedVia}; catalog ASIN ${catalogHit.product.asin}`
          : `catalog ASIN ${catalogHit.product.asin}`;
      }
      if (!next.productTitle?.trim()) {
        next.productTitle = catalogHit.product.title;
        matchedVia = matchedVia
          ? `${matchedVia} + catalog title`
          : `catalog title (${catalogHit.product.title})`;
      }
      if (next.unitRrpIncVat == null || next.unitRrpIncVat <= 0) {
        next.unitRrpIncVat = catalogHit.product.unitRrpIncVat;
      }
    }

    // 3) Re-rank listings with any new title/ASIN for UI suggestions.
    let ranked = rankListingMatches(next.productTitle, dbProducts, {
      knownAsin: next.asin,
    });

    // If still no ASIN, try auto-apply from price-driven catalog ASIN against DB.
    if (!next.asin && ranked.length === 0 && catalogHit) {
      ranked = rankListingMatches(catalogHit.product.title, dbProducts, {
        knownAsin: catalogHit.product.asin,
      });
    }

    if (!next.asin) {
      const fallback = shouldAutoApplyListing(ranked);
      if (fallback) {
        next.asin = fallback.asin;
        if (!next.productTitle?.trim()) next.productTitle = fallback.title;
        if (!next.sku?.trim()) next.sku = fallback.sku;
        matchedVia = matchedVia
          ? `${matchedVia}; listing ASIN ${fallback.asin}`
          : `listing ASIN ${fallback.asin}`;
      }
    }

    next.listingCandidates = ranked;

    if (matchedVia) {
      warnings.push(`Matched ${matchedVia} (verify before submit).`);
    } else if (!next.asin && ranked.length > 0) {
      warnings.push(
        `Possible listing matches for "${next.productTitle ?? 'line'}" — pick one or open SAS.`,
      );
    }
    return next;
  });

  return { ...draft, lines, warnings };
}
