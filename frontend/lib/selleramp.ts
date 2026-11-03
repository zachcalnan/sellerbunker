/** SellerAmp SAS (Sourcing Analysis Simplified) lookup URL for an ASIN or search term. */
export function sellerAmpSasLookupUrl(searchTerm: string): string {
  const term = searchTerm.trim();
  return `https://sas.selleramp.com/sas/lookup?search_term=${encodeURIComponent(term)}`;
}
