import {
  enrichDraftWithCatalogAndDb,
  rankListingMatches,
  scoreDbTitle,
  shouldAutoApplyListing,
} from './purchase-screenshot-enrich.util';
import { bestCatalogMatch } from './supplier-product-catalog';

describe('supplier-product-catalog', () => {
  it('matches Healf EYE from 4-for-3 order totals', () => {
    const hit = bestCatalogMatch({
      supplier: 'Healf',
      productTitle: null,
      qty: 4,
      lineTotalIncVat: 284.97,
      unitCostIncVat: 71.24,
      unitRrpIncVat: 94.99,
    });
    expect(hit?.product.asin).toBe('B0BX4PX242');
    expect(hit!.score).toBeGreaterThanOrEqual(8);
  });

  it('matches Thomann Otamatone from title + 10×£24.90 total', () => {
    const hit = bestCatalogMatch({
      supplier: 'Thomann',
      productTitle: 'Otamatone Classic White',
      qty: 10,
      lineTotalIncVat: 249,
      unitCostIncVat: 24.9,
    });
    expect(hit?.product.asin).toBe('B07RM5DCFR');
    expect(hit!.score).toBeGreaterThanOrEqual(8);
  });
});

describe('listing title scoring', () => {
  it('scores OneSkin EYE OCR title highly against listing', () => {
    const score = scoreDbTitle(
      'OneSkin OS-01 EYE',
      'OneSkin OS-01 EYE Topical Supplement 20ml',
    );
    expect(score).toBeGreaterThanOrEqual(12);
  });

  it('matches PURA D OR biotin shampoo OCR title to listing', () => {
    const ranked = rankListingMatches("PURA D'OR Anti-Thinning Biotin Shampoo", [
      {
        asin: 'B00PURA001',
        sku: 'PURA-SHAMPOO',
        title: "PURA D'OR Anti-Thinning Biotin Shampoo Clinical Proven",
      },
      {
        asin: 'B0BX4PX242',
        sku: 'EYE',
        title: 'OneSkin OS-01 EYE Topical Supplement 20ml',
      },
    ]);
    expect(ranked[0].asin).toBe('B00PURA001');
    expect(shouldAutoApplyListing(ranked)?.asin).toBe('B00PURA001');
  });
});

describe('enrichDraftWithCatalogAndDb', () => {
  it('fills missing title and ASIN for Healf EYE totals', () => {
    const draft = enrichDraftWithCatalogAndDb({
      supplier: 'Healf',
      orderNumber: 'H-2788542',
      purchaseDate: '2026-09-07',
      currency: 'GBP',
      vatRatePct: 0,
      fulfilment: 'FBA',
      promo: { type: 'buy_3_get_1_free' },
      lines: [
        {
          qty: 4,
          unitCostIncVat: 71.24,
          unitRrpIncVat: 94.99,
          lineTotalIncVat: 284.97,
        },
      ],
      warnings: [],
    });

    expect(draft.lines[0].asin).toBe('B0BX4PX242');
    expect(draft.lines[0].productTitle).toMatch(/OS-01 EYE/i);
  });

  it('prefers OCR title → listing match and attaches candidates', () => {
    const draft = enrichDraftWithCatalogAndDb(
      {
        supplier: 'Healf',
        orderNumber: 'H-1',
        purchaseDate: '2026-09-07',
        currency: 'GBP',
        vatRatePct: 0,
        fulfilment: 'FBA',
        lines: [
          {
            qty: 4,
            productTitle: 'OneSkin OS-01 EYE',
            unitCostIncVat: 71.24,
          },
        ],
        warnings: [],
      },
      [
        {
          asin: 'B0BX4PX242',
          sku: 'HEALF-EYE-4PX242',
          title: 'OneSkin OS-01 EYE Topical Supplement 20ml',
        },
        {
          asin: 'B0BRYNPN93',
          sku: 'LW-43N5-V319',
          title: 'oneskin OS-01 BODY Peptide Moisturizer, Skin Longevity Lotion',
        },
      ],
    );
    expect(draft.lines[0].asin).toBe('B0BX4PX242');
    expect(draft.lines[0].productTitle).toMatch(/Topical Supplement/i);
    expect(draft.lines[0].listingCandidates?.[0].asin).toBe('B0BX4PX242');
  });

  it('prefers DB title/ASIN when catalog does not match', () => {
    const draft = enrichDraftWithCatalogAndDb(
      {
        supplier: 'Other',
        orderNumber: 'X-1',
        purchaseDate: '2026-09-07',
        currency: 'GBP',
        vatRatePct: 0,
        fulfilment: 'FBA',
        lines: [
          {
            qty: 1,
            productTitle: 'weird SPF sunscreen untinted',
            unitCostIncVat: 10,
          },
        ],
        warnings: [],
      },
      [
        {
          asin: 'B0CLT7L8P3',
          sku: 'JH-QAB6-VDYJ',
          title:
            'oneskin Face SPF 30+ | Broad Spectrum Tinted Sunscreen (Untinted)',
        },
      ],
    );
    expect(draft.lines[0].asin).toBe('B0CLT7L8P3');
  });

  it('fills B07RM5DCFR for Thomann Otamatone Classic White 10×£249', () => {
    const draft = enrichDraftWithCatalogAndDb({
      supplier: 'Thomann',
      orderNumber: 'PENDING-20260909',
      purchaseDate: '2026-09-09',
      currency: 'GBP',
      vatRatePct: 0,
      fulfilment: 'FBA',
      shipDestination: 'PREP CENTER',
      promo: { type: 'none' },
      lines: [
        {
          productTitle: 'Otamatone Classic White',
          qty: 10,
          unitCostIncVat: 24.9,
          lineTotalIncVat: 249,
          deliveryCostIncVat: 0,
        },
      ],
      warnings: [],
    });

    expect(draft.lines[0].asin).toBe('B07RM5DCFR');
    expect(draft.lines[0].unitRrpIncVat).toBe(25);
    expect(draft.lines[0].productTitle).toMatch(/Otamatone/i);
  });
});
