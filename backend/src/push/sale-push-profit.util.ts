/** Share of revenue used when a fee figure is missing or larger than a real Amazon fee. */
const FALLBACK_FEE_RATE = 0.35;
/** Fees above this share of the sale are the sale amount counted as a fee, not a real charge. */
const MAX_FEE_RATIO = 0.5;

export type SalePushProfitInput = {
  /** Order total in pounds. */
  amount: number;
  quantity?: number | null;
  /** Per-unit cost. Sign is ignored. */
  costPerUnit?: number | null;
  /** Per-unit Amazon fee estimate. Sign is ignored. */
  feePerUnit?: number | null;
  /** Order-level Finances fee total. Negative means a charge, which is the stored convention. */
  signedFeesTotal?: number | null;
  tax?: number | null;
  /** Profit already computed for the order. Ignored when it is just the sale price inverted. */
  computedProfit?: number | null;
};

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function gbp(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `£${abs}`;
}

function resolveFeeMagnitude(args: {
  revenue: number;
  qty: number;
  cogs: number | null;
  tax: number;
  feePerUnit: number | null;
  signedFeesTotal: number | null;
  computed: number | null;
}): number {
  const { revenue, qty, cogs, tax, feePerUnit, signedFeesTotal, computed } = args;
  if (signedFeesTotal != null && signedFeesTotal !== 0) {
    const mag = Math.abs(signedFeesTotal);
    if (revenue <= 0 || mag <= revenue * MAX_FEE_RATIO) return mag;
  }
  if (feePerUnit != null) {
    const mag = Math.abs(feePerUnit) * qty;
    if (mag > 0 && (revenue <= 0 || mag <= revenue * MAX_FEE_RATIO)) return mag;
  }
  if (computed != null && cogs != null && revenue > 0) {
    const inferred = revenue - tax - cogs - computed;
    if (inferred > 0 && inferred <= revenue * MAX_FEE_RATIO) return inferred;
  }
  if (revenue > 0 && cogs != null) return round2(revenue * FALLBACK_FEE_RATE);
  return 0;
}

/**
 * Label for a new-sale push. Profit is the hero, and only when it is money made.
 * A fee recorded as the whole sale (so profit comes out as −£64.99) is not shown.
 */
export function buildSalePushLabel(input: SalePushProfitInput): string {
  const revenue = Math.max(0, num(input.amount) ?? 0);
  const qty = Math.max(1, num(input.quantity) ?? 1);
  const tax = Math.max(0, num(input.tax) ?? 0);
  const costPer = num(input.costPerUnit);
  const cogs = costPer != null ? Math.abs(costPer) * qty : null;
  const computed = num(input.computedProfit);

  const feeMag = resolveFeeMagnitude({
    revenue,
    qty,
    cogs,
    tax,
    feePerUnit: num(input.feePerUnit),
    signedFeesTotal: num(input.signedFeesTotal),
    computed,
  });

  let profit: number | null = null;
  if (revenue > 0 && cogs != null) {
    const rebuilt = round2(revenue - tax - cogs - feeMag);
    const maxSane = round2(Math.max(0, revenue - tax - cogs));
    if (computed != null && computed > 0.004 && computed <= maxSane + 0.02) {
      profit = round2(computed);
    } else if (rebuilt > 0.004) {
      profit = rebuilt;
    }
  } else if (
    computed != null &&
    computed > 0.004 &&
    (revenue <= 0 || computed < revenue)
  ) {
    profit = round2(computed);
  }

  if (profit != null && profit > 0.004) return `${gbp(profit)} profit`;
  if (revenue > 0) return `${gbp(revenue)} sale`;
  return 'New sale';
}

const SALE_PUSH_TICK = '\u2705'; // ✅ — keep explicit so payloads can't silently drop emoji
const SALE_PUSH_TIMES = '\u00d7'; // ×
const SALE_PUSH_EM_DASH = '\u2014'; // —

/**
 * Title + body for sale / test pushes. iOS lock-screen banners often show only
 * the title, so the full line (qty × product — ✅ £…) lives there once.
 * Body stays empty so the lock screen does not repeat the £ amount.
 */
export function buildSalePushTexts(opts: {
  profitLabel: string;
  /** Product / test name (optional). */
  shortTitle?: string | null;
  /** Units sold; defaults to 1. */
  quantity?: number | null;
}): { title: string; body: string; profitLabel: string } {
  const raw = String(opts.profitLabel ?? '').trim() || 'New sale';
  const profitLabel = raw.replace(/^(?:\u2705|🟢)\s*/u, '').trim() || 'New sale';
  const qtyRaw = num(opts.quantity);
  const qty = Math.max(1, Math.floor(qtyRaw != null && qtyRaw > 0 ? qtyRaw : 1));
  const product = String(opts.shortTitle ?? '').trim() || 'item';
  const title = `Sold: ${qty} ${SALE_PUSH_TIMES} ${product} ${SALE_PUSH_EM_DASH} ${SALE_PUSH_TICK} ${profitLabel}`;
  const body = '';
  return { title, body, profitLabel };
}
