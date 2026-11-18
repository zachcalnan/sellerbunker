import {
  buildSheetPurchasedAndArrivedByAsin,
  isPurchaseSheetDeliveredYes,
  isPurchaseSheetHomePrepSent,
  isPurchaseSheetInTransit,
  matchUnitCostFromPurchaseSheet,
  parseBlue30ArrivedRows,
  parsePurchaseSheetStageRows,
  planDeliveredYesUpdatesFromBlue30,
  planHomePrepSentUpdatesFromAmazonHeld,
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

  it('detects Home/Prep sent', () => {
    expect(isPurchaseSheetHomePrepSent('sent')).toBe(true);
    expect(isPurchaseSheetHomePrepSent('SENT')).toBe(true);
    expect(isPurchaseSheetHomePrepSent('sent to amazon')).toBe(true);
    expect(isPurchaseSheetHomePrepSent('HOME')).toBe(false);
    expect(isPurchaseSheetHomePrepSent('PREP CENTER')).toBe(false);
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
      ['4/11/2026', 'B0DDD', 'ORD4', '3', '£9.00', 'sent', 'Yes'],
    ];
    const { inTransit, delivered, errors } = parsePurchaseSheetStageRows(values);
    expect(errors).toEqual([]);
    expect(inTransit.map((r) => r.asin)).toEqual(['B0AAA', 'B0CCC']);
    expect(delivered.map((r) => r.asin)).toEqual(['B0BBB', 'B0DDD']);
    expect(inTransit[0].unitCost).toBe(10);
    expect(delivered[0].homePrep).toBe('HOME');
    expect(delivered[1].homePrep).toBe('sent');
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

  it('plans Delivered=Yes from Blue30 by Order Ref+ASIN then ASIN FIFO', () => {
    const purchase = parsePurchaseSheetStageRows([
      [
        'Date',
        'ASIN',
        'Order Num',
        'Units',
        '£/Unit',
        'Delivered ',
      ],
      ['1/11/2026', 'B0BOTH', 'O3', '4', '£8', 'No'],
      ['1/11/2026', 'B0OPEN', 'O1', '5', '£4', 'No'],
      ['2/11/2026', 'B0ASIN', 'O9', '3', '£2', 'No'],
      ['3/11/2026', 'B0ASIN', 'O10', '7', '£2', 'No'],
      ['1/11/2026', 'B0DONE', 'O2', '2', '£6', 'Yes'],
    ]);

    const updates = planDeliveredYesUpdatesFromBlue30({
      purchaseInTransit: purchase.inTransit,
      deliveredColIndex0: 5,
      blue30Arrived: [
        {
          asin: 'B0BOTH',
          sku: null,
          qtyReceived: 2,
          qtyOrdered: 4,
          orderRef: 'O3',
          sheetRow: 2,
        },
        {
          asin: 'B0ASIN',
          sku: null,
          qtyReceived: 3,
          qtyOrdered: 10,
          orderRef: 'UNKNOWN',
          sheetRow: 3,
        },
        {
          asin: 'B0DONE',
          sku: null,
          qtyReceived: 2,
          qtyOrdered: 2,
          orderRef: 'O2',
          sheetRow: 4,
        },
      ],
    });

    // Order+ASIN match flips O3; ASIN-only covers oldest B0ASIN (3 units) first;
    // already-delivered B0DONE is not in inTransit so never planned.
    expect(updates.map((u) => u.sheetRow).sort((a, b) => a - b)).toEqual([
      2, // B0BOTH O3
      4, // B0ASIN O9 (sheet row 4 in 1-based: header=1, rows 2..6 → O9 is row 4)
    ]);
    expect(updates.find((u) => u.asin === 'B0BOTH')?.match).toBe('order_asin');
    expect(updates.find((u) => u.asin === 'B0ASIN')?.match).toBe('asin');
    expect(updates.every((u) => u.deliveredColIndex0 === 5)).toBe(true);
  });

  it('is idempotent: already Delivered rows are not re-planned', () => {
    const updates = planDeliveredYesUpdatesFromBlue30({
      purchaseInTransit: [],
      deliveredColIndex0: 5,
      blue30Arrived: [
        {
          asin: 'B0X',
          sku: null,
          qtyReceived: 10,
          qtyOrdered: 10,
          orderRef: 'O1',
          sheetRow: 2,
        },
      ],
    });
    expect(updates).toEqual([]);
  });

  it('plans Home/Prep=sent from Amazon held FIFO; skips already-sent', () => {
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
      ['1/11/2026', 'B0A', 'O1', '4', '£5', 'PREP CENTER', 'Yes'],
      ['2/11/2026', 'B0A', 'O2', '6', '£5', 'HOME', 'Yes'],
      ['3/11/2026', 'B0A', 'O3', '2', '£5', 'sent', 'Yes'],
      ['1/11/2026', 'B0B', 'O4', '3', '£2', 'HOME', 'Yes'],
      ['1/11/2026', 'B0C', 'O5', '5', '£1', 'HOME', 'No'],
    ]);

    const updates = planHomePrepSentUpdatesFromAmazonHeld({
      purchaseDelivered: purchase.delivered,
      homePrepColIndex0: 5,
      amazonHeldByAsin: new Map([
        ['B0A', 5], // covers oldest open row (4) then starts next
        ['B0B', 0],
        ['B0C', 99], // not delivered — ignored
      ]),
    });

    expect(updates.map((u) => u.sheetRow).sort((a, b) => a - b)).toEqual([
      2, // O1 PREP CENTER
      3, // O2 HOME (remaining held after O1)
    ]);
    expect(updates.every((u) => u.homePrepColIndex0 === 5)).toBe(true);
    expect(updates.find((u) => u.sheetRow === 4)).toBeUndefined(); // already sent
    expect(updates.find((u) => u.asin === 'B0B')).toBeUndefined();
  });

  it('Home/Prep=sent planning is idempotent when all covered rows are sent', () => {
    const updates = planHomePrepSentUpdatesFromAmazonHeld({
      purchaseDelivered: [
        {
          asin: 'B0A',
          qty: 10,
          unitCost: 1,
          orderRef: 'O1',
          homePrep: 'sent',
          purchaseDate: new Date('2026-11-01'),
          sheetRow: 2,
        },
      ],
      homePrepColIndex0: 5,
      amazonHeldByAsin: new Map([['B0A', 10]]),
    });
    expect(updates).toEqual([]);
  });

  it('builds purchased / prep candidates from Delivered flag only (ignores raw B30)', () => {
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
      ['1/11/2026', 'B0OPEN', 'O1', '5', '£4', 'PREP CENTER', 'No'],
      ['1/11/2026', 'B0HOME', 'O2', '3', '£6', 'HOME', 'Yes'],
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
      // Historical received that used to inflate prep forever:
      ['1/11/2026', 'O4', 'S', 'Y', 'B0PREP', '10', '10'],
      ['1/01/2025', 'OLD', 'S', 'Z', 'B0HIST', '100', '100'],
    ]);

    const { purchasedByAsin, arrivedByAsin, sheetSentByAsin } =
      buildSheetPurchasedAndArrivedByAsin({
        purchaseInTransit: purchase.inTransit,
        purchaseDelivered: purchase.delivered,
        blue30Arrived: blue30.arrived,
      });

    expect(purchasedByAsin.get('B0OPEN')?.qty).toBe(5);
    expect(purchasedByAsin.get('B0OPEN')?.cost).toBe(20);
    // Still Delivered=No on sheet → stays purchased (sync would flip before this)
    expect(purchasedByAsin.get('B0BOTH')?.qty).toBe(4);
    expect(purchasedByAsin.get('B0HOME')).toBeUndefined();

    // Only Delivered=Yes sheet rows — not historical Blue30 received
    expect(arrivedByAsin.get('B0HOME')?.qty).toBe(3);
    expect(arrivedByAsin.get('B0HOME')?.cost).toBe(18);
    expect(arrivedByAsin.get('B0BOTH')).toBeUndefined();
    expect(arrivedByAsin.get('B0PREP')).toBeUndefined();
    expect(arrivedByAsin.get('B0HIST')).toBeUndefined();
    expect(sheetSentByAsin.size).toBe(0);
  });

  it('excludes Home/Prep=sent from prep candidates and tracks sheet-sent qty', () => {
    const { arrivedByAsin, sheetSentByAsin } =
      buildSheetPurchasedAndArrivedByAsin({
        purchaseInTransit: [],
        purchaseDelivered: [
          {
            asin: 'B0A',
            qty: 4,
            unitCost: 5,
            orderRef: 'O1',
            homePrep: 'sent',
            purchaseDate: new Date('2026-11-01'),
            sheetRow: 2,
          },
          {
            asin: 'B0A',
            qty: 6,
            unitCost: 5,
            orderRef: 'O2',
            homePrep: 'PREP CENTER',
            purchaseDate: new Date('2026-11-02'),
            sheetRow: 3,
          },
        ],
      });
    expect(arrivedByAsin.get('B0A')?.qty).toBe(6);
    expect(sheetSentByAsin.get('B0A')).toBe(4);
  });

  it('after sync-style Delivered flip, B30-received line moves from purchased to prep', () => {
    const { purchasedByAsin, arrivedByAsin } =
      buildSheetPurchasedAndArrivedByAsin({
        purchaseInTransit: [],
        purchaseDelivered: [
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
    expect(purchasedByAsin.get('B0PREP')).toBeUndefined();
    expect(arrivedByAsin.get('B0PREP')?.qty).toBe(10);
    expect(arrivedByAsin.get('B0PREP')?.cost).toBe(70);
  });

  it('does not double-clamp prep when sheet already marks sent rows', () => {
    const purchasedByAsin = new Map();
    const arrivedByAsin = new Map([
      [
        'B0A',
        { qty: 5, cost: 35, unitCostWeight: 35, unitCostQty: 5 },
      ],
    ]);
    const sheetSentByAsin = new Map([['B0A', 5]]);
    const tot = sumSheetAwareStockCostPipeline({
      skuRows: [
        {
          asin: 'B0A',
          availableQty: 3,
          inboundQty: 2,
          unitCost: 7,
        },
      ],
      purchasedByAsin,
      arrivedByAsin,
      sheetSentByAsin,
    });
    // Remaining prep row (5) must stay — held already explained by sheet-sent (5)
    expect(tot.stockForPrepQty).toBe(5);
    expect(tot.stockForPrepCost).toBe(35);
  });

  it('clamps prep by Amazon held — sent-in leaves prep (exclusivity)', () => {
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
    // prep = 10 delivered − 5 amazon held = 5 × £7
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

  it('does not keep historical delivered-as-prep after units are fully at Amazon', () => {
    const arrivedByAsin = new Map([
      [
        'B0OLD',
        { qty: 100, cost: 15000, unitCostWeight: 15000, unitCostQty: 100 },
      ],
    ]);
    const tot = sumSheetAwareStockCostPipeline({
      skuRows: [
        {
          asin: 'B0OLD',
          availableQty: 40,
          inboundQty: 60,
          unitCost: 150,
        },
      ],
      purchasedByAsin: new Map(),
      arrivedByAsin,
    });
    expect(tot.stockForPrepQty).toBe(0);
    expect(tot.stockForPrepCost).toBe(0);
    expect(tot.availableStockCost + tot.stockSentCost).toBe(15000);
  });
});
