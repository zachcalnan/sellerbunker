import {
  isListingsGetRetryableError,
  parseListingPatchMetaFromGetListingsItem,
} from './repricer-listing-patch-meta.util';

describe('parseListingPatchMetaFromGetListingsItem', () => {
  const uk = 'A1F83G8C2ARO7P';

  it('reads productType from summaries', () => {
    const meta = parseListingPatchMetaFromGetListingsItem(
      {
        summaries: [
          {
            marketplaceId: uk,
            productType: 'MUSICAL_INSTRUMENT',
          },
        ],
        offers: [{ price: { currency: 'GBP', amount: 37.39 } }],
      },
      uk,
      null,
    );
    expect(meta).toEqual({
      marketplaceId: uk,
      productType: 'MUSICAL_INSTRUMENT',
      currency: 'GBP',
    });
  });

  it('uses DB fallback when offers exist but summaries omit productType', () => {
    const meta = parseListingPatchMetaFromGetListingsItem(
      {
        sku: 'N9-46CZ-2Z3N',
        summaries: [{ marketplaceId: uk }],
        offers: [{ price: { currency: 'GBP', amount: 37.39 } }],
      },
      uk,
      'TOY_FIGURE',
    );
    expect(meta?.productType).toBe('TOY_FIGURE');
    expect(meta?.currency).toBe('GBP');
  });

  it('reads productType from attributes.product_type', () => {
    const meta = parseListingPatchMetaFromGetListingsItem(
      {
        attributes: {
          product_type: [{ value: 'ABIS_MUSIC' }],
        },
      },
      uk,
      null,
    );
    expect(meta?.productType).toBe('ABIS_MUSIC');
  });

  it('returns null when no productType and no listing signals', () => {
    expect(parseListingPatchMetaFromGetListingsItem({}, uk, 'X')).toBeNull();
  });
});

describe('isListingsGetRetryableError', () => {
  it('treats listings 404 as retryable', () => {
    expect(
      isListingsGetRetryableError(new Error('SP-API (404) GET /listings/2021-08-01/items/...')),
    ).toBe(true);
  });

  it('does not treat 403 as retryable', () => {
    expect(
      isListingsGetRetryableError(new Error('SP-API (403) GET /listings/2021-08-01/items/...')),
    ).toBe(false);
  });
});
