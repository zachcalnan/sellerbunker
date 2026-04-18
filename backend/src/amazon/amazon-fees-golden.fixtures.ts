/**
 * Golden expectations for Finances `ItemFeeList` parsing (UK FBA example, ~£60 sale).
 * Source: Seller Central fee breakdown — commission base + VAT, digital, FBA + VAT.
 * If these drift, parsing or aggregation regressed; fix code and/or update numbers with a SC screenshot.
 */
export const GOLDEN_UK_SANDISK_ITEM_FEE_LIST = [
  {
    FeeType: 'Commission',
    FeeAmount: { CurrencyAmount: -10.8 },
    FeeComponent: [
      { FeeType: 'Commission', FeeAmount: { CurrencyAmount: -9 } },
      { FeeType: 'CommissionTax', FeeAmount: { CurrencyAmount: -1.8 } },
    ],
  },
  {
    FeeType: 'DigitalServicesFee',
    FeeAmount: { CurrencyAmount: -0.26 },
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
] as const;

/** Signed total of all Amazon fees on the line (Finances convention: negative). */
export const GOLDEN_UK_SANDISK_EXPECTED_SIGNED_TOTAL = -13.29;

export const GOLDEN_UK_SANDISK_EXPECTED_BREAKDOWN = {
  referral: -10.8,
  digital: -0.26,
  fba: -2.23,
} as const;
