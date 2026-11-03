import {
  buildFinderConfidence,
  computeFinderEconomics,
  passesFinderGates,
  scoreTitleSimilarity,
  tokenizeFinderText,
} from './product-finder.util';

describe('product-finder.util', () => {
  it('tokenizes and scores OneSkin titles', () => {
    expect(tokenizeFinderText('OneSkin OS-01 EYE 20ml').includes('oneskin')).toBe(
      true,
    );
    const s = scoreTitleSimilarity(
      'OneSkin OS-01 EYE Topical Supplement',
      'oneskin OS-01 BODY Peptide Moisturizer',
    );
    expect(s).toBeGreaterThan(5);
    const stronger = scoreTitleSimilarity(
      'OneSkin OS-01 EYE',
      'OneSkin OS-01 EYE Topical Supplement 20ml',
    );
    expect(stronger).toBeGreaterThan(s);
  });

  it('computes profit and ROI with fee estimate', () => {
    const e = computeFinderEconomics({
      resalePrice: 123,
      feesPerUnit: 25,
      buyPrice: 71.24,
    });
    expect(e.profitPerUnit).toBe(26.76);
    expect(e.usedFeeFallback).toBe(false);
    expect(e.roi).toBeCloseTo(26.76 / 71.24, 2);
  });

  it('uses fee fallback with flag', () => {
    const e = computeFinderEconomics({
      resalePrice: 100,
      feesPerUnit: null,
      buyPrice: 40,
      feeFallbackRate: 0.35,
    });
    expect(e.feesPerUnit).toBe(35);
    expect(e.usedFeeFallback).toBe(true);
    expect(e.profitPerUnit).toBe(25);
  });

  it('builds high confidence when ungated + fees + sales + profit gate', () => {
    const c = buildFinderConfidence({
      similarScore: 25,
      ungated: true,
      eligibilityAgeHours: 24,
      hasFeeEstimate: true,
      usedFeeFallback: false,
      hasBuyPrice: true,
      unitsSold30d: 12,
      unitsSold90d: 30,
      historicalAvgProfit: 18,
      meetsProfitGate: true,
    });
    expect(c.level).toBe('high');
    expect(c.score).toBeGreaterThanOrEqual(70);
  });

  it('fails gated products when requireUngated', () => {
    expect(
      passesFinderGates({
        requireUngated: true,
        ungated: false,
        minProfitPerUnit: 5,
        minRoi: 0.2,
        profitPerUnit: 20,
        roi: 0.5,
      }),
    ).toBe(false);
  });
});
