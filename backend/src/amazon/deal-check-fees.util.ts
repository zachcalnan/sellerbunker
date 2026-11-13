/**
 * Deal-check fee economics from Product Fees (getMyFeesEstimate) breakdown.
 * SP-API amounts are ex-VAT; SellerAmp-style UK RA P&L often needs:
 * - EU Digital Services Fee fallback (~2% of referral+FBA when API omits it)
 * - UK-style VAT on Amazon fees for non–VAT-registered sellers
 */

import { amountInclVatFromEx } from '../common/vat.util';

export type DealCheckFeePartsExVat = {
  referralFee: number | null;
  fbaFee: number | null;
  digitalServiceFee: number | null;
  /** Authoritative TotalFeesEstimate when present (ex-VAT). */
  totalFromApi?: number | null;
};

export type DealCheckFeeComposeInput = DealCheckFeePartsExVat & {
  /** Apply 2% DSF on referral+FBA when digital leaf is missing (UK/EU). Default true. */
  applyDigitalServiceFallback?: boolean;
  /** Gross up fees with VAT (non–VAT-registered / SellerAmp-style). Default false. */
  includeFeeVat?: boolean;
  vatRatePct?: number;
};

export type DealCheckFeeComposeResult = {
  feesTotal: number;
  referralFee: number;
  fbaFee: number;
  digitalServiceFee: number;
  feesIncludeVat: boolean;
  usedDigitalServiceFallback: boolean;
};

function mag(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0;
  return Math.abs(n);
}

/**
 * Build deal-check fee total + breakdown from Product Fees leaves (ex-VAT).
 */
export function composeDealCheckFees(
  input: DealCheckFeeComposeInput,
): DealCheckFeeComposeResult | null {
  let referral = mag(input.referralFee);
  let fba = mag(input.fbaFee);
  let digital = mag(input.digitalServiceFee);
  const apiTotal = mag(input.totalFromApi);

  // If leaves empty but API total exists, treat total as opaque rollup.
  if (referral < 1e-9 && fba < 1e-9 && digital < 1e-9) {
    if (apiTotal < 1e-9) return null;
    const includeVat = Boolean(input.includeFeeVat);
    const rate = input.vatRatePct ?? 20;
    const feesTotal = includeVat
      ? amountInclVatFromEx(apiTotal, rate)
      : Math.round(apiTotal * 100) / 100;
    return {
      feesTotal,
      referralFee: 0,
      fbaFee: 0,
      digitalServiceFee: 0,
      feesIncludeVat: includeVat,
      usedDigitalServiceFallback: false,
    };
  }

  let usedDigitalServiceFallback = false;
  const applyDsf = input.applyDigitalServiceFallback !== false;
  if (applyDsf && digital < 1e-9 && (referral > 1e-9 || fba > 1e-9)) {
    // Only add fallback when API total is missing or matches ref+fba (DSF not already in total).
    // Keep the tolerance tight so we do not double-count when TotalFeesEstimate already includes DSF
    // but the digital leaf failed to parse.
    const withoutDig = referral + fba;
    const totalLooksLikeWithoutDig =
      apiTotal < 1e-9 || Math.abs(apiTotal - withoutDig) <= 0.05;
    if (totalLooksLikeWithoutDig) {
      digital = Math.round(withoutDig * 0.02 * 100) / 100;
      usedDigitalServiceFallback = digital > 1e-9;
    }
  }

  let feesEx = Math.round((referral + fba + digital) * 100) / 100;
  // Prefer the larger of component sum vs API total when both present (avoid dropping leaves).
  if (apiTotal > feesEx + 0.05) {
    feesEx = Math.round(apiTotal * 100) / 100;
  }

  const includeVat = Boolean(input.includeFeeVat);
  if (!includeVat) {
    return {
      feesTotal: feesEx,
      referralFee: Math.round(referral * 100) / 100,
      fbaFee: Math.round(fba * 100) / 100,
      digitalServiceFee: Math.round(digital * 100) / 100,
      feesIncludeVat: false,
      usedDigitalServiceFallback,
    };
  }

  const rate = input.vatRatePct ?? 20;
  const referralInc = amountInclVatFromEx(referral, rate);
  const fbaInc = amountInclVatFromEx(fba, rate);
  const digitalInc = amountInclVatFromEx(digital, rate);
  const fromParts = Math.round((referralInc + fbaInc + digitalInc) * 100) / 100;
  // If we only had an opaque API total bump, gross that up too.
  const fromApiInc =
    apiTotal > 1e-9 ? amountInclVatFromEx(apiTotal, rate) : 0;
  const feesTotal = Math.max(fromParts, fromApiInc);

  return {
    feesTotal,
    referralFee: referralInc,
    fbaFee: fbaInc,
    digitalServiceFee: digitalInc,
    feesIncludeVat: true,
    usedDigitalServiceFallback,
  };
}

/** UK / EU marketplaces where Digital Services Fee applies. */
export function marketplaceUsesDigitalServiceFee(
  marketplaceId: string | null | undefined,
): boolean {
  const id = String(marketplaceId ?? '').trim();
  // UK + major EU
  return (
    id === 'A1F83G8C2ARO7P' || // UK
    id === 'A1PA6795UKMFR9' || // DE
    id === 'A13V1IB3VIYZZH' || // FR
    id === 'APJ6JRA9NG5V4' || // IT
    id === 'A1RKKUPIHCS9HS' || // ES
    id === 'A1805IZSGTT6HS' || // NL
    id === 'A2NODRKZP88ZB9' || // SE
    id === 'A1C3SOZRARQ6R3' // PL
  );
}
