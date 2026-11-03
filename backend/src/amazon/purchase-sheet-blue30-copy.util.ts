import {
  findAsinColumnIndex,
  findHeaderColumnIndex,
} from './purchase-sheet-cogs.util';
import { normalizeShipDestinationLabel } from './purchase-sheet-order-write.service';

/** Live BLUE30 COPY SHEET header (paste-ready Blue30 Inbound layout). */
export const BLUE30_COPY_DEFAULT_HEADER = [
  'Date',
  'Order Reference',
  'Courier Tracking Number',
  'Supplier',
  'Amazon Product Name',
  'ASIN',
  'SKU',
  'Quantity',
  'Home/Prep',
] as const;

/** Short UK DD/MM to match the existing BLUE30 COPY SHEET style. */
export function formatBlue30CopyDate(iso: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '').trim());
  if (day) {
    return `${Number(day[3])}/${Number(day[2])}`;
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

export function buildBlue30CopyRowForHeader(
  header: string[],
  data: {
    date: string;
    orderReference: string;
    courierTracking?: string;
    supplier: string;
    productName: string;
    asin: string;
    sku?: string;
    quantity: number;
    homePrep: string;
  },
): (string | number)[] {
  // Don't touch the sticky address / notes columns after Home/Prep.
  const homePrepIdx = findHeaderColumnIndex(header, ['Home/Prep', 'Prep']);
  const width =
    homePrepIdx >= 0
      ? homePrepIdx + 1
      : Math.min(header.length || BLUE30_COPY_DEFAULT_HEADER.length, 9);
  const row: (string | number)[] = new Array(width).fill('');
  const set = (names: string[], value: string | number) => {
    const idx = findHeaderColumnIndex(header, names);
    if (idx >= 0 && idx < width && value !== '' && value != null) {
      row[idx] = value;
    }
  };

  set(['Date'], data.date);
  set(
    ['Order Reference', 'Order Ref', 'Order Num', 'Order Number', 'Order #'],
    data.orderReference,
  );
  if (data.courierTracking) {
    set(
      [
        'Courier Tracking Number',
        'Courier / Tracking Number',
        'Courier Tracking',
        'Tracking Number',
        'Tracking',
      ],
      data.courierTracking,
    );
  }
  set(['Supplier', 'Suppliers'], data.supplier);
  set(
    ['Amazon Product Name', 'Product Name', 'Product', 'Title'],
    data.productName,
  );
  const asinIdx = findAsinColumnIndex(header);
  if (asinIdx >= 0 && asinIdx < width) row[asinIdx] = data.asin;
  else set(['ASIN', 'Asin'], data.asin);
  if (data.sku) set(['SKU', 'Seller SKU'], data.sku);
  set(['Quantity', 'Qty', 'Units'], data.quantity);
  set(['Home/Prep', 'Prep'], data.homePrep);
  return row;
}

export function resolveBlue30CopyHomePrep(raw: unknown): 'HOME' | 'PREP CENTER' {
  const n = normalizeShipDestinationLabel(raw);
  return n === 'HOME' ? 'HOME' : 'PREP CENTER';
}
