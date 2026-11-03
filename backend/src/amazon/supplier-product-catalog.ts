/**
 * Known retail supplier → Amazon ASIN catalog used to enrich screenshot extracts.
 * Keep in sync with frontend/lib/supplier-checkout.util.ts.
 */

export type SupplierCatalogProduct = {
  supplierId: string;
  supplierLabel: string;
  asin: string;
  /** Canonical title for COGS / sheet */
  title: string;
  /** Short labels / aliases that appear on retailer confirmations */
  matchTokens: string[];
  unitRrpIncVat: number;
  size?: string;
};

export const SUPPLIER_CATALOG: SupplierCatalogProduct[] = [
  {
    supplierId: 'healf',
    supplierLabel: 'Healf',
    asin: 'B0BX4PX242',
    title: 'OneSkin OS-01 EYE Topical Supplement 20ml',
    matchTokens: [
      'os-01 eye',
      'os01 eye',
      'oneskin eye',
      'one skin eye',
      'eye topical',
      '20ml',
    ],
    unitRrpIncVat: 94.99,
    size: '20ml',
  },
  {
    supplierId: 'healf',
    supplierLabel: 'Healf',
    asin: 'B0BRYNPN93',
    title: 'OneSkin OS-01 BODY Peptide Moisturizer',
    matchTokens: [
      'os-01 body',
      'os01 body',
      'oneskin body',
      'one skin body',
      'body peptide',
      '250ml',
      '8.45',
    ],
    unitRrpIncVat: 85.99,
    size: '250ml',
  },
  {
    supplierId: 'thomann',
    supplierLabel: 'Thomann',
    asin: 'B07RM5DCFR',
    title: 'Otamatone Classic / Regular White',
    matchTokens: [
      'otamatone classic white',
      'otamatone regular white',
      'otamatone classic',
      'otamatone white',
      'otamatone',
      '428803',
    ],
    /** Seller cost target; Thomann often lists ~£24.90. */
    unitRrpIncVat: 25,
    size: 'Classic',
  },
];

export function normalizeMatchText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function scoreCatalogMatch(
  catalog: SupplierCatalogProduct,
  opts: {
    productTitle?: string | null;
    supplier?: string | null;
    unitRrpIncVat?: number | null;
    unitCostIncVat?: number | null;
    lineTotalIncVat?: number | null;
    qty?: number | null;
  },
): number {
  let score = 0;
  const title = normalizeMatchText(opts.productTitle ?? '');
  const supplier = normalizeMatchText(opts.supplier ?? '');

  if (supplier && supplier.includes(catalog.supplierId)) score += 2;
  if (supplier && supplier.includes(normalizeMatchText(catalog.supplierLabel))) {
    score += 2;
  }

  if (title) {
    const canon = normalizeMatchText(catalog.title);
    // Require the OCR/title side to be substantial before substring-of-canon boosts.
    // Otherwise size tokens like "20ml" (also in matchTokens / catalog title suffix) fake a hit.
    const titleIsSubstantial = title.length >= 8 && !/^\d+([.,]\d+)?\s*(ml|g|kg|oz|l|cl)$/i.test(title);
    if (
      title.includes(canon) ||
      (titleIsSubstantial && canon.includes(title))
    ) {
      score += 12;
    }
    for (const token of catalog.matchTokens) {
      const t = normalizeMatchText(token);
      // Size-only tokens (20ml, 250ml) are too weak alone; need another signal.
      const tokenIsSizeOnly = /^\d+([.,]\d+)?\s*(ml|g|kg|oz|l|cl)$/i.test(t);
      if (t.length >= 4 && title.includes(t) && !tokenIsSizeOnly) score += 4;
    }
    // Strong product-family tokens
    if (title.includes('eye') && catalog.asin === 'B0BX4PX242') score += 3;
    if (title.includes('body') && catalog.asin === 'B0BRYNPN93') score += 3;
    if (title.includes('otamatone') && catalog.asin === 'B07RM5DCFR') score += 6;
  }

  const rrp = opts.unitRrpIncVat;
  if (rrp != null && Math.abs(rrp - catalog.unitRrpIncVat) < 0.15) score += 10;

  const unitCost = opts.unitCostIncVat;
  // Plain RRP / cost match (non-promo retailers like Thomann).
  if (unitCost != null && Math.abs(unitCost - catalog.unitRrpIncVat) < 0.2) {
    score += 10;
  }
  // Thomann often charges £24.90 while we track £25.
  if (
    catalog.asin === 'B07RM5DCFR' &&
    unitCost != null &&
    Math.abs(unitCost - 24.9) < 0.05
  ) {
    score += 8;
  }

  const qty = opts.qty != null && opts.qty > 0 ? opts.qty : null;
  const lineTotal = opts.lineTotalIncVat;
  if (qty && lineTotal != null) {
    // 4-for-3 paid total ≈ 3 * RRP
    const expectedPaid = Number(
      (catalog.unitRrpIncVat * 3 * (qty / 4)).toFixed(2),
    );
    if (qty % 4 === 0 && Math.abs(lineTotal - expectedPaid) < 0.05) score += 12;
    // full RRP total
    const expectedFull = Number((catalog.unitRrpIncVat * qty).toFixed(2));
    if (Math.abs(lineTotal - expectedFull) < 0.15) score += 8;
    const expectedThomann = Number((24.9 * qty).toFixed(2));
    if (
      catalog.asin === 'B07RM5DCFR' &&
      Math.abs(lineTotal - expectedThomann) < 0.15
    ) {
      score += 10;
    }
  }

  if (unitCost != null && qty && qty % 4 === 0) {
    const expectedUnit = Number(((catalog.unitRrpIncVat * 3) / 4).toFixed(2));
    if (Math.abs(unitCost - expectedUnit) < 0.05) score += 10;
  }

  return score;
}

/** Known supplier RRP for fee-estimate input when Listings API has no price yet. */
export function catalogListedPriceForAsin(asin: string | null | undefined): number | null {
  const key = (asin ?? '').trim().toUpperCase();
  if (!key) return null;
  const hit = SUPPLIER_CATALOG.find((p) => p.asin.toUpperCase() === key);
  const rrp = hit?.unitRrpIncVat;
  return rrp != null && Number.isFinite(rrp) && rrp > 0 ? rrp : null;
}

/** Canonical catalog title for a known supplier ASIN (inventory display / weak-title repair). */
export function catalogTitleForAsin(asin: string | null | undefined): string | null {
  const key = (asin ?? '').trim().toUpperCase();
  if (!key) return null;
  const hit = SUPPLIER_CATALOG.find((p) => p.asin.toUpperCase() === key);
  return hit?.title ?? null;
}

export function bestCatalogMatch(opts: {
  productTitle?: string | null;
  supplier?: string | null;
  unitRrpIncVat?: number | null;
  unitCostIncVat?: number | null;
  lineTotalIncVat?: number | null;
  qty?: number | null;
  minScore?: number;
}): { product: SupplierCatalogProduct; score: number } | null {
  const minScore = opts.minScore ?? 8;
  let best: { product: SupplierCatalogProduct; score: number } | null = null;
  for (const product of SUPPLIER_CATALOG) {
    const score = scoreCatalogMatch(product, opts);
    if (!best || score > best.score) best = { product, score };
  }
  if (!best || best.score < minScore) return null;
  return best;
}
