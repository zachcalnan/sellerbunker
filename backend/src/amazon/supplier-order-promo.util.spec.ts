import { effectiveUnitCostIncVatForPromo } from './supplier-order-promo.util';

describe('effectiveUnitCostIncVatForPromo', () => {
  const rrp = 85.99;

  it('applies buy 3 get 1 free for qty divisible by 4', () => {
    expect(effectiveUnitCostIncVatForPromo(4, rrp, 'buy_3_get_1_free')).toBe(
      64.4925,
    );
    expect(effectiveUnitCostIncVatForPromo(8, rrp, 'buy_3_get_1_free')).toBe(
      64.4925,
    );
  });

  it('charges full RRP when fewer than 4 units', () => {
    expect(effectiveUnitCostIncVatForPromo(3, rrp, 'buy_3_get_1_free')).toBe(
      rrp,
    );
  });

  it('handles partial fourth bundle (qty 5)', () => {
    // 4 @ 3-for-4 + 1 full price → 4*rrp total / 5
    expect(effectiveUnitCostIncVatForPromo(5, rrp, 'buy_3_get_1_free')).toBe(
      68.792,
    );
  });

  it('returns RRP when promo is none', () => {
    expect(effectiveUnitCostIncVatForPromo(4, rrp, 'none')).toBe(rrp);
  });
});
