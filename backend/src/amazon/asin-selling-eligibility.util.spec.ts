import { eligibilityFromListingsRestrictionsBody } from './asin-selling-eligibility.util';

describe('eligibilityFromListingsRestrictionsBody', () => {
  it('treats missing or empty restrictions as restock-allowed', () => {
    expect(eligibilityFromListingsRestrictionsBody(null)).toEqual({
      canRestock: false,
      notes: 'empty_or_invalid_response',
    });
    expect(eligibilityFromListingsRestrictionsBody({})).toEqual({
      canRestock: true,
      notes: null,
    });
    expect(eligibilityFromListingsRestrictionsBody({ restrictions: [] })).toEqual({
      canRestock: true,
      notes: null,
    });
  });

  it('collects reason codes when present', () => {
    const r = eligibilityFromListingsRestrictionsBody({
      restrictions: [
        {
          marketplaceId: 'A1F83G8C2ARO7P',
          conditionType: 'new_new',
          reasons: [{ reasonCode: 'APPROVAL_REQUIRED' }, { reasonCode: 'ASIN_NOT_FOUND' }],
        },
      ],
    });
    expect(r.canRestock).toBe(false);
    expect(r.notes?.split(', ').sort()).toEqual(['APPROVAL_REQUIRED', 'ASIN_NOT_FOUND'].sort());
  });

  it('dedupes repeated reason codes', () => {
    expect(
      eligibilityFromListingsRestrictionsBody({
        restrictions: [
          {
            reasons: [{ reasonCode: 'X' }, { reasonCode: 'X' }],
          },
        ],
      }),
    ).toEqual({ canRestock: false, notes: 'X' });
  });
});
