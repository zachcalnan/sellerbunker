import {
  buildPrepInboundLinesFromIngest,
  buildPrepInboundRowForHeader,
  collectPrepInboundExistingKeys,
  findPrepInboundHeaderRowIndex,
  findPrepInboundNextEmptyRow1Based,
  formatPrepInboundDate,
  prepInboundDuplicateKey,
} from './prep-center-inbound-sheet.util';

describe('prep-center-inbound-sheet.util', () => {
  it('formats UK DD/MM/YYYY without timezone shift', () => {
    expect(formatPrepInboundDate('2026-05-08')).toBe('8/5/2026');
    expect(formatPrepInboundDate('2026-12-01T23:00:00.000Z')).toBe('1/12/2026');
  });

  it('maps ledger + dto lines including sku/bundle without requiring unit cost', () => {
    const lines = buildPrepInboundLinesFromIngest({
      ledgerLines: [
        {
          lineIndex: 1,
          status: 'created',
          asin: 'B08RYNPNXX',
          productTitle: 'DB Title',
        },
        {
          lineIndex: 2,
          status: 'skipped',
          asin: 'B07RM5DCYY',
        },
      ],
      dtoLines: [
        {
          asin: 'B08RYNPNXX',
          productTitle: 'OS-1 BODY',
          qty: 4,
          sku: 'OS1-BODY',
          bundleSize: 1,
        },
        {
          asin: 'B07RM5DCYY',
          productTitle: 'Otamatone',
          qty: 10,
          sku: 'OTA-10',
        },
      ],
    });

    expect(lines).toEqual([
      {
        asin: 'B08RYNPNXX',
        productTitle: 'OS-1 BODY',
        sku: 'OS1-BODY',
        qty: 4,
        bundleOf: 1,
      },
      {
        asin: 'B07RM5DCYY',
        productTitle: 'Otamatone',
        sku: 'OTA-10',
        qty: 10,
        bundleOf: null,
      },
    ]);
  });

  it('finds header below branding rows', () => {
    const values = [
      ['BLUE | 30', '', ''],
      ['Inbound', '', ''],
      [
        'Date',
        'Order Reference',
        'Courier Tracking Number',
        'Supplier',
        'Amazon Product Name',
        'ASIN',
        'SKU',
        'Quantity',
        'Bundle Of',
        'Notes',
      ],
      ['5/5/2026', '#R113', '', 'Healf', 'OS-1', 'B08RYNPNXX', '4', '4', '', ''],
    ];
    expect(findPrepInboundHeaderRowIndex(values)).toBe(2);
  });

  it('builds a row aligned to Blue30 Inbound headers', () => {
    const header = [
      'Date',
      'Order Reference',
      'Courier Tracking Number',
      'Supplier',
      'Amazon Product Name',
      'ASIN',
      'SKU',
      'Quantity',
      'Bundle Of',
      'Notes',
    ];
    const row = buildPrepInboundRowForHeader(header, {
      date: '8/5/2026',
      orderReference: '#R113M3PVKK',
      courierTracking: 'TRACK123',
      supplier: 'Healf',
      productName: 'OS-1 BODY',
      asin: 'B08RYNPNXX',
      sku: 'OS1-BODY',
      quantity: 4,
      bundleOf: 1,
      notes: 'SB bot',
    });
    expect(row).toEqual([
      '8/5/2026',
      '#R113M3PVKK',
      'TRACK123',
      'Healf',
      'OS-1 BODY',
      'B08RYNPNXX',
      'OS1-BODY',
      4,
      1,
      'SB bot',
    ]);
  });

  it('dedupes on order reference + ASIN', () => {
    const header = [
      'Date',
      'Order Reference',
      'Supplier',
      'Amazon Product Name',
      'ASIN',
      'Quantity',
    ];
    const values = [
      header,
      ['5/5/2026', '#R1', 'Healf', 'A', 'B08RYNPNXX', '4'],
    ];
    const keys = collectPrepInboundExistingKeys(values, 0, header);
    expect(keys.has(prepInboundDuplicateKey('#R1', 'B08RYNPNXX'))).toBe(true);
    expect(keys.has(prepInboundDuplicateKey('#R1', 'B0OTHER'))).toBe(false);
  });

  it('limits writable columns so protected Blue30 cols are not touched', () => {
    const header = [
      'Date',
      'Order Reference',
      'Courier Tracking Number',
      'Supplier',
      'Amazon Product Name',
      'ASIN',
      'SKU',
      'Quantity',
      'Bundle Of',
      'Drop Down Information',
      'Notes',
      'Added to SC',
      'Check-in Tracking Numbers',
      'Quantity Received',
    ];
    const row = buildPrepInboundRowForHeader(header, {
      date: '8/5/2026',
      orderReference: '#R1',
      supplier: 'Healf',
      productName: 'OS-1',
      asin: 'B08RYNPNXX',
      quantity: 4,
      notes: 'SB bot',
    });
    expect(row).toHaveLength(12);
    expect(row[0]).toBe('8/5/2026');
    expect(row[5]).toBe('B08RYNPNXX');
  });

  it('finds next empty row after data, skipping spacer under header', () => {
    const header = [
      'Date',
      'Order Reference',
      'Supplier',
      'Amazon Product Name',
      'ASIN',
      'Quantity',
    ];
    const values = [
      ['BLUE'],
      header,
      [], // spacer
      ['5/5/2026', '#R1', 'Healf', 'A', 'B08RYNPNXX', '4'],
      ['8/6/2026', '#R2', 'Healf', 'B', 'B07RM5DCYY', '2'],
    ];
    expect(findPrepInboundNextEmptyRow1Based(values, 1, header)).toBe(6);
  });
});
