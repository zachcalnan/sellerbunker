/**
 * Dev helpers: unwrap SP-API Finances JSON and show **counts + money** next to structure
 * (empty `[]` arrays are obvious; real figures often live under `payload` / nested lists).
 */

const FINANCIAL_EVENTS_ARRAY_KEYS = [
  "ShipmentEventList",
  "ShipmentSettleEventList",
  "DeferredTransactionEventList",
  "RefundEventList",
  "GuaranteeClaimEventList",
  "ChargebackEventList",
  "PayWithAmazonEventList",
  "ServiceProviderCreditEventList",
  "RetrochargeEventList",
  "RentalTransactionEventList",
  "PerformanceBondRefundEventList",
  "ProductAdsPaymentEventList",
  "ServiceFeeEventList",
  "SellerDealPaymentEventList",
  "DebtRecoveryEventList",
  "LoanServicingEventList",
  "AffordabilityExpenseEventList",
  "AffordabilityExpenseReversalEventList",
  "CouponPaymentEventList",
  "CouponPaymentRefundEventList",
  "ImagingServicesFeeEventList",
  "NetworkComminglingTransactionEventList",
  "RemovalShipmentEventList",
  "TrialShipmentEventList",
  "FBALiquidationEventList",
  "AdjustmentEventList",
  "SAFETReimbursementEventList",
  "SellerReviewEnrollmentPaymentEventList",
  "FBACustomerReturnEventList",
  "CapacityReservationBillingEventList",
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Drill into `{ payload: { FinancialEvents } }`, `{ FinancialEvents }`, double payload, etc. */
export function findFinancialEventsObject(root: unknown): {
  path: string;
  events: Record<string, unknown>;
} | null {
  const visited = new WeakSet<object>();

  const walk = (node: unknown, path: string, depth: number): { path: string; events: Record<string, unknown> } | null => {
    if (depth > 18 || node == null) return null;
    if (typeof node !== "object") return null;
    if (visited.has(node as object)) return null;
    visited.add(node as object);

    if (isPlainObject(node)) {
      const hit = FINANCIAL_EVENTS_ARRAY_KEYS.filter((k) => k in node && Array.isArray((node as Record<string, unknown>)[k]));
      if (hit.length > 0) {
        return { path: path || "(root)", events: node as Record<string, unknown> };
      }
      for (const [k, v] of Object.entries(node)) {
        const next = path ? `${path}.${k}` : k;
        const found = walk(v, next, depth + 1);
        if (found) return found;
      }
    } else if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const found = walk(node[i], `${path}[${i}]`, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  const inner = unwrapDevFinancesResponse(root);
  return walk(inner, "financesResponse", 0);
}

/** Dev envelope: prefer posted-range payload filtered to this order when by-order id was empty. */
function unwrapDevFinancesResponse(root: unknown): unknown {
  if (!isPlainObject(root)) return root;
  const r = root as Record<string, unknown>;
  if (r.financesPostedRangeFilteredResponse != null) {
    return r.financesPostedRangeFilteredResponse;
  }
  const fr = r.financesResponse ?? r.FinancesResponse;
  if (fr !== undefined) return fr;
  return root;
}

function readAmountFromMoneyish(holder: unknown): { amount: number; currency: string } | null {
  if (!holder || typeof holder !== "object") return null;
  const h = holder as Record<string, unknown>;
  const inner =
    h.FeeAmount ??
    h.feeAmount ??
    h.ChargeAmount ??
    h.chargeAmount ??
    h.TaxAmount ??
    h.taxAmount ??
    h.Principal ??
    h.principal ??
    h.ShippingCharge ??
    h.shippingCharge;
  if (inner != null && typeof inner === "object") {
    const o = inner as Record<string, unknown>;
    const raw = o.CurrencyAmount ?? o.currencyAmount ?? o.Amount ?? o.amount;
    const n = Number(raw);
    const c = String(o.CurrencyCode ?? o.currencyCode ?? "");
    if (Number.isFinite(n) && Math.abs(n) > 1e-9) return { amount: n, currency: c };
  }
  if (h.CurrencyAmount != null && typeof h.CurrencyAmount !== "object") {
    const n = Number(h.CurrencyAmount);
    const c = String(h.CurrencyCode ?? h.currencyCode ?? "");
    if (Number.isFinite(n) && Math.abs(n) > 1e-9) return { amount: n, currency: c };
  }
  return null;
}

function typeLabel(o: Record<string, unknown>): string {
  const ft = o.FeeType ?? o.feeType ?? o.Type ?? o.type ?? o.ChargeType ?? o.chargeType;
  if (ft != null && ft !== "") return String(ft);
  const keys = Object.keys(o).slice(0, 4).join(",");
  return keys ? `(${keys})` : "(object)";
}

/**
 * One line per **non-zero** money leaf we can read (FeeAmount / ChargeAmount / Principal-style blocks).
 */
export function flattenFinancesMoneyLines(root: unknown, maxLines = 400): string[] {
  const out: string[] = [];
  const inner = unwrapDevFinancesResponse(root);

  const visit = (node: unknown, path: string, depth: number) => {
    if (out.length >= maxLines) return;
    if (depth > 22 || node == null) return;
    if (typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        visit(node[i], `${path}[${i}]`, depth + 1);
      }
      return;
    }

    const o = node as Record<string, unknown>;
    const money = readAmountFromMoneyish(o);
    const hasType =
      o.FeeType != null ||
      o.feeType != null ||
      o.ChargeType != null ||
      o.chargeType != null;

    if (money && (hasType || path.includes("FeeAmount") || path.includes("ChargeAmount") || path.includes("Principal"))) {
      const label = typeLabel(o);
      const cur = money.currency ? ` ${money.currency}` : "";
      out.push(`${money.amount.toFixed(2)}${cur}\t${label}\t${path}`);
    }

    for (const [k, v] of Object.entries(o)) {
      visit(v, path ? `${path}.${k}` : k, depth + 1);
    }
  };

  visit(inner, "financesResponse", 0);
  return out;
}

/** Human-readable: each FinancialEvents array → `Key: N items` (so `[]` shows as 0 items). */
export function summarizeFinancialEventArrays(root: unknown): string {
  const found = findFinancialEventsObject(root);
  if (!found) {
    return [
      "No `FinancialEvents`-shaped object found under financesResponse.",
      "Tip: expand JSON and search for `FinancialEvents`, `payload`, or `NextToken` — figures may be paginated.",
    ].join("\n");
  }
  const lines: string[] = [`FinancialEvents @ ${found.path}`, ""];
  for (const key of FINANCIAL_EVENTS_ARRAY_KEYS) {
    const v = found.events[key];
    if (Array.isArray(v)) {
      lines.push(`${key}: ${v.length} item(s)`);
    }
  }
  const known = new Set<string>([...FINANCIAL_EVENTS_ARRAY_KEYS]);
  const extraKeys = Object.keys(found.events).filter((k) => !known.has(k));
  if (extraKeys.length) {
    lines.push("");
    lines.push("Other keys on FinancialEvents:");
    for (const k of extraKeys.sort()) {
      const v = found.events[k];
      lines.push(
        `  ${k}: ${Array.isArray(v) ? `${v.length} item(s)` : typeof v}`,
      );
    }
  }
  return lines.join("\n");
}

function findNextTokenDeep(node: unknown, depth = 0): string | null {
  if (depth > 14 || node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const el of node) {
      const t = findNextTokenDeep(el, depth + 1);
      if (t) return t;
    }
    return null;
  }
  const o = node as Record<string, unknown>;
  const direct = o.NextToken ?? o.nextToken;
  if (typeof direct === "string" && direct.length > 0) return direct;
  for (const v of Object.values(o)) {
    const t = findNextTokenDeep(v, depth + 1);
    if (t) return t;
  }
  return null;
}

export function buildFinancesDebugSidebarText(root: unknown): string {
  const summary = summarizeFinancialEventArrays(root);
  const money = flattenFinancesMoneyLines(root, 500);
  const nt = findNextTokenDeep(unwrapDevFinancesResponse(root));
  const paginationHint = nt
    ? `\n\nNextToken (first in tree, truncated): ${nt.length > 48 ? `${nt.slice(0, 48)}…` : nt}\n→ Finances can be paginated; empty event lists + token means fetch next page for line-item fees.`
    : "";
  const moneyBlock =
    money.length > 0
      ? ["", "— Money lines (amount, label, JSON path) —", ...money].join("\n")
      : [
          "",
          "— Money lines —",
          "No FeeAmount/ChargeAmount/Principal-style amounts found in this tree.",
          "If every `*EventList` is 0 items and you still expected fees, check NextToken below and paginate the Finances call.",
        ].join("\n");
  return `${summary}${moneyBlock}${paginationHint}`;
}
