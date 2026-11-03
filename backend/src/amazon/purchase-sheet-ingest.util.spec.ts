import { buildPurchaseSheetLinesFromIngest } from './purchase-sheet-ingest.util';

describe('buildPurchaseSheetLinesFromIngest', () => {
  it('maps created lines by lineIndex (not ASIN rematch)', () => {
    const lines = buildPurchaseSheetLinesFromIngest({
      ledgerLines: [
        {
          lineIndex: 1,
          status: 'created',
          asin: 'B0AAA11111',
          productTitle: 'DB Title',
          unitCostIncVat: 64.49,
        },
      ],
      dtoLines: [
        {
          asin: 'B0AAA11111',
          productTitle: 'OCR Title',
          qty: 4,
          unitCostIncVat: 64.49,
          deliveryCostIncVat: 0,
        },
      ],
      supplierLink: 'https://example.com/o/1',
    });

    expect(lines).toEqual([
      {
        asin: 'B0AAA11111',
        productTitle: 'OCR Title',
        sku: null,
        qty: 4,
        unitCostIncVat: 64.49,
        deliveryCostIncVat: 0,
        prepCostIncVat: undefined,
        supplierLink: 'https://example.com/o/1',
      },
    ]);
  });

  it('still builds sheet rows when ledger status is skipped (retry catch-up)', () => {
    const lines = buildPurchaseSheetLinesFromIngest({
      ledgerLines: [
        {
          lineIndex: 1,
          status: 'skipped',
          asin: 'B0BBB22222',
          productTitle: 'Existing',
          // skipped responses historically omitted unit cost
        },
      ],
      dtoLines: [
        {
          asin: 'B0BBB22222',
          productTitle: 'From screenshot',
          qty: 4,
          unitRrpIncVat: 85.99,
        },
      ],
      promoType: 'buy_3_get_1_free',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0].asin).toBe('B0BBB22222');
    expect(lines[0].qty).toBe(4);
    expect(lines[0].productTitle).toBe('From screenshot');
    expect(lines[0].unitCostIncVat).toBeCloseTo(64.4925, 3);
  });

  it('uses product ASIN from ledger when DTO ASIN is missing (SKU-only submit)', () => {
    const lines = buildPurchaseSheetLinesFromIngest({
      ledgerLines: [
        {
          lineIndex: 1,
          status: 'created',
          asin: 'B0CCC33333',
          productTitle: 'SKU product',
          unitCostIncVat: 12.5,
        },
      ],
      dtoLines: [
        {
          productTitle: 'SKU product',
          qty: 2,
          unitCostIncVat: 12.5,
        },
      ],
    });

    expect(lines).toEqual([
      expect.objectContaining({
        asin: 'B0CCC33333',
        qty: 2,
        unitCostIncVat: 12.5,
      }),
    ]);
  });

  it('skips lines without ASIN or positive unit cost', () => {
    const lines = buildPurchaseSheetLinesFromIngest({
      ledgerLines: [
        { lineIndex: 1, status: 'created', productTitle: 'No asin' },
        {
          lineIndex: 2,
          status: 'created',
          asin: 'B0DDD44444',
          unitCostIncVat: 0,
        },
      ],
      dtoLines: [
        { qty: 1, productTitle: 'No asin' },
        { asin: 'B0DDD44444', qty: 1, unitCostIncVat: 0 },
      ],
    });
    expect(lines).toEqual([]);
  });
});
