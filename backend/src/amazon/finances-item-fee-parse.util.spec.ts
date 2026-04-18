import {
  GOLDEN_UK_SANDISK_EXPECTED_BREAKDOWN,
  GOLDEN_UK_SANDISK_EXPECTED_SIGNED_TOTAL,
  GOLDEN_UK_SANDISK_ITEM_FEE_LIST,
} from './amazon-fees-golden.fixtures';
import {
  parseFinancesItemFeeListBreakdown,
  parseFinancesItemFeeListSignedTotal,
  parseFinancesShipmentItemFeesBreakdown,
  parseFinancesShipmentItemFeesSignedTotal,
} from './finances-item-fee-parse.util';

describe('finances-item-fee-parse.util', () => {
  it('uses leaf rows only when FeeComponent exists (no parent+VAT double count)', () => {
    const itemFeeList = [
      {
        FeeType: 'Commission',
        FeeAmount: { CurrencyAmount: -10.8 },
        FeeComponent: [
          { FeeType: 'Commission', FeeAmount: { CurrencyAmount: -9 } },
          {
            FeeType: 'CommissionTax',
            FeeAmount: { CurrencyAmount: -1.8 },
          },
        ],
      },
      {
        FeeType: 'DigitalServicesFee',
        FeeAmount: { CurrencyAmount: -0.22 },
        FeeComponent: [
          { FeeType: 'DigitalServicesFee', FeeAmount: { CurrencyAmount: -0.22 } },
          { FeeType: 'DigitalServicesTax', FeeAmount: { CurrencyAmount: -0.04 } },
        ],
      },
      {
        FeeType: 'FBAPerUnitFulfillmentFee',
        FeeAmount: { CurrencyAmount: -2.23 },
        FeeComponent: [
          { FeeType: 'FBAPerUnitFulfillmentFee', FeeAmount: { CurrencyAmount: -1.86 } },
          { FeeType: 'FulfillmentFeeTax', FeeAmount: { CurrencyAmount: -0.37 } },
        ],
      },
    ];

    const signed = parseFinancesItemFeeListSignedTotal(itemFeeList);
    expect(signed).toBeCloseTo(-13.29, 2);

    const bd = parseFinancesItemFeeListBreakdown(itemFeeList);
    expect(bd.referral).toBeCloseTo(-10.8, 2);
    expect(bd.digital).toBeCloseTo(-0.26, 2);
    expect(bd.fba).toBeCloseTo(-2.23, 2);
    expect(bd.referral + bd.fba + bd.digital).toBeCloseTo(signed, 2);
  });

  it('sums top-level row when there are no nested components', () => {
    const list = [
      {
        FeeType: 'Commission',
        FeeAmount: { CurrencyAmount: -5 },
      },
    ];
    expect(parseFinancesItemFeeListSignedTotal(list)).toBe(-5);
    expect(parseFinancesItemFeeListBreakdown(list).referral).toBe(-5);
  });

  it('parseFinancesShipmentItemFeesSignedTotal aggregates lists on a shipment item', () => {
    const si = {
      ItemFeeList: [
        {
          FeeType: 'Commission',
          FeeAmount: { CurrencyAmount: -10 },
          FeeComponent: [
            { FeeType: 'Commission', FeeAmount: { CurrencyAmount: -8 } },
            { FeeType: 'CommissionTax', FeeAmount: { CurrencyAmount: -2 } },
          ],
        },
      ],
      ItemFeeAdjustmentList: [],
      ItemChargeList: [],
    };
    expect(parseFinancesShipmentItemFeesSignedTotal(si)).toBe(-10);
  });

  it('golden: UK SanDisk-style Seller Central fee list matches stored expectations (regression guard)', () => {
    const list = [...GOLDEN_UK_SANDISK_ITEM_FEE_LIST] as unknown[];
    const signed = parseFinancesItemFeeListSignedTotal(list);
    expect(signed).toBeCloseTo(GOLDEN_UK_SANDISK_EXPECTED_SIGNED_TOTAL, 2);
    const bd = parseFinancesItemFeeListBreakdown(list);
    expect(bd.referral).toBeCloseTo(GOLDEN_UK_SANDISK_EXPECTED_BREAKDOWN.referral, 2);
    expect(bd.digital).toBeCloseTo(GOLDEN_UK_SANDISK_EXPECTED_BREAKDOWN.digital, 2);
    expect(bd.fba).toBeCloseTo(GOLDEN_UK_SANDISK_EXPECTED_BREAKDOWN.fba, 2);
    expect(bd.referral + bd.fba + bd.digital).toBeCloseTo(signed, 2);
  });

  it('drops unknown MarketplaceFacilitator* rows (not commission/referral)', () => {
    const list = [
      { FeeType: 'MarketplaceFacilitator-OfferCustom', FeeAmount: { CurrencyAmount: -40 } },
      {
        FeeType: 'Commission',
        FeeAmount: { CurrencyAmount: -10.8 },
        FeeComponent: [
          { FeeType: 'Commission', FeeAmount: { CurrencyAmount: -9 } },
          { FeeType: 'CommissionTax', FeeAmount: { CurrencyAmount: -1.8 } },
        ],
      },
    ];
    expect(parseFinancesItemFeeListSignedTotal(list)).toBeCloseTo(-10.8, 2);
    expect(parseFinancesItemFeeListBreakdown(list).referral).toBeCloseTo(-10.8, 2);
  });

  it('still counts MarketplaceFacilitatorTax-Commission (fee VAT on commission)', () => {
    const list = [
      {
        FeeType: 'MarketplaceFacilitatorTax-Commission',
        FeeAmount: { CurrencyAmount: -1.8 },
      },
      {
        FeeType: 'Commission',
        FeeAmount: { CurrencyAmount: -9 },
      },
    ];
    expect(parseFinancesItemFeeListSignedTotal(list)).toBeCloseTo(-10.8, 2);
    const bd = parseFinancesItemFeeListBreakdown(list);
    expect(bd.referral).toBeCloseTo(-10.8, 2);
  });

  it('drops duplicate MarketplaceFacilitatorTax-Commission when CommissionTax is already in FeeComponent', () => {
    const si = {
      ItemFeeList: [
        ...([...GOLDEN_UK_SANDISK_ITEM_FEE_LIST] as unknown[]),
        {
          FeeType: 'MarketplaceFacilitatorTax-Commission',
          FeeAmount: { CurrencyAmount: -1.8 },
        },
      ],
      ItemFeeAdjustmentList: [] as unknown[],
    };
    expect(parseFinancesShipmentItemFeesSignedTotal(si)).toBeCloseTo(
      GOLDEN_UK_SANDISK_EXPECTED_SIGNED_TOTAL,
      2,
    );
    const bd = parseFinancesShipmentItemFeesBreakdown(si);
    expect(bd.referral).toBeCloseTo(GOLDEN_UK_SANDISK_EXPECTED_BREAKDOWN.referral, 2);
    expect(bd.fba).toBeCloseTo(GOLDEN_UK_SANDISK_EXPECTED_BREAKDOWN.fba, 2);
    expect(bd.digital).toBeCloseTo(GOLDEN_UK_SANDISK_EXPECTED_BREAKDOWN.digital, 2);
  });

  it('drops duplicate MarketplaceFacilitatorVAT-Commission (VAT spelling, not Tax)', () => {
    const si = {
      ItemFeeList: [
        ...([...GOLDEN_UK_SANDISK_ITEM_FEE_LIST] as unknown[]),
        {
          FeeType: 'MarketplaceFacilitatorVAT-Commission',
          FeeAmount: { CurrencyAmount: -1.8 },
        },
      ],
      ItemFeeAdjustmentList: [] as unknown[],
    };
    expect(parseFinancesShipmentItemFeesSignedTotal(si)).toBeCloseTo(
      GOLDEN_UK_SANDISK_EXPECTED_SIGNED_TOTAL,
      2,
    );
    const bd = parseFinancesShipmentItemFeesBreakdown(si);
    expect(bd.referral).toBeCloseTo(GOLDEN_UK_SANDISK_EXPECTED_BREAKDOWN.referral, 2);
  });

  it('drops facilitator commission VAT duplicate when CommissionTax is on ItemFeeList and facilitator row on adjustment list', () => {
    const si = {
      ItemFeeList: [
        {
          FeeType: 'Commission',
          FeeAmount: { CurrencyAmount: -10.8 },
          FeeComponent: [
            { FeeType: 'Commission', FeeAmount: { CurrencyAmount: -9 } },
            { FeeType: 'CommissionTax', FeeAmount: { CurrencyAmount: -1.8 } },
          ],
        },
      ],
      ItemFeeAdjustmentList: [
        {
          FeeType: 'MarketplaceFacilitatorTax-Commission',
          FeeAmount: { CurrencyAmount: -1.8 },
        },
      ],
    };
    expect(parseFinancesShipmentItemFeesSignedTotal(si)).toBeCloseTo(-10.8, 2);
    expect(parseFinancesShipmentItemFeesBreakdown(si).referral).toBeCloseTo(-10.8, 2);
  });

  it('excludes MarketplaceFacilitator-Shipping (no "Tax" substring) from totals and Ref bucket', () => {
    const list = [
      {
        FeeType: 'MarketplaceFacilitator-Shipping',
        FeeAmount: { CurrencyAmount: -49.46 },
      },
      {
        FeeType: 'Commission',
        FeeAmount: { CurrencyAmount: -10.8 },
        FeeComponent: [
          { FeeType: 'Commission', FeeAmount: { CurrencyAmount: -9 } },
          { FeeType: 'CommissionTax', FeeAmount: { CurrencyAmount: -1.8 } },
        ],
      },
      { FeeType: 'FBAPerUnitFulfillmentFee', FeeAmount: { CurrencyAmount: -2.23 } },
    ];
    expect(parseFinancesItemFeeListSignedTotal(list)).toBeCloseTo(-13.03, 2);
    const bd = parseFinancesItemFeeListBreakdown(list);
    expect(bd.referral).toBeCloseTo(-10.8, 2);
    expect(bd.fba).toBeCloseTo(-2.23, 2);
    expect(bd.referral + bd.fba + bd.digital).toBeCloseTo(-13.03, 2);
  });

  it('excludes MarketplaceFacilitatorTax on non-commission bases (e.g. shipping) from totals and Ref bucket', () => {
    const list = [
      {
        FeeType: 'MarketplaceFacilitatorTax-Shipping',
        FeeAmount: { CurrencyAmount: -49.46 },
      },
      {
        FeeType: 'Commission',
        FeeAmount: { CurrencyAmount: -10.8 },
        FeeComponent: [
          { FeeType: 'Commission', FeeAmount: { CurrencyAmount: -9 } },
          { FeeType: 'CommissionTax', FeeAmount: { CurrencyAmount: -1.8 } },
        ],
      },
      {
        FeeType: 'FBAPerUnitFulfillmentFee',
        FeeAmount: { CurrencyAmount: -8.66 },
      },
    ];
    expect(parseFinancesItemFeeListSignedTotal(list)).toBeCloseTo(-19.46, 2);
    const bd = parseFinancesItemFeeListBreakdown(list);
    expect(bd.referral).toBeCloseTo(-10.8, 2);
    expect(bd.fba).toBeCloseTo(-8.66, 2);
    expect(bd.referral + bd.fba + bd.digital).toBeCloseTo(-19.46, 2);
  });

  it('excludes Principal on ItemFeeList (Amazon sometimes mixes it with fee rows)', () => {
    const list = [
      {
        FeeType: 'Principal',
        FeeAmount: { CurrencyAmount: -59.99 },
      },
      {
        FeeType: 'Commission',
        FeeAmount: { CurrencyAmount: -10.8 },
        FeeComponent: [
          { FeeType: 'Commission', FeeAmount: { CurrencyAmount: -9 } },
          { FeeType: 'CommissionTax', FeeAmount: { CurrencyAmount: -1.8 } },
        ],
      },
    ];
    expect(parseFinancesItemFeeListSignedTotal(list)).toBeCloseTo(-10.8, 2);
    const bd = parseFinancesItemFeeListBreakdown(list);
    expect(bd.referral).toBeCloseTo(-10.8, 2);
  });

  it('ignores ItemChargeList (Principal etc.) so fee total is not inflated toward order revenue', () => {
    const si = {
      ItemFeeList: [
        {
          FeeType: 'Commission',
          FeeAmount: { CurrencyAmount: -5 },
        },
      ],
      ItemFeeAdjustmentList: [],
      ItemChargeList: [
        {
          ChargeType: 'Principal',
          ChargeAmount: { CurrencyAmount: 59.99 },
        },
      ],
    };
    expect(parseFinancesShipmentItemFeesSignedTotal(si)).toBe(-5);
  });

  it('does not treat ItemFeeList ChargeAmount-only rows as fees (avoids ~sale price as “fees”)', () => {
    const list = [
      {
        FeeType: '',
        ChargeAmount: { CurrencyAmount: 59.99 },
      },
      {
        FeeType: 'Commission',
        FeeAmount: { CurrencyAmount: -10.8 },
        FeeComponent: [
          { FeeType: 'Commission', FeeAmount: { CurrencyAmount: -9 } },
          { FeeType: 'CommissionTax', FeeAmount: { CurrencyAmount: -1.8 } },
        ],
      },
    ];
    expect(parseFinancesItemFeeListSignedTotal(list)).toBeCloseTo(-10.8, 2);
  });
});
