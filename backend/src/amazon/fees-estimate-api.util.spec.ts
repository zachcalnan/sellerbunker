import {
  extractFeesEstimateResultList,
  feesEstimateItemsFromCaughtError,
  mapGetMyFeesEstimatesResponse,
  parseFeesEstimateResult,
} from './fees-estimate-api.util';

const ukFbaSuccess = {
  Status: 'Success',
  FeesEstimateIdentifier: {
    MarketplaceId: 'A1F83G8C2ARO7P',
    IdType: 'ASIN',
    IdValue: 'B09SV93C9H',
    Identifier: 'fee-asin-B09SV93C9H-0',
    PriceToEstimateFees: {
      ListingPrice: { CurrencyCode: 'GBP', Amount: 19.99 },
    },
  },
  FeesEstimate: {
    TimeOfFeesEstimation: '2026-11-27T17:00:00Z',
    TotalFeesEstimate: { CurrencyCode: 'GBP', Amount: 5.81 },
    FeeDetailList: [
      {
        FeeType: 'ReferralFee',
        FeeAmount: { CurrencyCode: 'GBP', Amount: 3.0 },
        FinalFee: { CurrencyCode: 'GBP', Amount: 3.0 },
      },
      {
        FeeType: 'FBAFees',
        FeeAmount: { CurrencyCode: 'GBP', Amount: 2.7 },
        FinalFee: { CurrencyCode: 'GBP', Amount: 2.7 },
        IncludedFeeDetailList: [
          {
            FeeType: 'FBAWeightHandling',
            FeeAmount: { CurrencyCode: 'GBP', Amount: 2.5 },
            FinalFee: { CurrencyCode: 'GBP', Amount: 2.5 },
          },
          {
            FeeType: 'FBAPickAndPack',
            FeeAmount: { CurrencyCode: 'GBP', Amount: 0.2 },
            FinalFee: { CurrencyCode: 'GBP', Amount: 0.2 },
          },
        ],
      },
      {
        FeeType: 'VariableClosingFee',
        FeeAmount: { CurrencyCode: 'GBP', Amount: 0.11 },
        FinalFee: { CurrencyCode: 'GBP', Amount: 0.11 },
      },
    ],
  },
};

describe('fees-estimate-api.util', () => {
  it('extracts a batch payload array', () => {
    const list = extractFeesEstimateResultList({ payload: [ukFbaSuccess] });
    expect(list).toHaveLength(1);
    expect(list[0].Status).toBe('Success');
  });

  it('parses referral, FBA leaves, digital, and total without buckling other into FBA', () => {
    const parsed = parseFeesEstimateResult(ukFbaSuccess, { currency: 'GBP' });
    expect(parsed.error).toBeNull();
    expect(parsed.currency).toBe('GBP');
    expect(parsed.total).toBe(5.81);
    expect(parsed.referralFee).toBe(3);
    // Parent FBAFees is skipped; only included leaves are summed.
    expect(parsed.fbaFee).toBe(2.7);
    expect(parsed.digitalServiceFee).toBe(0.11);
    expect(parsed.otherFees).toBeNull();
    expect(parsed.feeLines.map((l) => l.type).sort()).toEqual(
      ['FBAPickAndPack', 'FBAWeightHandling', 'ReferralFee', 'VariableClosingFee'].sort(),
    );
  });

  it('returns a per-item error for ClientError without failing the batch', () => {
    const mapped = mapGetMyFeesEstimatesResponse({
      raw: {
        payload: [
          ukFbaSuccess,
          {
            Status: 'ClientError',
            FeesEstimateIdentifier: {
              IdType: 'ASIN',
              IdValue: 'B00INVALID1',
              Identifier: 'fee-asin-B00INVALID1-1',
            },
            Error: { Type: 'Sender', Code: 'InvalidParameterValue', Message: 'Invalid ASIN' },
          },
        ],
      },
      items: [
        {
          asin: 'B09SV93C9H',
          price: 19.99,
          fulfilment: 'FBA',
          identifier: 'fee-asin-B09SV93C9H-0',
          currency: 'GBP',
        },
        {
          asin: 'B00INVALID1',
          price: 10,
          fulfilment: 'FBA',
          identifier: 'fee-asin-B00INVALID1-1',
          currency: 'GBP',
        },
      ],
    });
    expect(mapped[0].total).toBe(5.81);
    expect(mapped[0].error).toBeNull();
    expect(mapped[1].total).toBeNull();
    expect(mapped[1].error).toBe('Invalid ASIN');
  });

  it('marks unmatched request items with a per-item error', () => {
    const mapped = mapGetMyFeesEstimatesResponse({
      raw: { payload: [] },
      items: [
        {
          asin: 'B09SV93C9H',
          price: 19.99,
          fulfilment: 'FBA',
          identifier: 'fee-asin-B09SV93C9H-0',
          currency: 'GBP',
        },
      ],
    });
    expect(mapped[0].error).toBe('No fee estimate returned for this ASIN');
    expect(mapped[0].total).toBeNull();
  });

  it('turns a caught throttle into per-item errors', () => {
    const items = feesEstimateItemsFromCaughtError(
      [
        {
          asin: 'B09SV93C9H',
          price: 19.99,
          fulfilment: 'FBA',
          identifier: 'fee-asin-B09SV93C9H-0',
          currency: 'GBP',
        },
      ],
      'SP-API 429 QuotaExceeded',
    );
    expect(items[0].error).toContain('429');
    expect(items[0].total).toBeNull();
  });

  it('buckets uncategorized leaf fees as otherFees, not FBA', () => {
    const parsed = parseFeesEstimateResult(
      {
        Status: 'Success',
        FeesEstimate: {
          TotalFeesEstimate: { CurrencyCode: 'GBP', Amount: 1.5 },
          FeeDetailList: [
            {
              FeeType: 'HighSeasonSurcharge',
              FinalFee: { CurrencyCode: 'GBP', Amount: 1.5 },
            },
          ],
        },
      },
      { currency: 'GBP' },
    );
    expect(parsed.fbaFee).toBeNull();
    expect(parsed.otherFees).toBe(1.5);
    expect(parsed.total).toBe(1.5);
  });
});
