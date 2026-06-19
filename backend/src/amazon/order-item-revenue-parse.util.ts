/** SP-API money object → number (Amount / CurrencyAmount). */
export function parseMoneyAmountFromMoneyLike(obj: unknown): number {
  if (obj == null) return 0;
  if (typeof obj === 'number' && Number.isFinite(obj)) return obj;
  if (typeof obj !== 'object') return 0;
  const o = obj as Record<string, unknown>;
  const raw =
    o.Amount ??
    o.amount ??
    o.CurrencyAmount ??
    o.currencyAmount ??
    (typeof o.toString === 'function' ? o.toString() : null);
  if (raw == null || raw === '') return 0;
  const n = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
  return Number.isNaN(n) ? 0 : n;
}

/** Item-level promotion discounts (positive magnitudes in Orders API). Excludes shipping discounts. */
export function parseOrderItemPromotionDiscountFromRaw(it: unknown): number {
  if (it == null || typeof it !== 'object') return 0;
  const row = it as Record<string, unknown>;
  const readAmt = (obj: unknown): number => {
    const n = parseMoneyAmountFromMoneyLike(obj);
    return n !== 0 ? Math.abs(n) : 0;
  };
  return (
    readAmt(row.PromotionDiscount ?? row.promotionDiscount) +
    readAmt(row.PromotionDiscountTax ?? row.promotionDiscountTax)
  );
}

function parseOrderItemItemPriceAmount(it: Record<string, unknown>): number {
  const ip = it.ItemPrice ?? it.itemPrice;
  if (ip == null) return 0;
  return parseMoneyAmountFromMoneyLike(ip);
}

/**
 * Line item subtotal from getOrderItems payload — matches Seller Central item subtotal:
 * ItemPrice minus promotions (not list price, not OrderTotal with shipping).
 */
export function parseOrderItemLineRevenueFromRaw(it: unknown): number {
  if (it == null || typeof it !== 'object') return 0;
  const row = it as Record<string, unknown>;

  let gross = parseOrderItemItemPriceAmount(row);
  if (gross <= 0) {
    const ip = row.ItemPrice ?? row.itemPrice;
    const unitPrice =
      ip != null && typeof ip === 'object'
        ? (ip as Record<string, unknown>).unitPrice ??
          (ip as Record<string, unknown>).UnitPrice
        : null;
    if (unitPrice != null) {
      const up = parseMoneyAmountFromMoneyLike(unitPrice);
      const qty = Number(row.QuantityOrdered ?? row.quantityOrdered ?? 0);
      const quantityOrdered = qty > 0 ? qty : 1;
      if (up > 0) gross = Number((up * quantityOrdered).toFixed(2));
    }
  }

  if (gross <= 0) {
    const lists = [
      ...(Array.isArray(row.ItemChargeList) ? row.ItemChargeList : []),
      ...(Array.isArray(row.itemChargeList) ? row.itemChargeList : []),
    ];
    let principal = 0;
    for (const ch of lists) {
      if (ch == null || typeof ch !== 'object') continue;
      const c = ch as Record<string, unknown>;
      const ct = String(c.ChargeType ?? c.chargeType ?? '').toLowerCase();
      if (!ct.includes('principal')) continue;
      principal += parseMoneyAmountFromMoneyLike(c.ChargeAmount ?? c.chargeAmount);
    }
    if (principal > 0) return Number(principal.toFixed(2));
    return 0;
  }

  const promo = parseOrderItemPromotionDiscountFromRaw(row);
  const net = gross - promo;
  if (net > 0) return Number(net.toFixed(2));
  return gross > 0 ? Number(gross.toFixed(2)) : 0;
}

/** Gross ItemPrice before promotions (for detecting stale DB rows). */
export function parseOrderItemGrossItemPriceFromRaw(it: unknown): number {
  if (it == null || typeof it !== 'object') return 0;
  const row = it as Record<string, unknown>;
  const gross = parseOrderItemItemPriceAmount(row);
  if (gross > 0) return gross;
  const ip = row.ItemPrice ?? row.itemPrice;
  const unitPrice =
    ip != null && typeof ip === 'object'
      ? (ip as Record<string, unknown>).unitPrice ??
        (ip as Record<string, unknown>).UnitPrice
      : null;
  if (unitPrice != null) {
    const up = parseMoneyAmountFromMoneyLike(unitPrice);
    const qty = Number(row.QuantityOrdered ?? row.quantityOrdered ?? 0);
    const quantityOrdered = qty > 0 ? qty : 1;
    if (up > 0) return Number((up * quantityOrdered).toFixed(2));
  }
  return 0;
}
