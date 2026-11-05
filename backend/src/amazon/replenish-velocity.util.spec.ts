import {
  avgDailyUnitsInStock,
  resolveInStockDaysForVelocity,
} from './replenish-velocity.util';

describe('replenish-velocity.util', () => {
  it('uses observed Amazon available days when coverage is enough', () => {
    // 1 unit sold over 5 days available → 0.2/day
    const inStockDays = resolveInStockDaysForVelocity({
      windowDays: 30,
      observedDays: 30,
      observedInStockDays: 5,
    });
    expect(inStockDays).toBe(5);
    expect(avgDailyUnitsInStock(1, inStockDays, 0)).toBeCloseTo(0.2);
  });

  it('falls back to full window when snapshot history is thin', () => {
    const inStockDays = resolveInStockDaysForVelocity({
      windowDays: 30,
      observedDays: 2,
      observedInStockDays: 1,
    });
    expect(inStockDays).toBe(30);
    expect(avgDailyUnitsInStock(1, inStockDays, 0)).toBeCloseTo(1 / 30);
  });

  it('falls back to full window when no snapshots', () => {
    expect(
      resolveInStockDaysForVelocity({
        windowDays: 30,
        observedDays: null,
        observedInStockDays: null,
      }),
    ).toBe(30);
  });

  it('does not inflate a single sale to 1 unit/day without availability history', () => {
    // Old sale-span heuristic would have returned 1 day → demand 1/day.
    const inStockDays = resolveInStockDaysForVelocity({
      windowDays: 30,
      observedDays: null,
      observedInStockDays: null,
    });
    expect(avgDailyUnitsInStock(1, inStockDays, 0)).toBeCloseTo(1 / 30);
  });
});
