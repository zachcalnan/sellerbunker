import { buildPurchaseSheetRowForHeader } from './purchase-sheet-row.util';

describe('buildPurchaseSheetRowForHeader', () => {
  it('maps core columns including £/Unit and Delivered', () => {
    const header = [
      'Date',
      'ASIN',
      'Product',
      'Order Num',
      'Order Cost',
      'Units',
      '£/Unit',
      'Delivered ',
      'Supplier',
      'Notes',
      'Home/Prep',
    ];
    const row = buildPurchaseSheetRowForHeader(header, {
      date: '9/8/2026',
      asin: 'B0TESTASIN',
      product: 'OneSkin OS-01 Eye',
      orderNum: 'HEALF-123',
      orderCost: 257.97,
      units: 4,
      unitCost: 64.49,
      supplier: 'Healf',
      notes: 'SB bot',
      homePrep: 'HOME',
    });

    expect(row[0]).toBe('9/8/2026');
    expect(row[1]).toBe('B0TESTASIN');
    expect(row[2]).toBe('OneSkin OS-01 Eye');
    expect(row[3]).toBe('HEALF-123');
    expect(row[4]).toBe(257.97);
    expect(row[5]).toBe(4);
    expect(row[6]).toBe(64.49);
    expect(row[7]).toBe('No');
    expect(row[8]).toBe('Healf');
    expect(row[9]).toBe('SB bot');
    expect(row[10]).toBe('HOME');
  });

  it('does not put unit cost into the Units column', () => {
    const header = ['ASIN', 'Units', '£/Unit', 'Product'];
    const row = buildPurchaseSheetRowForHeader(header, {
      date: '',
      asin: 'B0AAA',
      product: 'P',
      orderNum: '1',
      orderCost: 20,
      units: 2,
      unitCost: 10,
      supplier: 'S',
      notes: '',
      homePrep: 'PREP CENTER',
    });
    expect(row[1]).toBe(2);
    expect(row[2]).toBe(10);
  });
});
