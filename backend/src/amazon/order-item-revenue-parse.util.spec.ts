import {
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

  it('does not subtract shipping discounts from item subtotal', () => {
    const raw = {
      QuantityOrdered: 1,
      ItemPrice: { Amount: '100.00', CurrencyCode: 'GBP' },
      ShippingDiscount: { Amount: '5.00', CurrencyCode: 'GBP' },
    };
    expect(parseOrderItemLineRevenueFromRaw(raw)).toBe(100);
  });
});
