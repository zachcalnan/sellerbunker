import {
  correctStaleStoredLineRevenue,
  lineRevenueFromOrderTotalSplit,
  parseOrderItemLineRevenueFromRaw,
  parseOrderItemPromotionDiscountFromRaw,
} from './order-item-revenue-parse.util';

describe('order-item-revenue-parse.util', () => {
  it('subtracts promotion discount from ItemPrice (Seller Central item subtotal)', () => {
    const raw = {
      QuantityOrdered: 1,
      ItemPrice: { Amount: '150.00', CurrencyCode: 'GBP' },
      PromotionDiscount: { Amount: '22.00', CurrencyCode: 'GBP' },
    };
    expect(parseOrderItemPromotionDiscountFromRaw(raw)).toBe(22);
    expect(parseOrderItemLineRevenueFromRaw(raw)).toBe(128);
  });

  it('returns ItemPrice when no promotion', () => {
    const raw = {
      QuantityOrdered: 1,
      ItemPrice: { Amount: '128.00', CurrencyCode: 'GBP' },
    };
    expect(parseOrderItemLineRevenueFromRaw(raw)).toBe(128);
  });

  it('splits order total by line quantity', () => {
    expect(lineRevenueFromOrderTotalSplit(1, 128.66, 1)).toBe(128.66);
    expect(lineRevenueFromOrderTotalSplit(2, 100, 4)).toBe(50);
  });

  it('replaces stale list-price guess with shipped order total when line ItemPrice missing', () => {
    expect(
      correctStaleStoredLineRevenue({
        storedRevenueTotal: 150.53,
        lineRevenueFromRaw: 0,
        lineRevenueFromOrderSplit: 128.66,
        orderStillPending: false,
      }),
    ).toBe(128.66);
  });

  it('keeps list-price placeholder while order still pending', () => {
    expect(
      correctStaleStoredLineRevenue({
        storedRevenueTotal: 150.53,
        lineRevenueFromRaw: 0,
        lineRevenueFromOrderSplit: 128.66,
        orderStillPending: true,
      }),
    ).toBe(150.53);
  });

  it('prefers ItemPrice minus promo over stale stored revenue', () => {
    const raw = {
      QuantityOrdered: 1,
      ItemPrice: { Amount: '150.00', CurrencyCode: 'GBP' },
      PromotionDiscount: { Amount: '21.34', CurrencyCode: 'GBP' },
    };
    expect(
      correctStaleStoredLineRevenue({
        storedRevenueTotal: 150,
        lineRevenueFromRaw: parseOrderItemLineRevenueFromRaw(raw),
        lineRevenueFromOrderSplit: 128.66,
        orderStillPending: false,
      }),
    ).toBe(128.66);
  });

  it('does not subtract shipping discounts from item subtotal', () => {
    const raw = {
      QuantityOrdered: 1,
      ItemPrice: { Amount: '100.00', CurrencyCode: 'GBP' },
      ShippingDiscount: { Amount: '5.00', CurrencyCode: 'GBP' },
    };
    expect(parseOrderItemLineRevenueFromRaw(raw)).toBe(100);
  });
});
