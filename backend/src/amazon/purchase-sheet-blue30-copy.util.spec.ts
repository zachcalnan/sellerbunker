import {
  buildBlue30CopyRowForHeader,
  formatBlue30CopyDate,
  resolveBlue30CopyHomePrep,
} from './purchase-sheet-blue30-copy.util';

describe('purchase-sheet-blue30-copy.util', () => {
  it('formats short UK DD/MM dates', () => {
    expect(formatBlue30CopyDate('2026-05-08')).toBe('8/5');
    expect(formatBlue30CopyDate('2026-11-29')).toBe('29/11');
  });

  it('builds a paste-ready row aligned to BLUE30 COPY SHEET headers', () => {
    const header = [
      'Date',
      'Order Reference          ',
      'Courier Tracking Number',
      'Supplier         ',
      'Amazon Product Name                                               ',
      'ASIN',
      'SKU',
      'Quantity ',
      'Home/Prep',
      'Zach address block…',
    ];
    const row = buildBlue30CopyRowForHeader(header, {
      date: '8/9',
      orderReference: '#R113',
      courierTracking: 'TRACK1',
      supplier: 'Healf',
      productName: 'OS-1 BODY',
      asin: 'B0BRYNPN93',
      sku: 'OS1',
      quantity: 4,
      homePrep: 'PREP CENTER',
    });
    expect(row).toEqual([
      '8/9',
      '#R113',
      'TRACK1',
      'Healf',
      'OS-1 BODY',
      'B0BRYNPN93',
      'OS1',
      4,
      'PREP CENTER',
    ]);
  });

  it('maps ship destination labels', () => {
    expect(resolveBlue30CopyHomePrep('HOME')).toBe('HOME');
    expect(resolveBlue30CopyHomePrep('blue30')).toBe('PREP CENTER');
    expect(resolveBlue30CopyHomePrep('')).toBe('PREP CENTER');
  });
});
