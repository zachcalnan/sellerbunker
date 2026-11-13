/**
 * Helpers for FBA Inventory API v1 inventorySummaries rows.
 * productName is the marketplace-localized listing title (often present even at qty 0).
 */

export function parseFbaInventoryProductName(summary: unknown): string | null {
  if (!summary || typeof summary !== 'object') return null;
  const o = summary as Record<string, unknown>;
  const raw = o.productName ?? o.ProductName;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** True when Product.title / imageUrl should be treated as missing for enrichment. */
export function isBlankProductCatalogAttr(
  value: string | null | undefined,
): boolean {
  return value == null || !String(value).trim();
}
