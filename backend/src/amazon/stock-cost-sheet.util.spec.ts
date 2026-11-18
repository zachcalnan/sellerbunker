import {
  buildSheetPurchasedAndArrivedByAsin,
  isPurchaseSheetDeliveredYes,
  isPurchaseSheetInTransit,
  matchUnitCostFromPurchaseSheet,
  parseBlue30ArrivedRows,
  parsePurchaseSheetStageRows,
  sheetUnitCostToCogs,
  sumSheetAwareStockCostPipeline,
} from './stock-cost-sheet.util';

describe('stock-cost-sheet.util', () => {
  it('detects Delivered Yes vs in-transit', () => {
    expect(isPurchaseSheetDeliveredYes('Yes')).toBe(true);
    expect(isPurchaseSheetDeliveredYes('yes')).toBe(true);
    expect(isPurchaseSheetDeliveredYes('Y')).toBe(true);
    expect(isPurchaseSheetInTransit('No')).toBe(true);
    expect(isPurchaseSheetInTransit('')).toBe(true);
    expect(isPurchaseSheetInTransit('No')).toBe(true);
    expect(isPurchaseSheetInTransit('Yes')).toBe(false);
  });

  it('treats sheet £/Unit as COGS at VAT 0', () => {
    expect(sheetUnitCostToCogs(12.5)).toBe(12.5);
  });

  it('parses CURRENT ORDERS into in-transit vs delivered', () => {
    const values = [
      [
        'Date',
        'ASIN',
        'Order Num',
        'Units',
        '£/Unit',
        'Home/Prep',
        'Delivered ',
      ],
      ['1/11/2026', 'B0AAA', 'ORD1', '4', '£10.00', 'PREP CENTER', 'No'],
      ['2/11/2026', 'B0BBB', 'ORD2', '2', '£5.00', 'HOME', 'Yes'],
      ['3/11/2026', 'B0CCC', 'ORD3', '1', '£8.00', 'HOME', ''],
    ];
    const { inTransit, delivered, errors } = parsePurchaseSheetStageRows(values);
    expect(errors).toEqual([]);
    expect(inTransit.map((r) => r.asin)).toEqual(['B0AAA', 'B0CCC']);
    expect(delivered.map((r) => r.asin)).toEqual(['B0BBB']);
    expect(inTransit[0].unitCost).toBe(10);
    expect(delivered[0].homePrep).toBe('HOME');
  });

  it('parses Blue30 Quantity Received as arrived', () => {
    const values = [
      ['BLUE | 30'],
      [
        'Date',
        'Order Reference',
        'Supplier',
        'Amazon Product Name',
        'ASIN',
        'SKU',
        'Quantity',
        'Notes',
        'Added to SC',
        'Check-in Tracking Numbers',
        'Quantity Received',
      ],
      [
        '1/11/2026',
        '#R1',
        'Healf',
        'A',
        'B0AAA',
        'SKU-A',
        '10',
        '',
        '',
        '',
        '6',
      ],
      [
        '2/11/2026',
        '#R2',
        'Healf',
        'B',
        'B0BBB',
        '',
        '4',
        '',
        '',
        '',
        '',
      ],
    ];
    const { arrived, errors } = parseBlue30ArrivedRows(values);
    expect(errors).toEqual([]);
    expect(arrived).toHaveLength(1);
    expect(arrived[0]).toMatchObject({
      asin: 'B0AAA',
      qtyReceived: 6,
      orderRef: '#R1',
      sku: 'SKU-A',
    });
  });

  it('matches purchase-sheet unit cost by order ref then latest ASIN', () => {
    const lines = parsePurchaseSheetStageRows([
      ['Date', 'ASIN', 'Order Num', 'Units', '£/Unit', 'Delivered '],
      ['1/10/2026', 'B0AAA', 'ORD1', '2', '£10', 'No'],
      ['1/11/2026', 'B0AAA', 'ORD2', '2', '£12', 'No'],
    ]).inTransit;
    expect(matchUnitCostFromPurchaseSheet('B0AAA', 'ORD1', lines)).toBe(10);
    expect(matchUnitCostFromPurchaseSheet('B0AAA', '', lines)).toBe(12);
  });

  it('builds purchased in-transit and arrived-for-prep with exclusivity', () => {
    const purchase = parsePurchaseSheetStageRows([
      [
        'Date',
        'ASIN',
        'Order Num',
        'Units',
        '£/Unit',
        'Home/Prep',
        'Delivered ',
      ],
      // Still on the way
      ['1/11/2026', 'B0OPEN', 'O1', '5', '£4', 'PREP CENTER', 'No'],
      // Delivered at home
      ['1/11/2026', 'B0HOME', 'O2', '3', '£6', 'HOME', 'Yes'],
      // Still marked No but B30 has received 2 → leave purchased
      ['1/11/2026', 'B0BOTH', 'O3', '4', '£8', 'PREP CENTER', 'No'],
    ]);
    const blue30 = parseBlue30ArrivedRows([
      [
        'Date',
        'Order Reference',
        'Supplier',
        'Amazon Product Name',
        'ASIN',
        'Quantity',
        'Quantity Received',
      ],
      ['1/11/2026', 'O3', 'S', 'X', 'B0BOTH', '4', '2'],
      ['1/11/2026', 'O4', 'S', 'Y', 'B0PREP', '10', '10'],
    ]);

    // Give B0PREP a purchase cost via a delivered? or in-transit line for match
    const costLines = [
      ...purchase.inTransit,
      ...purchase.delivered,
      {
        asin: 'B0PREP',
        qty: 10,
        unitCost: 7,
        orderRef: 'O4',
        homePrep: 'PREP CENTER' as const,
        purchaseDate: null,
        sheetRow: 99,
      },
    ];

    const { purchasedByAsin, arrivedByAsin } =
      buildSheetPurchasedAndArrivedByAsin({
        purchaseInTransit: purchase.inTransit,
        purchaseDelivered: purchase.delivered,
        blue30Arrived: blue30.arrived,
      });

    // Re-match B0PREP cost: blue30 match uses allPurchase which includes only
    // purchase sheet lines — add cost via inTransit for B0PREP in a second build.
    void costLines;

    expect(purchasedByAsin.get('B0OPEN')?.qty).toBe(5);
    expect(purchasedByAsin.get('B0OPEN')?.cost).toBe(20);
    // 4 open minus 2 B30 received → 2 still purchased
    expect(purchasedByAsin.get('B0BOTH')?.qty).toBe(2);
    expect(purchasedByAsin.get('B0HOME')).toBeUndefined();

    expect(arrivedByAsin.get('B0HOME')?.qty).toBe(3);
    expect(arrivedByAsin.get('B0HOME')?.cost).toBe(18);
    expect(arrivedByAsin.get('B0BOTH')?.qty).toBe(2);
  });

  it('values B30 arrived via purchase-sheet order match', () => {
    const { purchasedByAsin, arrivedByAsin } =
      buildSheetPurchasedAndArrivedByAsin({
        purchaseInTransit: [
          {
            asin: 'B0PREP',
            qty: 10,
            unitCost: 7,
            orderRef: 'O4',
            homePrep: 'PREP CENTER',
            purchaseDate: new Date('2026-11-01'),
            sheetRow: 2,
          },
        ],
        purchaseDelivered: [],
        blue30Arrived: [
          {
            asin: 'B0PREP',
            sku: null,
            qtyReceived: 10,
            qtyOrdered: 10,
            orderRef: 'O4',
            sheetRow: 3,
          },
        ],
      });
    // All 10 arrived on B30 while still "No" on purchase → purchased deducted to 0
    expect(purchasedByAsin.get('B0PREP')).toBeUndefined();
    expect(arrivedByAsin.get('B0PREP')?.qty).toBe(10);
    expect(arrivedByAsin.get('B0PREP')?.cost).toBe(70);
  });

  it('clamps prep by Amazon held and keeps available/sent from inventory', () => {
    const purchasedByAsin = new Map([
      [
        'B0OPEN',
        { qty: 5, cost: 20, unitCostWeight: 20, unitCostQty: 5 },
      ],
    ]);
    const arrivedByAsin = new Map([
      [
        'B0PREP',
        { qty: 10, cost: 70, unitCostWeight: 70, unitCostQty: 10 },
      ],
    ]);
    const tot = sumSheetAwareStockCostPipeline({
      skuRows: [
        {
          asin: 'B0PREP',
          availableQty: 3,
          inboundQty: 2,
          unitCost: 7,
        },
        {
          asin: 'B0OPEN',
          availableQty: 0,
          inboundQty: 0,
          unitCost: 4,
        },
      ],
      purchasedByAsin,
      arrivedByAsin,
    });
    // prep = 10 arrived − 5 amazon held = 5 × £7
    expect(tot.stockForPrepQty).toBe(5);
    expect(tot.stockForPrepCost).toBe(35);
    expect(tot.availableStockQty).toBe(3);
    expect(tot.availableStockCost).toBe(21);
    expect(tot.stockSentQty).toBe(2);
    expect(tot.stockSentCost).toBe(14);
    expect(tot.stockPurchasedQty).toBe(5);
    expect(tot.stockPurchasedCost).toBe(20);
    expect(tot.totalCost).toBe(90);
  });
});
