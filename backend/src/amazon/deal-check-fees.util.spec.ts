import {
  composeDealCheckFees,
  marketplaceUsesDigitalServiceFee,
} from './deal-check-fees.util';

describe('deal-check-fees.util', () => {
  it('marks UK/EU marketplaces for DSF', () => {
    expect(marketplaceUsesDigitalServiceFee('A1F83G8C2ARO7P')).toBe(true);
    expect(marketplaceUsesDigitalServiceFee('ATVPDKIKX0DER')).toBe(false);
  });

  it('adds EU DSF fallback when digital leaf missing and API total ≈ ref+fba', () => {
    // Mirrors under-count that produced ~£38.38 vs SellerAmp ~£47.61
    const ex = composeDealCheckFees({
      referralFee: 31.8,
      fbaFee: 6.58,
      digitalServiceFee: null,
      totalFromApi: 38.38,
      applyDigitalServiceFallback: true,
      includeFeeVat: false,
    });
    expect(ex).not.toBeNull();
    expect(ex!.usedDigitalServiceFallback).toBe(true);
    expect(ex!.digitalServiceFee).toBeCloseTo(0.77, 2);
    expect(ex!.feesTotal).toBeCloseTo(39.15, 2);
  });

  it('grosses up UK fee VAT for non–VAT-registered style P&L', () => {
    const inc = composeDealCheckFees({
      referralFee: 31.8,
      fbaFee: 6.58,
      digitalServiceFee: null,
      totalFromApi: 38.38,
      applyDigitalServiceFallback: true,
      includeFeeVat: true,
      vatRatePct: 20,
    });
    expect(inc).not.toBeNull();
    // (31.8+6.58)*1.02 ≈ 39.15 → ×1.2 ≈ 46.98 (SellerAmp ~47.61 at £212.22)
    expect(inc!.feesTotal).toBeCloseTo(46.98, 1);
    expect(inc!.feesIncludeVat).toBe(true);
    expect(inc!.referralFee).toBeCloseTo(38.16, 2);
    expect(inc!.fbaFee).toBeCloseTo(7.9, 2);
    expect(inc!.digitalServiceFee).toBeCloseTo(0.92, 2);
  });

  it('does not double-add DSF when digital already present', () => {
    const r = composeDealCheckFees({
      referralFee: 30,
      fbaFee: 8,
      digitalServiceFee: 0.76,
      totalFromApi: 38.76,
      applyDigitalServiceFallback: true,
      includeFeeVat: false,
    });
    expect(r!.usedDigitalServiceFallback).toBe(false);
    expect(r!.digitalServiceFee).toBeCloseTo(0.76, 2);
    expect(r!.feesTotal).toBeCloseTo(38.76, 2);
  });

  it('SellerAmp-style deal math: sale − cost − fees ≈ profit', () => {
    const fees = composeDealCheckFees({
      referralFee: 31.8,
      fbaFee: 6.58,
      digitalServiceFee: null,
      totalFromApi: 38.38,
      applyDigitalServiceFallback: true,
      includeFeeVat: true,
      vatRatePct: 20,
    })!;
    const sale = 212;
    const cost = 143;
    const profit = Math.round((sale - cost - fees.feesTotal) * 100) / 100;
    const roi = profit / cost;
    // Closer to SellerAmp £21.28 / 14.84% than old £30.62 / 21.4%
    expect(profit).toBeLessThan(25);
    expect(profit).toBeGreaterThan(18);
    expect(roi).toBeLessThan(0.16);
    expect(roi).toBeGreaterThan(0.12);
  });

  it('returns null when no fee parts', () => {
    expect(
      composeDealCheckFees({
        referralFee: null,
        fbaFee: null,
        digitalServiceFee: null,
        totalFromApi: null,
      }),
    ).toBeNull();
  });
});
