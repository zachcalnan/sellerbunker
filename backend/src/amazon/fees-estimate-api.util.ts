/**
 * Parse SP-API Product Fees (getMyFeesEstimateForASIN / getMyFeesEstimates)
 * into a stable per-item shape for the API-key fees-estimate route.
 *
 * This is intentionally separate from AmazonService.parseFeesEstimateBreakdown,
 * which buckets uncategorized leaves into FBA for stored product estimates.
 * Here we keep other fee lines distinct so deal scoring can see the split.
 */

export type FeesEstimateFulfilment = 'FBA' | 'FBM';

export type FeesEstimateFeeLine = {
  type: string;
  amount: number;
};

export type FeesEstimateItemResult = {
  asin: string;
  price: number;
  fulfilment: FeesEstimateFulfilment;
  currency: string;
  referralFee: number | null;
  fbaFee: number | null;
  digitalServiceFee: number | null;
  otherFees: number | null;
  feeLines: FeesEstimateFeeLine[];
  total: number | null;
  error: string | null;
};

export type FeesEstimateRequestItem = {
  asin: string;
  price: number;
  fulfilment: FeesEstimateFulfilment;
  identifier: string;
  currency: string;
};

function moneyToNum(m: unknown): number {
  if (m == null) return 0;
  if (typeof m === 'number' && Number.isFinite(m)) return m;
  if (typeof m === 'string') return parseFloat(m) || 0;
  if (typeof m !== 'object') return 0;
  const obj = m as Record<string, unknown>;
  const a =
    obj.Amount ??
    obj.amount ??
    obj.CurrencyAmount ??
    (typeof obj.CurrencyAmount === 'object' && obj.CurrencyAmount != null
      ? (obj.CurrencyAmount as Record<string, unknown>).Amount
      : null);
  if (typeof a === 'number' && Number.isFinite(a)) return a;
  if (typeof a === 'string') return parseFloat(a) || 0;
  return 0;
}

function moneyCurrency(m: unknown): string | null {
  if (m == null || typeof m !== 'object') return null;
  const obj = m as Record<string, unknown>;
  const code = obj.CurrencyCode ?? obj.currencyCode ?? obj.Currency;
  if (typeof code === 'string' && code.trim()) return code.trim().toUpperCase();
  return null;
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

function visitFeeLeaves(
  nodes: unknown,
  visit: (type: string, amount: number, rawType: string) => void,
): void {
  if (!Array.isArray(nodes)) return;
  for (const item of nodes) {
    if (item == null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const included = row.IncludedFeeDetailList ?? row.includedFeeDetailList;
    if (Array.isArray(included) && included.length > 0) {
      visitFeeLeaves(included, visit);
      continue;
    }
    const rawType = String(row.FeeType ?? row.feeType ?? 'Unknown');
    const amount = moneyToNum(row.FinalFee ?? row.finalFee ?? row.FeeAmount ?? row.feeAmount);
    if (!Number.isFinite(amount)) continue;
    visit(normType(rawType), amount, rawType);
  }
}

function resultErrorMessage(result: Record<string, unknown>): string | null {
  const status = String(result.Status ?? result.status ?? '').trim();
  const err = (result.Error ?? result.error) as Record<string, unknown> | undefined;
  const errMsg =
    err && typeof err === 'object'
      ? String(err.Message ?? err.message ?? err.Code ?? err.code ?? '').trim()
      : '';
  if (status && status.toUpperCase() !== 'SUCCESS') {
    return errMsg || `Fee estimate status: ${status}`;
  }
  if (errMsg) return errMsg;
  return null;
}

function identifierFromResult(result: Record<string, unknown>): {
  identifier: string | null;
  asin: string | null;
} {
  const ident =
    (result.FeesEstimateIdentifier as Record<string, unknown> | undefined) ??
    (result.feesEstimateIdentifier as Record<string, unknown> | undefined) ??
    {};
  const identifier = ident.Identifier ?? ident.identifier ?? result.IdValue ?? result.idValue;
  const idType = String(ident.IdType ?? ident.idType ?? result.IdType ?? result.idType ?? '');
  const idValue = ident.IdValue ?? ident.idValue ?? result.IdValue ?? result.idValue;
  const asin =
    idType.toUpperCase() === 'ASIN' && typeof idValue === 'string'
      ? idValue
      : typeof idValue === 'string' && /^[A-Z0-9]{10}$/i.test(idValue)
        ? idValue
        : null;
  return {
    identifier: typeof identifier === 'string' && identifier.trim() ? identifier.trim() : null,
    asin: asin ? String(asin).toUpperCase() : null,
  };
}

/** Pull the list of FeesEstimateResult objects from a batch or single-ASIN response. */
export function extractFeesEstimateResultList(res: unknown): Record<string, unknown>[] {
  if (res == null) return [];
  if (Array.isArray(res)) {
    return res.filter((x) => x != null && typeof x === 'object') as Record<string, unknown>[];
  }
  if (typeof res !== 'object') return [];
  const r = res as Record<string, unknown>;
  const payload = r.payload;
  if (Array.isArray(payload)) {
    return payload.filter((x) => x != null && typeof x === 'object') as Record<string, unknown>[];
  }
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    const list = p.FeesEstimateResultList ?? p.feesEstimateResultList;
    if (Array.isArray(list)) {
      return list.filter((x) => x != null && typeof x === 'object') as Record<string, unknown>[];
    }
    if (p.FeesEstimateResult && typeof p.FeesEstimateResult === 'object') {
      return [p.FeesEstimateResult as Record<string, unknown>];
    }
    if (p.feesEstimateResult && typeof p.feesEstimateResult === 'object') {
      return [p.feesEstimateResult as Record<string, unknown>];
    }
  }
  const list = r.FeesEstimateResultList ?? r.feesEstimateResultList;
  if (Array.isArray(list)) {
    return list.filter((x) => x != null && typeof x === 'object') as Record<string, unknown>[];
  }
  if (r.FeesEstimateResult && typeof r.FeesEstimateResult === 'object') {
    return [r.FeesEstimateResult as Record<string, unknown>];
  }
  if (r.FeesEstimate && typeof r.FeesEstimate === 'object') {
    return [r];
  }
  return [];
}

export function parseFeesEstimateResult(
  result: Record<string, unknown>,
  fallback: { currency: string },
): {
  currency: string;
  referralFee: number | null;
  fbaFee: number | null;
  digitalServiceFee: number | null;
  otherFees: number | null;
  feeLines: FeesEstimateFeeLine[];
  total: number | null;
  error: string | null;
} {
  const error = resultErrorMessage(result);
  const feesRaw = result.FeesEstimate ?? result.feesEstimate;
  const fees =
    feesRaw && typeof feesRaw === 'object' ? (feesRaw as Record<string, unknown>) : null;

  const feeLines: FeesEstimateFeeLine[] = [];
  let referralSum = 0;
  let fbaSum = 0;
  let digitalSum = 0;
  let otherSum = 0;
  let currency = fallback.currency;

  if (fees) {
    const totalEst = fees.TotalFeesEstimate ?? fees.totalFeesEstimate;
    const c = moneyCurrency(totalEst);
    if (c) currency = c;
    visitFeeLeaves(fees.FeeDetailList ?? fees.feeDetailList, (type, amount, rawType) => {
      feeLines.push({ type: rawType, amount });
      if (isReferralType(type)) referralSum += amount;
      else if (isDigitalType(type)) digitalSum += amount;
      else if (isFbaLeafType(type)) fbaSum += amount;
      else otherSum += amount;
    });
  }

  let total: number | null = null;
  if (fees) {
    const totalEst = fees.TotalFeesEstimate ?? fees.totalFeesEstimate;
    if (totalEst != null) {
      const t = Math.abs(moneyToNum(totalEst));
      if (Number.isFinite(t) && t > 0) total = t;
    }
  }
  const leafSum =
    Math.abs(referralSum) + Math.abs(fbaSum) + Math.abs(digitalSum) + Math.abs(otherSum);
  if (total == null && leafSum > 0) total = leafSum;

  const toNull = (n: number): number | null =>
    Number.isFinite(n) && Math.abs(n) > 1e-9 ? Math.abs(Math.round(n * 100) / 100) : null;

  return {
    currency,
    referralFee: toNull(referralSum),
    fbaFee: toNull(fbaSum),
    digitalServiceFee: toNull(digitalSum),
    otherFees: toNull(otherSum),
    feeLines: feeLines.map((l) => ({
      type: l.type,
      amount: Math.round(l.amount * 100) / 100,
    })),
    total: total != null ? Math.round(total * 100) / 100 : null,
    error,
  };
}

function emptyItem(
  item: FeesEstimateRequestItem,
  error: string | null,
): FeesEstimateItemResult {
  return {
    asin: item.asin,
    price: item.price,
    fulfilment: item.fulfilment,
    currency: item.currency,
    referralFee: null,
    fbaFee: null,
    digitalServiceFee: null,
    otherFees: null,
    feeLines: [],
    total: null,
    error,
  };
}

/**
 * Map a getMyFeesEstimates (or single-ASIN) response onto the request items.
 * Unmatched items get a per-item error; the whole call still succeeds.
 */
export function mapGetMyFeesEstimatesResponse(opts: {
  raw: unknown;
  items: FeesEstimateRequestItem[];
}): FeesEstimateItemResult[] {
  const results = extractFeesEstimateResultList(opts.raw);
  const used = new Set<number>();

  const takeResult = (item: FeesEstimateRequestItem): Record<string, unknown> | null => {
    const ident = item.identifier;
    const asin = item.asin.toUpperCase();
    for (let i = 0; i < results.length; i++) {
      if (used.has(i)) continue;
      const ids = identifierFromResult(results[i]);
      if (ident && ids.identifier && ids.identifier === ident) {
        used.add(i);
        return results[i];
      }
    }
    for (let i = 0; i < results.length; i++) {
      if (used.has(i)) continue;
      const ids = identifierFromResult(results[i]);
      if (ids.asin && ids.asin === asin) {
        used.add(i);
        return results[i];
      }
    }
    return null;
  };

  return opts.items.map((item) => {
    const result = takeResult(item);
    if (!result) {
      return emptyItem(item, 'No fee estimate returned for this ASIN');
    }
    const parsed = parseFeesEstimateResult(result, { currency: item.currency });
    if (parsed.error && parsed.total == null && parsed.feeLines.length === 0) {
      return emptyItem(item, parsed.error);
    }
    return {
      asin: item.asin,
      price: item.price,
      fulfilment: item.fulfilment,
      currency: parsed.currency || item.currency,
      referralFee: parsed.referralFee,
      fbaFee: parsed.fbaFee,
      digitalServiceFee: parsed.digitalServiceFee,
      otherFees: parsed.otherFees,
      feeLines: parsed.feeLines,
      total: parsed.total,
      error: parsed.error,
    };
  });
}

export function feesEstimateItemsFromCaughtError(
  items: FeesEstimateRequestItem[],
  message: string,
): FeesEstimateItemResult[] {
  return items.map((item) => emptyItem(item, message));
}
