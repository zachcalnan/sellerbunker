/**
 * Rows Amazon sometimes puts on `ItemFeeList` that are **sale proceeds / pass-through**, not seller fees.
 * If we sum their amounts into "fees", the total blows up to ~order revenue (~£59 fee on a £59 sale).
 */
function isExcludedNonSellerFeeFinancesType(feeType: string): boolean {
  const t = (feeType || '').toLowerCase();
  if (!t) return false;
  if (t.includes('principal')) return true;
  // `MarketplaceFacilitator*` rows on `ItemFeeList` are mostly pass-through (shipping VAT, promos, etc.)
  // and are NOT the Seller Central “commission + digital + FBA” lines (those use Commission / CommissionTax,
  // DigitalServicesFee / …Tax, FBA / FulfillmentFeeTax). **Drop every facilitator line except** explicit
  // commission/referral-side facilitator VAT (e.g. `MarketplaceFacilitatorTax-Commission`).
  if (t.includes('marketplacefacilitator')) {
    if (t.includes('commission') || t.includes('referral')) return false;
    return true;
  }
  if (t.includes('giftwrap')) return true;
  if (t.includes('goodwill')) return true;
  if (t.includes('debt')) return true;
  // Buyer shipping / shipping tax on the sale — not Amazon referral/FBA/digital.
  if (t === 'shippingcharge' || t.endsWith('shippingcharge')) return true;
  if (t === 'shippingtax' || t.endsWith('shippingtax')) return true;
  if (t === 'shippingdiscount' || t.includes('shippingdiscount')) return true;
  return false;
}

function readFinancesRowFeeAmount(obj: any): number {
  if (!obj) return 0;
  const a = obj?.FeeAmount ?? obj?.feeAmount ?? obj;
  const n =
    a?.CurrencyAmount ??
    a?.currencyAmount ??
    a?.Amount ??
    a?.amount ??
    (typeof a === 'number' ? a : null);
  const num = Number(n);
  return Number.isNaN(num) ? 0 : num;
}

/**
 * Amazon’s “normal” commission VAT leaf (`CommissionTax`, `ReferralFeeTax`, `…VAT…` on commission, etc.)
 * on the same shipment as `MarketplaceFacilitatorTax-Commission` / `MarketplaceFacilitatorVAT-Commission`
 * means the facilitator row is a **second copy** of that VAT
 * (~£1.8 double-count → referral looks ~£12.57 instead of ~£10.80 on a UK FBA line).
 */
function isExplicitCommissionSideAmazonTaxFeeType(feeType: string): boolean {
  const t = (feeType || '').toLowerCase();
  if (!t || t.includes('marketplacefacilitator')) return false;
  if (t.includes('fulfillment') || t.includes('fba')) return false;
  if (t.includes('digital')) return false;
  if (t.includes('shipping') && !t.includes('commission') && !t.includes('referral')) return false;
  if (t.includes('commissiontax') || t.endsWith('commissiontax')) return true;
  if (t.includes('referralfeetax') || t.endsWith('referralfeetax')) return true;
  if (t.includes('referral') && (t.includes('tax') || t.includes('vat'))) return true;
  if (t.includes('commission') && (t.includes('tax') || t.includes('vat'))) return true;
  return false;
}

/** Facilitator row that duplicates commission VAT already expressed as `CommissionTax` / `…VAT…` leaves. */
function isOmittableMarketplaceFacilitatorCommissionVatDupRow(feeTypeLower: string): boolean {
  const t = feeTypeLower;
  return (
    t.includes('marketplacefacilitator') &&
    (t.includes('tax') || t.includes('vat')) &&
    (t.includes('commission') || t.includes('referral'))
  );
}

function financesFeeListsContainExplicitCommissionTax(
  lists: ReadonlyArray<any[] | undefined>,
): boolean {
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const fc of list) {
      const feeType = (fc?.FeeType ?? fc?.feeType ?? fc?.Type ?? '') as string;
      const rawComponents =
        fc?.FeeComponent ?? fc?.feeComponent ?? fc?.FeeDetailList ?? fc?.feeDetailList;
      const components = Array.isArray(rawComponents)
        ? rawComponents
        : rawComponents && typeof rawComponents === 'object'
          ? [rawComponents]
          : [];
      if (components.length > 0) {
        for (const comp of components) {
          const ct = (comp?.FeeType ?? comp?.feeType ?? comp?.Type ?? '') as string;
          if (isExcludedNonSellerFeeFinancesType(ct)) continue;
          const ca = readFinancesRowFeeAmount(comp);
          if (Math.abs(ca) > 1e-9 && isExplicitCommissionSideAmazonTaxFeeType(ct)) return true;
        }
      } else {
        if (isExcludedNonSellerFeeFinancesType(feeType)) continue;
        const amt = readFinancesRowFeeAmount(fc);
        if (Math.abs(amt) > 1e-9 && isExplicitCommissionSideAmazonTaxFeeType(feeType)) return true;
      }
    }
  }
  return false;
}

export type ParseFinancesItemFeeListOptions = {
  /** When true, drop `MarketplaceFacilitatorTax-Commission`-style rows (VAT already in `CommissionTax`). */
  omitMarketplaceFacilitatorCommissionTaxDup?: boolean;
};

/**
 * Finances API `ItemFeeList` / `ItemFeeAdjustmentList`: Amazon often sends a **parent** `FeeAmount`
 * (e.g. commission inc. VAT) **and** `FeeComponent` / `FeeDetailList` leaves (base + VAT). Summing both
 * double-counts (~20% on UK referral). When any nested components exist, sum **only** those leaves;
 * otherwise use the top-level row.
 */
export function parseFinancesItemFeeListBreakdown(
  list: any[] | undefined,
  options?: ParseFinancesItemFeeListOptions,
): {
  referral: number;
  fba: number;
  digital: number;
} {
  const out = { referral: 0, fba: 0, digital: 0 };
  const readAmt = readFinancesRowFeeAmount;
  const addFee = (feeType: string, amt: number) => {
    if (amt === 0) return;
    if (isExcludedNonSellerFeeFinancesType(feeType)) return;
    const t = (feeType || '').toLowerCase();
    if (options?.omitMarketplaceFacilitatorCommissionTaxDup && isOmittableMarketplaceFacilitatorCommissionVatDupRow(t)) {
      return;
    }
    if (t === 'referralfee' || t.includes('referral') || t === 'commission') out.referral += amt;
    else if (t === 'fbafees' || t.startsWith('fba') || t.includes('fulfillment')) out.fba += amt;
    else if (t === 'variableclosingfee' || t === 'digitalservicefee' || t.includes('digital'))
      out.digital += amt;
    // Commission-side VAT (incl. MarketplaceFacilitatorTax-**Commission**). Do **not** use bare
    // `facilitator` — that matched shipping facilitator rows before `isExcluded` caught all spellings.
    else if (
      t.includes('tax') &&
      (t.includes('commission') || t.includes('referral'))
    ) {
      out.referral += amt;
    } else if (
      t.includes('tax') &&
      t.includes('facilitator') &&
      !t.includes('shipping') &&
      !t.includes('shippingcharge') &&
      !t.endsWith('shippingtax') &&
      !t.includes('shippingtax')
    ) {
      out.referral += amt;
    } else if (t.includes('tax') && (t.includes('fulfillment') || t.includes('fba'))) {
      out.fba += amt;
    } else if (t.includes('tax') && t.includes('digital')) {
      out.digital += amt;
    }
  };
  if (!Array.isArray(list)) return out;
  for (const fc of list) {
    const feeType = (fc?.FeeType ?? fc?.feeType ?? fc?.Type ?? '') as string;
    const rawComponents =
      fc?.FeeComponent ?? fc?.feeComponent ?? fc?.FeeDetailList ?? fc?.feeDetailList;
    const components = Array.isArray(rawComponents)
      ? rawComponents
      : rawComponents && typeof rawComponents === 'object'
        ? [rawComponents]
        : [];
    if (components.length > 0) {
      for (const comp of components) {
        const ct = (comp?.FeeType ?? comp?.feeType ?? comp?.Type ?? '') as string;
        if (isExcludedNonSellerFeeFinancesType(ct)) continue;
        const ca = readAmt(comp);
        if (ca !== 0) addFee(ct, ca);
      }
      continue;
    }
    if (isExcludedNonSellerFeeFinancesType(feeType)) continue;
    const amt = readAmt(fc);
    if (amt !== 0) addFee(feeType, amt);
  }
  return out;
}

/**
 * Signed total for one `ItemFeeList` / `ItemFeeAdjustmentList`-shaped array (fee rows only).
 * Same parent-vs-leaf rule as {@link parseFinancesItemFeeListBreakdown}.
 */
export function parseFinancesItemFeeListSignedTotal(
  list: any[] | undefined,
  options?: ParseFinancesItemFeeListOptions,
): number {
  const readAmt = readFinancesRowFeeAmount;
  if (!Array.isArray(list)) return 0;
  let sum = 0;
  for (const fc of list) {
    const feeType = (fc?.FeeType ?? fc?.feeType ?? fc?.Type ?? '') as string;
    const rawComponents =
      fc?.FeeComponent ?? fc?.feeComponent ?? fc?.FeeDetailList ?? fc?.feeDetailList;
    const components = Array.isArray(rawComponents)
      ? rawComponents
      : rawComponents && typeof rawComponents === 'object'
        ? [rawComponents]
        : [];
    if (components.length > 0) {
      for (const comp of components) {
        const ct = (comp?.FeeType ?? comp?.feeType ?? comp?.Type ?? '') as string;
        if (isExcludedNonSellerFeeFinancesType(ct)) continue;
        const t = ct.toLowerCase();
        if (options?.omitMarketplaceFacilitatorCommissionTaxDup && isOmittableMarketplaceFacilitatorCommissionVatDupRow(t)) {
          continue;
        }
        sum += readAmt(comp);
      }
      continue;
    }
    if (isExcludedNonSellerFeeFinancesType(feeType)) continue;
    const tl = feeType.toLowerCase();
    if (options?.omitMarketplaceFacilitatorCommissionTaxDup && isOmittableMarketplaceFacilitatorCommissionVatDupRow(tl)) {
      continue;
    }
    sum += readAmt(fc);
  }
  return sum;
}

/**
 * Referral / FBA / digital buckets for one shipment line (`ItemFeeList` + `ItemFeeAdjustmentList`),
 * with facilitator commission VAT de-duped when `CommissionTax` (or equivalent) is already present.
 */
export function parseFinancesShipmentItemFeesBreakdown(si: any): {
  referral: number;
  fba: number;
  digital: number;
} {
  if (!si) return { referral: 0, fba: 0, digital: 0 };
  const l1 = si?.ItemFeeList ?? si?.itemFeeList;
  const l2 = si?.ItemFeeAdjustmentList ?? si?.itemFeeAdjustmentList;
  const opts: ParseFinancesItemFeeListOptions | undefined = financesFeeListsContainExplicitCommissionTax([
    l1,
    l2,
  ])
    ? { omitMarketplaceFacilitatorCommissionTaxDup: true }
    : undefined;
  const b1 = parseFinancesItemFeeListBreakdown(l1, opts);
  const b2 = parseFinancesItemFeeListBreakdown(l2, opts);
  let referral = b1.referral + b2.referral;
  const fba = b1.fba + b2.fba;
  const digital = b1.digital + b2.digital;
  const signed = parseFinancesShipmentItemFeesSignedTotal(si);
  const sumBd = referral + fba + digital;
  const drift = signed - sumBd;
  // Bucket sum can still exceed the signed line total when Amazon uses fee-type spellings we do not map
  // into Ref/FBA/Dig (drops) or duplicate VAT in referral only. Snap referral so components match `signed`.
  if (Math.abs(signed) > 1e-6 && Math.abs(drift) > 0.05 && Math.abs(drift) < 4.5) {
    referral += drift;
  }
  return { referral, fba, digital };
}

/**
 * Per shipment line item: **Amazon seller fees only** (`ItemFeeList` + `ItemFeeAdjustmentList`).
 * Do not sum `ItemChargeList` here — it carries Principal / shipping / tax **charges**, not marketplace
 * fees; mixing them produced totals near order revenue (~£60 “fees” on a ~£60 sale).
 */
export function parseFinancesShipmentItemFeesSignedTotal(si: any): number {
  if (!si) return 0;
  const l1 = si?.ItemFeeList ?? si?.itemFeeList;
  const l2 = si?.ItemFeeAdjustmentList ?? si?.itemFeeAdjustmentList;
  const opts: ParseFinancesItemFeeListOptions | undefined = financesFeeListsContainExplicitCommissionTax([
    l1,
    l2,
  ])
    ? { omitMarketplaceFacilitatorCommissionTaxDup: true }
    : undefined;
  return (
    parseFinancesItemFeeListSignedTotal(l1, opts) + parseFinancesItemFeeListSignedTotal(l2, opts)
  );
}
