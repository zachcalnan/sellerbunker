import {
  buildLatestAsinUnitCostsFromSheet,
  colIndexToA1,
  decideOpsCells,
  fifoAllocateByAsin,
  findUnitCostColumnIndex,
  parseSheetDate,
  parseSheetMoney,
  parseSheetPurchaseRows,
  shouldPreserveExistingCogs,
} from './purchase-sheet-cogs.util';

describe('purchase-sheet-cogs.util', () => {
  it('parses £ unit costs', () => {
    expect(parseSheetMoney('£32.40')).toBe(32.4);
    expect(parseSheetMoney('1,234.56')).toBe(1234.56);
    expect(parseSheetMoney('')).toBeNull();
    expect(parseSheetMoney(0)).toBeNull();
  });

  it('parses UK DD/MM/YYYY and legacy unambiguous US M/D/YYYY', () => {
    expect(parseSheetDate('13/11/2026')?.toISOString().slice(0, 10)).toBe(
      '2026-11-13',
    );
    expect(parseSheetDate('8/5/2026')?.toISOString().slice(0, 10)).toBe(
      '2026-05-08',
    );
    // Second part >12 ⇒ legacy US rows from older writes
    expect(parseSheetDate('11/13/2026')?.toISOString().slice(0, 10)).toBe(
      '2026-11-13',
    );
  });

  it('finds £/Unit and not Units', () => {
    const headers = [
      'Date',
      'ASIN',
      'Product',
      'Order Num',
      'Order Cost',
      'Units',
      '£/Unit',
      'Delivered ',
    ];
    expect(findUnitCostColumnIndex(headers)).toBe(6);
  });

  it('keeps latest dated unit cost per ASIN', () => {
    const values = [
      ['Date', 'ASIN', 'Product', 'Units', '£/Unit', 'Supplier'],
      ['29/10/2025', 'B0AAA', 'Old', '2', '£10.00', 'A'],
      ['1/11/2025', 'B0AAA', 'New', '1', '£12.50', 'B'],
      ['30/10/2025', 'B0BBB', 'Other', '1', '£5.00', 'C'],
    ];
    const { costs, errors } = buildLatestAsinUnitCostsFromSheet(
      'CURRENT ORDERS',
      values,
    );
    expect(errors).toEqual([]);
    expect(costs.get('B0AAA')?.unitCostIncVat).toBe(12.5);
    expect(costs.get('B0AAA')?.supplier).toBe('B');
    expect(costs.get('B0BBB')?.unitCostIncVat).toBe(5);
  });

  it('preserves manual/legacy costs but not sheet-sourced', () => {
    expect(
      shouldPreserveExistingCogs({ costOfGoods: 10, cogsSource: 'manual' }),
    ).toBe(true);
    expect(
      shouldPreserveExistingCogs({ costOfGoods: 10, cogsSource: null }),
    ).toBe(true);
    expect(
      shouldPreserveExistingCogs({ costOfGoods: 10, cogsSource: 'sheet' }),
    ).toBe(false);
    expect(
      shouldPreserveExistingCogs({ costOfGoods: null, cogsSource: null }),
    ).toBe(false);
  });

  it('converts column index to A1', () => {
    expect(colIndexToA1(0)).toBe('A');
    expect(colIndexToA1(6)).toBe('G');
    expect(colIndexToA1(26)).toBe('AA');
  });

  it('FIFO allocates shipped/sold across same-ASIN rows by date', () => {
    const values = [
      ['Date', 'ASIN', 'Units', '£/Unit', 'Delivered ', ' to AMZ', 'Final'],
      ['1/10/2025', 'B0AAA', '5', '£10', '', '', ''],
      ['1/11/2025', 'B0AAA', '3', '£11', '', '', ''],
      ['15/10/2025', 'B0BBB', '2', '£5', '', '', ''],
    ];
    const { rows } = parseSheetPurchaseRows(values);
    const pool = new Map([
      ['B0AAA', 7],
      ['B0BBB', 1],
    ]);
    const alloc = fifoAllocateByAsin(rows, pool);
    expect(alloc.get(1)).toBe(5);
    expect(alloc.get(2)).toBe(2);
    expect(alloc.get(3)).toBe(1);
  });

  it('sets Delivered/to AMZ/Final from shipment and sold signals', () => {
    const d1 = decideOpsCells({
      units: 5,
      shippedAlloc: 5,
      receivedAlloc: 5,
      soldAlloc: 5,
      existingDelivered: 'No',
      existingToAmz: '',
      existingFinal: '',
    });
    expect(d1.delivered).toBe('Yes');
    expect(d1.toAmz).toBe('Sent');
    expect(d1.final).toBe('Complete');

    const d2 = decideOpsCells({
      units: 5,
      shippedAlloc: 2,
      receivedAlloc: 0,
      soldAlloc: 0,
      existingDelivered: '',
      existingToAmz: '',
      existingFinal: '',
    });
    expect(d2.delivered).toBe('Yes');
    expect(d2.toAmz).toBe('Sent (2/5)');
    expect(d2.final).toBeNull();

    const d3 = decideOpsCells({
      units: 5,
      shippedAlloc: 5,
      receivedAlloc: 5,
      soldAlloc: 5,
      existingDelivered: 'Yes',
      existingToAmz: 'Sent',
      existingFinal: 'Returned',
    });
    expect(d3.delivered).toBeNull();
    expect(d3.toAmz).toBeNull();
    expect(d3.final).toBeNull();
  });
});
