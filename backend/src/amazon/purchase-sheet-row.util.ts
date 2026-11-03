import {
  findAsinColumnIndex,
  findHeaderColumnIndex,
  findUnitCostColumnIndex,
} from './purchase-sheet-cogs.util';

/** Build one CURRENT ORDERS row aligned to the live header. */
export function buildPurchaseSheetRowForHeader(
  header: string[],
  data: {
    date: string;
    asin: string;
    product: string;
    orderNum: string;
    orderCost: number;
    units: number;
    unitCost: number;
    supplier: string;
    notes: string;
    /** Live sheet: HOME or PREP CENTER (not a £ amount). */
    homePrep: string | number;
  },
): (string | number)[] {
  const row: (string | number)[] = new Array(header.length).fill('');
  const set = (names: string[], value: string | number) => {
    const idx = findHeaderColumnIndex(header, names);
    if (idx >= 0) row[idx] = value;
  };
  set(['Date', 'Purchase date', 'Order date'], data.date);
  const asinIdx = findAsinColumnIndex(header);
  if (asinIdx >= 0) row[asinIdx] = data.asin;
  else set(['ASIN', 'Asin'], data.asin);
  set(['Product', 'Title'], data.product);
  set(['Order Num', 'Order Number', 'Order #'], data.orderNum);
  set(['Order Cost', 'Total cost'], data.orderCost);
  set(['Units', 'Qty', 'Quantity'], data.units);
  const unitIdx = findUnitCostColumnIndex(header);
  if (unitIdx >= 0) row[unitIdx] = data.unitCost;
  else set(['£/Unit', 'Unit cost', 'Cost/Unit'], data.unitCost);
  set(['Supplier', 'Suppliers'], data.supplier);
  set(['Notes', 'Note'], data.notes);
  set(['Home/Prep', 'Prep'], data.homePrep);
  set(['Delivered', 'Delivered '], 'No');
  return row;
}
