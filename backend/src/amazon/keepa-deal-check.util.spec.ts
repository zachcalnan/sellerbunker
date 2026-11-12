import {
  DECEMBER_BLEND_WEIGHT,
  DECEMBER_MIN_SAMPLE_DAYS,
  blendWithDecember,
  computeDealCheckEconomics,
  computeDealCheckPriceStats,
  dailyForwardFillPrices,
  keepaMinutesToUnixMs,
  keepaRawToMajor,
  marketplaceIdToKeepaDomain,
  parseKeepaCsvPriceSeries,
  percentileNearest,
  roundDealTarget,
  unixMsToKeepaMinutes,
} from './keepa-deal-check.util';

describe('keepa-deal-check.util', () => {
  it('maps UK marketplace to Keepa domain 2 and pence→pounds', () => {
    expect(marketplaceIdToKeepaDomain('A1F83G8C2ARO7P')).toBe(2);
    expect(keepaRawToMajor(7900, 2)).toBe(79);
    expect(roundDealTarget(78.6, 2)).toBe(79);
  });

  it('parses csv and forward-fills daily samples', () => {
    const now = Date.UTC(2026, 0, 31, 12, 0, 0);
    const t0 = unixMsToKeepaMinutes(Date.UTC(2026, 0, 1, 12, 0, 0));
    const t1 = unixMsToKeepaMinutes(Date.UTC(2026, 0, 15, 12, 0, 0));
    const t2 = unixMsToKeepaMinutes(Date.UTC(2026, 0, 25, 12, 0, 0));
    const series = parseKeepaCsvPriceSeries(
      [t0, 5000, t1, 7000, t2, 9000, t2 + 10, -1],
      2,
    );
    expect(series.map((s) => s.price)).toEqual([50, 70, 90]);
    const daily = dailyForwardFillPrices(series, { lookbackDays: 30, nowMs: now });
    expect(daily.length).toBeGreaterThan(20);
    expect(daily[daily.length - 1]).toBe(90);
    expect(daily.some((p) => p === 50)).toBe(true);
    expect(daily.some((p) => p === 70)).toBe(true);
  });

  it('computes good/best targets and probability from NEW history', () => {
    const now = Date.UTC(2026, 5, 1, 12, 0, 0);
    // 100 days: 75 days at £50, 25 days at £80 → 75th pct near £80
    const points: number[] = [];
    for (let d = 0; d < 100; d++) {
      const day = Date.UTC(2026, 1, 22, 12, 0, 0) + d * 86_400_000;
      const price = d < 75 ? 5000 : 8000;
      points.push(unixMsToKeepaMinutes(day), price);
    }
    const csv: unknown[] = [];
    csv[0] = null; // amazon unused
    csv[1] = points;
    const stats = computeDealCheckPriceStats({
      csv,
      domainId: 2,
      lookbackDays: 120,
      nowMs: now,
    });
    expect(stats.source).toBe('keepa_new');
    expect(stats.goodResalePrice).toBeGreaterThanOrEqual(50);
    expect(stats.bestCaseResalePrice).toBeGreaterThanOrEqual(stats.goodResalePrice!);
    expect(stats.probabilityPct).not.toBeNull();
    expect(stats.sampleDays).toBeGreaterThan(50);
  });

  it('prefers NEW_FBA when enough samples exist', () => {
    const now = Date.UTC(2026, 2, 1);
    const t = unixMsToKeepaMinutes(Date.UTC(2026, 1, 1));
    const csv: unknown[] = [];
    csv[1] = [t, 4000, t + 1000, 4100, t + 2000, 4200];
    csv[10] = [t, 7900, t + 1000, 8000, t + 2000, 8100];
    const stats = computeDealCheckPriceStats({
      csv,
      domainId: 2,
      lookbackDays: 60,
      nowMs: now,
    });
    expect(stats.source).toBe('keepa_new_fba');
    expect(stats.goodResalePrice).toBeGreaterThanOrEqual(79);
  });

  it('economics: £49 buy / £79 sell / fees → ROI gate', () => {
    const e = computeDealCheckEconomics({
      buyPrice: 49,
      resalePrice: 79,
      feesPerUnit: 18,
    });
    expect(e.profitPerUnit).toBe(12);
    expect(e.roi).toBeCloseTo(12 / 49, 3);
    expect(e.meetsRoiGate).toBe(e.roi >= 0.15);
  });

  it('percentileNearest edges', () => {
    expect(percentileNearest([1, 2, 3, 4], 0)).toBe(1);
    expect(percentileNearest([1, 2, 3, 4], 1)).toBe(4);
    expect(percentileNearest([], 0.5)).toBeNull();
  });

  it('keepa time round-trip roughly', () => {
    const ms = Date.UTC(2024, 0, 1);
    const mins = unixMsToKeepaMinutes(ms);
    expect(Math.abs(keepaMinutesToUnixMs(mins) - ms)).toBeLessThan(60_000);
  });

  it('blendWithDecember weights toward December band', () => {
    expect(
      blendWithDecember({ allBand: 100, decemberBand: 200, weight: 0.4 }),
    ).toBeCloseTo(140, 5);
    expect(
      blendWithDecember({ allBand: 100, decemberBand: null, weight: 0.4 }),
    ).toBe(100);
    expect(DECEMBER_BLEND_WEIGHT).toBe(0.4);
    expect(DECEMBER_MIN_SAMPLE_DAYS).toBe(7);
  });

  it('blends good/best toward December percentiles when enough Dec days', () => {
    // Mid-year check with 365d window: rest of year cheap, December expensive.
    const now = Date.UTC(2026, 5, 15, 12, 0, 0); // 15 Jun 2026
    const points: number[] = [];
    // Non-December: £100 for most of the year (from Jul 2025)
    for (let d = 0; d < 340; d++) {
      const day = Date.UTC(2025, 6, 15, 12, 0, 0) + d * 86_400_000;
      if (new Date(day).getUTCMonth() === 11) continue;
      points.push(unixMsToKeepaMinutes(day), 10000);
    }
    // December 2025: £200 for 20 days
    for (let d = 1; d <= 20; d++) {
      const day = Date.UTC(2025, 11, d, 12, 0, 0);
      points.push(unixMsToKeepaMinutes(day), 20000);
    }
    const csv: unknown[] = [];
    csv[1] = points;
    const stats = computeDealCheckPriceStats({
      csv,
      domainId: 2,
      lookbackDays: 365,
      nowMs: now,
    });
    expect(stats.decemberSampleDays).toBeGreaterThanOrEqual(
      DECEMBER_MIN_SAMPLE_DAYS,
    );
    expect(stats.decemberWeight).toBe(DECEMBER_BLEND_WEIGHT);
    expect(stats.decemberGoodResalePrice).toBe(200);
    // All-year 75th is near £100; Dec 75th £200 → blend ≈ 140 → rounds to 140
    expect(stats.goodResalePrice).toBe(140);
    expect(stats.bestCaseResalePrice).toBe(140);
  });

  it('does not blend December when fewer than min Dec sample days', () => {
    // History starts Dec 28 with only 4 Dec days before year-end (< min 7).
    const now = Date.UTC(2026, 0, 10, 12, 0, 0); // 10 Jan 2026
    const points: number[] = [];
    for (let d = 28; d <= 31; d++) {
      points.push(unixMsToKeepaMinutes(Date.UTC(2025, 11, d, 12, 0, 0)), 25000);
    }
    for (let d = 1; d <= 10; d++) {
      points.push(unixMsToKeepaMinutes(Date.UTC(2026, 0, d, 12, 0, 0)), 10000);
    }
    const csv: unknown[] = [];
    csv[1] = points;
    const stats = computeDealCheckPriceStats({
      csv,
      domainId: 2,
      lookbackDays: 30,
      nowMs: now,
    });
    expect(stats.decemberSampleDays).toBeLessThan(DECEMBER_MIN_SAMPLE_DAYS);
    expect(stats.decemberSampleDays).toBeGreaterThan(0);
    expect(stats.decemberWeight).toBe(0);
    expect(stats.decemberGoodResalePrice).toBeNull();
    // No blend: good band is plain all-year percentile (not pulled toward Dec-only).
    const plain = computeDealCheckPriceStats({
      csv,
      domainId: 2,
      lookbackDays: 30,
      nowMs: now,
      decemberWeight: 0,
    });
    expect(stats.goodResalePrice).toBe(plain.goodResalePrice);
    expect(stats.bestCaseResalePrice).toBe(plain.bestCaseResalePrice);
  });
});
