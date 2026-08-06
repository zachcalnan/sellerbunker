/**
 * Product Fees API (getMyFeesEstimate) FeeDetailList parsing.
 * Prefer FinalFee (post FeePromotion) so FBA promos do not scale down referral.
 */

export type ProductFeesEstimateBreakdown = {
  total: number | null;
  referralFee: number | null;
  fbaFee: number | null;
  digitalServiceFee: number | null;
};

function moneyToNum(m: unknown): number {
  if (m == null || typeof m !== 'object') return 0;
  const o = m as Record<string, unknown>;
  const a =
    o.Amount ??
    o.amount ??
    o.CurrencyAmount ??
    (typeof o.CurrencyAmount === 'object' && o.CurrencyAmount != null
      ? (o.CurrencyAmount as { Amount?: unknown }).Amount
      : null);
  if (typeof a === 'number' && Number.isFinite(a)) return a;
  if (typeof a === 'string') return parseFloat(a) || 0;
  return 0;
}

/** Post-promotion amount when present; otherwise FeeAmount. */
export function productFeesLeafAmount(item: Record<string, unknown>): number {
  const final =
    item.FinalFee ?? item.finalFee ?? null;
  if (final != null) {
    const n = moneyToNum(final);
    if (Number.isFinite(n)) return n;
  }
  return moneyToNum(item.FeeAmount ?? item.feeAmount);
}

/** Pre-promotion amount (FeeAmount). Used for FBA on ROI floors so promos are not banked on. */
export function productFeesLeafAmountPrePromo(item: Record<string, unknown>): number {
  const amount = item.FeeAmount ?? item.feeAmount ?? null;
  if (amount != null) {
    const n = moneyToNum(amount);
    if (Number.isFinite(n)) return n;
  }
  return productFeesLeafAmount(item);
}

function normType(t: unknown): string {
  return String(t ?? '').replace(/\s+/g, '').toUpperCase();
}

function isReferralType(t: string): boolean {
  return t === 'REFERRALFEE' || t.endsWith('REFERRALFEE');
}

function isDigitalType(t: string): boolean {
  return (
    t === 'VARIABLECLOSINGFEE' ||
    t === 'DIGITALSERVICEFEE' ||
    t.includes('DIGITALSERVICE')
  );
}

function isFbaLeafType(t: string): boolean {
  return t === 'FBAFEES' || t.startsWith('FBA');
}

/**
 * Parse referral / FBA / digital / total from a Product Fees estimate response.
 * Uses leaf FinalFee values so FeePromotion on FBA does not smear into referral via scaling.
 */
export function parseFeesEstimateBreakdown(res: unknown): ProductFeesEstimateBreakdown {
  const empty: ProductFeesEstimateBreakdown = {
    total: null,
    referralFee: null,
    fbaFee: null,
    digitalServiceFee: null,
  };
  const root = res as Record<string, unknown> | null;
  if (!root || typeof root !== 'object') return empty;
  const result =
    (root.payload as Record<string, unknown> | undefined)?.FeesEstimateResult ??
    root.FeesEstimateResult ??
    root;
  if (!result || typeof result !== 'object') return empty;
  const fees =
    (result as Record<string, unknown>).FeesEstimate ??
    (result as Record<string, unknown>).feesEstimate;
  if (!fees || typeof fees !== 'object') return empty;

  const feesObj = fees as Record<string, unknown>;
  const list = (feesObj.FeeDetailList ?? feesObj.feeDetailList) as unknown;

  let referralSum = 0;
  let fbaSum = 0;
  let digitalSum = 0;
  let otherLeafSum = 0;

  const visitFeeLeaves = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const raw of nodes) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const included = item.IncludedFeeDetailList ?? item.includedFeeDetailList;
      if (Array.isArray(included) && included.length > 0) {
        visitFeeLeaves(included);
        continue;
      }
      const feeType = normType(item.FeeType ?? item.feeType ?? '');
      const amount = productFeesLeafAmount(item);
      if (!Number.isFinite(amount)) continue;
      if (isReferralType(feeType)) referralSum += amount;
      else if (isDigitalType(feeType)) digitalSum += amount;
      else if (isFbaLeafType(feeType)) fbaSum += amount;
      else otherLeafSum += amount;
    }
  };

  if (Array.isArray(list) && list.length > 0) {
    visitFeeLeaves(list);
  }

  let authoritativeTotal: number | null = null;
  const totalEst = feesObj.TotalFeesEstimate ?? feesObj.totalFeesEstimate;
  if (totalEst != null) {
    const t = Math.abs(moneyToNum(totalEst));
    if (Number.isFinite(t) && t > 0) authoritativeTotal = t;
  }

  const leafPartsAbs =
    Math.abs(referralSum) + Math.abs(fbaSum) + Math.abs(digitalSum) + Math.abs(otherLeafSum);
  if (authoritativeTotal == null || authoritativeTotal < 1e-9) {
    if (leafPartsAbs > 0) authoritativeTotal = leafPartsAbs;
  }

  let refM = Math.abs(referralSum);
  let fbaM = Math.abs(fbaSum);
  let digM = Math.abs(digitalSum);
  let othM = Math.abs(otherLeafSum);
  const parts = refM + fbaM + digM + othM;

  // Only scale when leaves disagree with TotalFeesEstimate *and* we did not already use FinalFee
  // (FinalFee leaves should already sum ≈ total; scaling was the promo bug when FeeAmount was used).
  if (authoritativeTotal != null && parts > 1e-9) {
    const diff = Math.abs(authoritativeTotal - parts);
    if (diff > 0.05) {
      const scale = authoritativeTotal / parts;
      refM *= scale;
      fbaM *= scale;
      digM *= scale;
      othM *= scale;
    }
  }
  fbaM += othM;

  const totalMag =
    authoritativeTotal != null && Number.isFinite(authoritativeTotal) && authoritativeTotal > 0
      ? authoritativeTotal
      : parts > 0
        ? parts
        : null;

  return {
    total: totalMag,
    referralFee: refM > 1e-6 ? refM : null,
    fbaFee: fbaM > 1e-6 ? fbaM : null,
    digitalServiceFee: digM > 1e-6 ? digM : null,
  };
}

/**
 * Repricer min-ROI floor: keep true referral FinalFee, but use **pre-promo FBA FeeAmount**
 * ("add the other bits" back). Do not scale down to TotalFeesEstimate — that would wipe the promo.
 */
export function parseFeesEstimateBreakdownForRepricerFloor(
  res: unknown,
): ProductFeesEstimateBreakdown {
  const empty: ProductFeesEstimateBreakdown = {
    total: null,
    referralFee: null,
    fbaFee: null,
    digitalServiceFee: null,
  };
  const root = res as Record<string, unknown> | null;
  if (!root || typeof root !== 'object') return empty;
  const result =
    (root.payload as Record<string, unknown> | undefined)?.FeesEstimateResult ??
    root.FeesEstimateResult ??
    root;
  if (!result || typeof result !== 'object') return empty;
  const fees =
    (result as Record<string, unknown>).FeesEstimate ??
    (result as Record<string, unknown>).feesEstimate;
  if (!fees || typeof fees !== 'object') return empty;

  const feesObj = fees as Record<string, unknown>;
  const list = (feesObj.FeeDetailList ?? feesObj.feeDetailList) as unknown;

  let referralSum = 0;
  let fbaSum = 0;
  let digitalSum = 0;
  let otherLeafSum = 0;

  const visitFeeLeaves = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const raw of nodes) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const included = item.IncludedFeeDetailList ?? item.includedFeeDetailList;
      if (Array.isArray(included) && included.length > 0) {
        visitFeeLeaves(included);
        continue;
      }
      const feeType = normType(item.FeeType ?? item.feeType ?? '');
      if (isReferralType(feeType)) {
        const amount = productFeesLeafAmount(item);
        if (Number.isFinite(amount)) referralSum += amount;
      } else if (isDigitalType(feeType)) {
        const amount = productFeesLeafAmount(item);
        if (Number.isFinite(amount)) digitalSum += amount;
      } else if (isFbaLeafType(feeType)) {
        const amount = productFeesLeafAmountPrePromo(item);
        if (Number.isFinite(amount)) fbaSum += amount;
      } else {
        const amount = productFeesLeafAmountPrePromo(item);
        if (Number.isFinite(amount)) otherLeafSum += amount;
      }
    }
  };

  if (Array.isArray(list) && list.length > 0) {
    visitFeeLeaves(list);
  }

  const refM = Math.abs(referralSum);
  const fbaM = Math.abs(fbaSum) + Math.abs(otherLeafSum);
  const digM = Math.abs(digitalSum);
  const parts = refM + fbaM + digM;

  return {
    total: parts > 1e-9 ? parts : null,
    referralFee: refM > 1e-6 ? refM : null,
    fbaFee: fbaM > 1e-6 ? fbaM : null,
    digitalServiceFee: digM > 1e-6 ? digM : null,
  };
}

/** Listing price Amazon used for this estimate (PriceToEstimateFees). */
export function parseFeesEstimateListingPrice(res: unknown): number | null {
  const root = res as Record<string, unknown> | null;
  if (!root || typeof root !== 'object') return null;
  const result =
    (root.payload as Record<string, unknown> | undefined)?.FeesEstimateResult ??
    root.FeesEstimateResult ??
    root;
  if (!result || typeof result !== 'object') return null;
  const ident =
    (result as Record<string, unknown>).FeesEstimateIdentifier ??
    (result as Record<string, unknown>).feesEstimateIdentifier;
  if (!ident || typeof ident !== 'object') return null;
  const pp =
    (ident as Record<string, unknown>).PriceToEstimateFees ??
    (ident as Record<string, unknown>).priceToEstimateFees;
  if (!pp || typeof pp !== 'object') return null;
  const listing =
    (pp as Record<string, unknown>).ListingPrice ??
    (pp as Record<string, unknown>).listingPrice;
  const amt =
    listing != null && typeof listing === 'object'
      ? (listing as { Amount?: unknown; amount?: unknown }).Amount ??
        (listing as { amount?: unknown }).amount
      : null;
  const n = typeof amt === 'number' ? amt : typeof amt === 'string' ? parseFloat(amt) : null;
  return n != null && Number.isFinite(n) && n > 0 ? n : null;
}
