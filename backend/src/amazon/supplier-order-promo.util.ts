/** Retail promo types supported when ingesting supplier orders. */
export type SupplierPromoType = 'none' | 'buy_3_get_1_free';

/**
 * Effective per-unit buy price (inc VAT) after a retail promo.
 *
 * `buy_3_get_1_free` — for every 4 units, pay for 3 (Healf 4FOR3).
 * Example: qty=4, RRP £85.99 → £64.49/unit.
 */
export function effectiveUnitCostIncVatForPromo(
  qty: number,
  unitRrpIncVat: number,
  promo: SupplierPromoType,
): number {
  const q = Math.max(0, Math.floor(qty));
  const rrp = Math.max(0, unitRrpIncVat);
  if (q === 0 || rrp === 0) return 0;

  if (promo === 'buy_3_get_1_free') {
    const groups = Math.floor(q / 4);
    const remainder = q % 4;
    const paidUnits = groups * 3 + Math.min(remainder, 3);
    const totalPaid = paidUnits * rrp;
    return Number((totalPaid / q).toFixed(4));
  }

  return rrp;
}
