import {
  estimateInStockDaysForVelocity,
  inclusiveUtcDaySpan,
} from './replenish-velocity.util';

describe('replenish-velocity.util', () => {
  const windowStart = new Date('2026-05-01T00:00:00.000Z');
  const now = new Date('2026-05-30T12:00:00.000Z');

  it('uses in-stock span not full calendar window when sales cluster at end', () => {
    const orderDates = Array.from({ length: 10 }, (_, i) =>
      new Date(Date.UTC(2026, 4, 21 + i, 15, 0, 0)),
    );
    const inStockDays = estimateInStockDaysForVelocity({
      unitsSold: 20,
      orderDates,
      windowDays: 30,
      windowStart,
      effectiveStock: 5,
      now,
    });
    expect(inStockDays).toBe(10);
    expect(20 / inStockDays).toBe(2);
  });

  it('uses first-to-last sale span when currently out of stock', () => {
    const orderDates = [
      new Date('2026-05-05T10:00:00.000Z'),
      new Date('2026-05-25T10:00:00.000Z'),
    ];
    const inStockDays = estimateInStockDaysForVelocity({
      unitsSold: 6,
      orderDates,
      windowDays: 30,
      windowStart,
      effectiveStock: 0,
      now,
    });
    expect(inStockDays).toBe(inclusiveUtcDaySpan(orderDates[0]!, orderDates[1]!));
  });
});
