/** Currency for Listings PATCH from marketplace id (SP-API region defaults). */
export function marketplaceIdToListingCurrency(marketplaceId: string): string {
  const map: Record<string, string> = {
    A1F83G8C2ARO7P: 'GBP',
    A1PA6795UKMFR9: 'EUR',
    A13V1IB3VIYZZH: 'EUR',
    APJ6JRA9NG5V4: 'EUR',
    A1RKKUPIHCS9HS: 'EUR',
    A28R8C7NBKEWEA: 'EUR',
    A1805IZSGTT6HS: 'EUR',
    AMEN7PMS3EDWL: 'EUR',
    A2NODRKZP88ZB9: 'SEK',
    A1C3SOZRARQ6R3: 'PLN',
    ATVPDKIKX0DER: 'USD',
    A2EUQ1WTGCTBG2: 'CAD',
    A1AM78C64UM0Y8: 'MXN',
    A2Q3Y263D00KWC: 'BRL',
    A1VC38T7YXB528: 'JPY',
    A19VAU5U5O7RUS: 'SGD',
    A39IBJ37TRP1C6: 'AUD',
  };
  return map[marketplaceId] ?? 'USD';
}

export function isListingsGetRetryableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const is404 = msg.includes('(404)') && msg.includes('/listings/');
  const isTooManyMids =
    msg.includes('(400)') &&
    (msg.includes('marketplaceIds') || msg.includes('Too many'));
  return is404 || isTooManyMids;
}

/** Parse marketplace + productType + currency from getListingsItem for patchListingsItem. */
export function parseListingPatchMetaFromGetListingsItem(
  res: unknown,
  fallbackMarketplaceId: string,
  fallbackProductType?: string | null,
): { marketplaceId: string; productType: string; currency: string } | null {
  const payload = (res as any)?.payload ?? res;
  if (!payload || typeof payload !== 'object') return null;
  const summaries = (payload as any).summaries ?? (payload as any).Summaries;
  let productType: string | null = null;
  let marketplaceId = fallbackMarketplaceId;
  if (Array.isArray(summaries) && summaries.length > 0) {
    for (const s of summaries) {
      const mid = s?.marketplaceId ?? s?.marketplace_id;
      const midStr = typeof mid === 'string' && mid.trim() ? mid.trim() : null;
      if (midStr && midStr !== marketplaceId && productType) continue;
      const pt = s?.productType ?? s?.product_type;
      if (typeof pt === 'string' && pt.trim()) {
        productType = pt.trim();
        if (midStr) marketplaceId = midStr;
        break;
      }
      if (midStr && !productType) marketplaceId = midStr;
    }
    if (!productType) {
      const s = summaries[0];
      const pt = s?.productType ?? s?.product_type;
      if (typeof pt === 'string' && pt.trim()) productType = pt.trim();
      const mid = s?.marketplaceId ?? s?.marketplace_id;
      if (typeof mid === 'string' && mid.trim()) marketplaceId = mid.trim();
    }
  }
  if (!productType) {
    const rootPt = (payload as any).productType ?? (payload as any).product_type;
    if (typeof rootPt === 'string' && rootPt.trim()) productType = rootPt.trim();
  }
  if (!productType) {
    const attrs = (payload as any).attributes ?? (payload as any).Attributes;
    if (attrs && typeof attrs === 'object') {
      const keys = ['product_type', 'productType', 'item_type_keyword', 'item_type_name'];
      for (const key of keys) {
        const node = (attrs as any)[key];
        const raw = Array.isArray(node) ? node[0] : node;
        const v = raw?.value ?? raw?.type ?? (typeof raw === 'string' ? raw : null);
        if (typeof v === 'string' && v.trim()) {
          productType = v.trim();
          break;
        }
      }
    }
  }
  const offers = (payload as any).offers ?? (payload as any).Offers;
  const hasOffers = Array.isArray(offers) && offers.length > 0;
  const hasSummaries = Array.isArray(summaries) && summaries.length > 0;
  if (!productType && typeof fallbackProductType === 'string' && fallbackProductType.trim()) {
    if (hasOffers || hasSummaries || (payload as any).sku || (payload as any).SKU) {
      productType = fallbackProductType.trim();
    }
  }
  if (!productType) return null;

  let currency = marketplaceIdToListingCurrency(marketplaceId);
  if (Array.isArray(offers) && offers.length > 0) {
    const price = offers[0]?.price ?? offers[0]?.Price;
    const cur =
      price?.currency ?? price?.CurrencyCode ?? price?.currencyCode ?? price?.Currency;
    if (typeof cur === 'string' && cur.length === 3) currency = cur.toUpperCase();
  }
  return { marketplaceId, productType, currency };
}
