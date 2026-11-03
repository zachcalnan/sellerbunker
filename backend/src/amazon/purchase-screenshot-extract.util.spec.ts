import {
  normalizeAsin,
  normalizePurchaseDate,
  parseShipDestination,
  parseVisionPurchaseJson,
  splitQtyPrefixFromTitle,
  stripJsonFence,
  tryParsePurchaseDate,
} from './purchase-screenshot-extract.util';

describe('purchase-screenshot-extract.util', () => {
  it('strips markdown fences', () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('normalizes UK and ISO dates', () => {
    expect(normalizePurchaseDate('7/9/2026')).toBe('2026-09-07');
    expect(normalizePurchaseDate('2026-09-07T12:00:00Z')).toBe('2026-09-07');
  });

  it('parses written UK/US month-name dates', () => {
    expect(tryParsePurchaseDate('8 September 2026')).toBe('2026-09-08');
    expect(tryParsePurchaseDate('8th Sept 2026')).toBe('2026-09-08');
    expect(tryParsePurchaseDate('September 8, 2026')).toBe('2026-09-08');
    expect(tryParsePurchaseDate('Sep 8 2026')).toBe('2026-09-08');
    expect(tryParsePurchaseDate(null)).toBeUndefined();
    expect(tryParsePurchaseDate('')).toBeUndefined();
  });

  it('parses HOME vs PREP CENTER from address hints', () => {
    expect(parseShipDestination('HOME')).toBe('HOME');
    expect(parseShipDestination('prep_center')).toBe('PREP CENTER');
    expect(
      parseShipDestination(null, 'Blue30, Great Stambridge Hall, Rochford'),
    ).toBe('PREP CENTER');
    expect(parseShipDestination(null, '12 Example Road, London')).toBe(
      undefined,
    );
    expect(parseShipDestination('home', 'personal home address')).toBe('HOME');
  });

  it('warns when purchase date is missing from model JSON', () => {
    const draft = parseVisionPurchaseJson(
      JSON.stringify({
        supplier: 'Healf',
        orderNumber: 'H-2398543',
        purchaseDate: null,
        currency: 'GBP',
        orderTotalIncVat: 284.97,
        lines: [],
      }),
      new Date('2026-09-08T12:00:00Z'),
    );
    expect(draft.purchaseDate).toBe('2026-09-08');
    expect(
      draft.warnings.some((w) => /purchase date not found/i.test(w)),
    ).toBe(true);
  });

  it('reads orderDate alias fields and shipDestination', () => {
    const draft = parseVisionPurchaseJson(
      JSON.stringify({
        supplier: 'Healf',
        orderNumber: 'H-1',
        orderDate: '8 September 2026',
        shipDestination: 'PREP CENTER',
        shippingAddress: 'Blue30, Great Stambridge Hall',
        lines: [{ productTitle: 'X', qty: 1, unitCostIncVat: 10 }],
      }),
    );
    expect(draft.purchaseDate).toBe('2026-09-08');
    expect(draft.shipDestination).toBe('PREP CENTER');
  });

  it('normalizes ASINs', () => {
    expect(normalizeAsin('b0bx4px242')).toBe('B0BX4PX242');
    expect(normalizeAsin('see B0BX4PX242 here')).toBe('B0BX4PX242');
    expect(normalizeAsin('nope')).toBeUndefined();
  });

  it('parses Healf-style confirmation JSON and detects 4-for-3', () => {
    const draft = parseVisionPurchaseJson(
      JSON.stringify({
        supplier: 'Healf',
        orderNumber: 'H-2788542',
        purchaseDate: '07/09/2026',
        currency: 'GBP',
        promo: { type: 'none' },
        lines: [
          {
            productTitle: 'OneSkin OS-01 EYE',
            asin: null,
            qty: 4,
            unitRrpIncVat: 94.99,
            unitCostIncVat: 71.2425,
            lineTotalIncVat: 284.97,
          },
        ],
        warnings: [],
      }),
      new Date('2026-09-07T12:00:00Z'),
    );

    expect(draft.supplier).toBe('Healf');
    expect(draft.orderNumber).toBe('H-2788542');
    expect(draft.purchaseDate).toBe('2026-09-07');
    expect(draft.promo?.type).toBe('buy_3_get_1_free');
    expect(draft.lines[0].qty).toBe(4);
    expect(draft.warnings.some((w) => /ASIN missing/i.test(w))).toBe(true);
    expect(draft.warnings.some((w) => /ship-to not clear/i.test(w))).toBe(true);
  });

  it('derives unit cost from line total', () => {
    const draft = parseVisionPurchaseJson(
      JSON.stringify({
        supplier: 'Healf',
        orderNumber: 'H-1',
        purchaseDate: '2026-09-01',
        shipDestination: 'HOME',
        lines: [{ productTitle: 'X', qty: 2, lineTotalIncVat: 100 }],
      }),
    );
    expect(draft.lines[0].unitCostIncVat).toBe(50);
    expect(draft.shipDestination).toBe('HOME');
  });

  it('recovers Healf order-summary totals when lines are empty', () => {
    const draft = parseVisionPurchaseJson(
      JSON.stringify({
        supplier: 'Healf',
        orderNumber: 'H-2788542',
        purchaseDate: '2026-09-07',
        currency: 'GBP',
        orderTotalIncVat: 284.97,
        originalTotalIncVat: 379.96,
        promo: { type: 'none' },
        lines: [],
        warnings: ['No product lines found in the image.'],
      }),
    );

    expect(draft.promo?.type).toBe('buy_3_get_1_free');
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0].qty).toBe(4);
    expect(draft.lines[0].unitRrpIncVat).toBe(94.99);
    expect(draft.lines[0].unitCostIncVat).toBe(71.24);
    expect(draft.lines[0].lineTotalIncVat).toBe(284.97);
    expect(
      draft.warnings.some((w) => /no product lines found/i.test(w)),
    ).toBe(false);
  });

  it('accepts missing order number with placeholder (Thomann success screen)', () => {
    const draft = parseVisionPurchaseJson(
      JSON.stringify({
        supplier: 'Thomann',
        orderNumber: null,
        purchaseDate: null,
        currency: 'GBP',
        orderTotalIncVat: 249,
        promo: { type: 'none' },
        shippingAddress:
          'B300, Blue30, Great stambridge hall, SS4 2BF Essex, United Kingdom',
        lines: [
          {
            productTitle: '10x Otamatone Classic White',
            qty: null,
            lineTotalIncVat: 249,
            deliveryCostIncVat: 0,
          },
        ],
      }),
      new Date('2026-09-09T12:00:00Z'),
    );

    expect(draft.supplier).toBe('Thomann');
    expect(draft.orderNumber).toMatch(/^PENDING-20260909$/);
    expect(draft.shipDestination).toBe('PREP CENTER');
    expect(draft.promo?.type).toBe('none');
    expect(draft.lines[0].productTitle).toBe('Otamatone Classic White');
    expect(draft.lines[0].qty).toBe(10);
    expect(draft.lines[0].unitCostIncVat).toBe(24.9);
    expect(draft.lines[0].lineTotalIncVat).toBe(249);
    expect(
      draft.warnings.some((w) => /order number not visible/i.test(w)),
    ).toBe(true);
  });

  it('splits qty prefix from product titles', () => {
    expect(splitQtyPrefixFromTitle('10x Otamatone Classic White')).toEqual({
      title: 'Otamatone Classic White',
      qty: 10,
    });
    expect(splitQtyPrefixFromTitle('Otamatone Classic White')).toEqual({
      title: 'Otamatone Classic White',
    });
  });

  it('recovers iHerb-style qty from Landmark (8 items) when lines lack qty', () => {
    const draft = parseVisionPurchaseJson(
      JSON.stringify({
        supplier: 'iHerb',
        orderNumber: '556284648',
        purchaseDate: null,
        currency: 'GBP',
        orderTotalIncVat: 122.98,
        shippingMethod: 'Landmark (8 items)',
        itemCount: 8,
        shippingAddress:
          'B300, Blue30, Great stambridge hall, Essex, United Kingdom SS4 2BF',
        productTitle: "PURA D'OR Anti-Thinning Biotin Shampoo",
        lines: [],
      }),
      new Date('2026-09-09T12:00:00Z'),
    );

    expect(draft.supplier).toBe('iHerb');
    expect(draft.orderNumber).toBe('556284648');
    expect(draft.shipDestination).toBe('PREP CENTER');
    expect(draft.lines[0].qty).toBe(8);
    expect(draft.lines[0].unitCostIncVat).toBe(15.37);
    expect(draft.lines[0].productTitle).toMatch(/PURA/i);
  });
});
