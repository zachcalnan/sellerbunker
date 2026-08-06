import {
  parseFeesEstimateBreakdown,
  parseFeesEstimateBreakdownForRepricerFloor,
  parseFeesEstimateListingPrice,
  productFeesLeafAmount,
} from './product-fees-estimate-parse.util';

/** Coffee-machine style: large FBA FeePromotion; FinalFee total ≈ TotalFeesEstimate. */
const coffeeMachinePromoFixture = {
  payload: {
    FeesEstimateResult: {
      FeesEstimateIdentifier: {
        PriceToEstimateFees: { ListingPrice: { Amount: 80.83, CurrencyCode: 'GBP' } },
      },
      FeesEstimate: {
        TimeOfFeesEstimation: '2026-08-06T10:46:08.000Z',
        TotalFeesEstimate: { Amount: 12.16, CurrencyCode: 'GBP' },
        FeeDetailList: [
          {
            FeeType: 'ReferralFee',
            FeeAmount: { Amount: 12.12, CurrencyCode: 'GBP' },
            FinalFee: { Amount: 12.12, CurrencyCode: 'GBP' },
            FeePromotion: { Amount: 0, CurrencyCode: 'GBP' },
          },
          {
            FeeType: 'VariableClosingFee',
            FeeAmount: { Amount: 0, CurrencyCode: 'GBP' },
            FinalFee: { Amount: 0, CurrencyCode: 'GBP' },
          },
          {
            FeeType: 'PerItemFee',
            FeeAmount: { Amount: 0, CurrencyCode: 'GBP' },
            FinalFee: { Amount: 0, CurrencyCode: 'GBP' },
          },
          {
            FeeType: 'FBAFees',
            FeeAmount: { Amount: 5.48, CurrencyCode: 'GBP' },
            FinalFee: { Amount: 0.04, CurrencyCode: 'GBP' },
            FeePromotion: { Amount: 5.44, CurrencyCode: 'GBP' },
            IncludedFeeDetailList: [
              {
                FeeType: 'FBAPickAndPack',
                FeeAmount: { Amount: 5.48, CurrencyCode: 'GBP' },
                FinalFee: { Amount: 0.04, CurrencyCode: 'GBP' },
                FeePromotion: { Amount: 5.44, CurrencyCode: 'GBP' },
              },
            ],
          },
        ],
      },
    },
  },
};

describe('product-fees-estimate-parse.util', () => {
  it('prefers FinalFee so FBA promos do not scale down referral', () => {
    const b = parseFeesEstimateBreakdown(coffeeMachinePromoFixture);
    expect(b.total).toBeCloseTo(12.16, 2);
    expect(b.referralFee).toBeCloseTo(12.12, 2);
    expect(b.fbaFee).toBeCloseTo(0.04, 2);
    // Must NOT be the old scaled ~8.37 / ~3.79 smear.
    expect(b.referralFee!).toBeGreaterThan(11);
    expect(b.fbaFee!).toBeLessThan(1);
  });

  it('repricer floor adds back pre-promo FBA (FeeAmount)', () => {
    const b = parseFeesEstimateBreakdownForRepricerFloor(coffeeMachinePromoFixture);
    expect(b.referralFee).toBeCloseTo(12.12, 2);
    expect(b.fbaFee).toBeCloseTo(5.48, 2);
    expect(b.total).toBeCloseTo(17.6, 1);
  });

  it('reads listing price used for the estimate', () => {
    expect(parseFeesEstimateListingPrice(coffeeMachinePromoFixture)).toBeCloseTo(80.83, 2);
  });

  it('productFeesLeafAmount uses FinalFee over FeeAmount', () => {
    expect(
      productFeesLeafAmount({
        FeeAmount: { Amount: 5.48 },
        FinalFee: { Amount: 0.04 },
      }),
    ).toBeCloseTo(0.04, 2);
  });
});
