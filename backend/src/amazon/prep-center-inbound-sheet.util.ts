import {
  findAsinColumnIndex,
  findHeaderColumnIndex,
  normalizeHeader,
} from './purchase-sheet-cogs.util';

export type PrepInboundLineInput = {
  asin: string;
  productTitle?: string | null;
  sku?: string | null;
  qty: number;
  bundleOf?: number | null;
};

export type PrepInboundAppendInput = {
  supplier: string;
  orderNumber: string;
  purchaseDate: string;
  courierTracking?: string | null;
  notes?: string | null;
  lines: PrepInboundLineInput[];
};

export type PrepInboundLedgerLine = {
  lineIndex: number;
  status: 'created' | 'skipped' | string;
  asin?: string;
  productTitle?: string | null;
};

export type PrepInboundDtoLine = {
  asin?: string;
  sku?: string;
  productTitle?: string;
  qty: number;
  bundleSize?: number;
};

/**
 * Map supplier-order ingest ledger + DTO into Blue30 Inbound rows.
 * Unlike the purchase sheet, unit cost is not required.
 */
export function buildPrepInboundLinesFromIngest(opts: {
  ledgerLines: PrepInboundLedgerLine[];
  dtoLines: PrepInboundDtoLine[];
}): PrepInboundLineInput[] {
  const out: PrepInboundLineInput[] = [];

  for (const ledgerLine of opts.ledgerLines) {
    if (ledgerLine.status !== 'created' && ledgerLine.status !== 'skipped') {
      continue;
    }
    const dtoLine = opts.dtoLines[ledgerLine.lineIndex - 1];
    const asin = (ledgerLine.asin || dtoLine?.asin || '')
      .trim()
      .replace(/\s/g, '')
      .toUpperCase();
    if (!asin) continue;

    const qty = Math.max(1, Math.floor(Number(dtoLine?.qty ?? 1) || 1));
    const title =
      dtoLine?.productTitle?.trim() ||
      ledgerLine.productTitle?.trim() ||
      null;
    const sku = dtoLine?.sku?.trim() || null;
    const bundle =
      dtoLine?.bundleSize != null && Number(dtoLine.bundleSize) > 0
        ? Math.floor(Number(dtoLine.bundleSize))
        : null;

    out.push({
      asin,
      productTitle: title,
      sku,
      qty,
      bundleOf: bundle,
    });
  }

  return out;
}

/** UK-style DD/MM/YYYY for Blue30 Inbound (prep centre is UK). */
export function formatPrepInboundDate(iso: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '').trim());
  if (day) {
    return `${Number(day[3])}/${Number(day[2])}/${day[1]}`;
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`;
}

/**
 * Blue30 Inbound often has branding rows above the table.
 * Find the first row that looks like the column header.
 */
export function findPrepInboundHeaderRowIndex(values: string[][]): number {
  const maxScan = Math.min(values.length, 40);
  for (let r = 0; r < maxScan; r++) {
    const header = (values[r] ?? []).map((h) => String(h ?? ''));
    const asinIdx = findAsinColumnIndex(header);
    const orderIdx = findHeaderColumnIndex(header, [
      'Order Reference',
      'Order Ref',
      'Order Num',
      'Order Number',
      'Order #',
    ]);
    const dateIdx = findHeaderColumnIndex(header, ['Date']);
    const supplierIdx = findHeaderColumnIndex(header, ['Supplier']);
    if (asinIdx >= 0 && (orderIdx >= 0 || (dateIdx >= 0 && supplierIdx >= 0))) {
      return r;
    }
  }
  return -1;
}

/**
 * Blue30 protects columns from "Added to SC" onward (check-in, received,
 * cartons, dims). Client bots may only write A→L style intake columns.
 * Default: stop after Notes / Added to SC (first 12 cols on the live sheet).
 */
export const PREP_INBOUND_WRITABLE_COLUMN_LIMIT = 12;

/** Build one Inbound row aligned to the live header (writable cols only). */
export function buildPrepInboundRowForHeader(
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
    bundleOf?: number | null;
    notes?: string;
  },
  writableColumnLimit: number = PREP_INBOUND_WRITABLE_COLUMN_LIMIT,
): (string | number)[] {
  const width = Math.min(
    Math.max(header.length, 1),
    Math.max(writableColumnLimit, 1),
  );
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
  if (data.bundleOf != null && data.bundleOf > 0) {
    set(['Bundle Of', 'Bundle', 'Bundle Size'], data.bundleOf);
  }
  if (data.notes) set(['Notes', 'Note'], data.notes);
  return row;
}

/**
 * Next 1-based sheet row after the last inbound data line (has order ref or ASIN).
 * Skips blank spacer rows between the header and the data block.
 */
export function findPrepInboundNextEmptyRow1Based(
  values: string[][],
  headerRowIndex: number,
  header: string[],
): number {
  const asinIdx = findAsinColumnIndex(header);
  const orderIdx = findHeaderColumnIndex(header, [
    'Order Reference',
    'Order Ref',
    'Order Num',
    'Order Number',
    'Order #',
  ]);
  let lastData = headerRowIndex;
  for (let r = headerRowIndex + 1; r < values.length; r++) {
    const row = values[r] ?? [];
    const asin =
      asinIdx >= 0
        ? String(row[asinIdx] ?? '')
            .trim()
            .toUpperCase()
        : '';
    const order =
      orderIdx >= 0 ? String(row[orderIdx] ?? '').trim() : '';
    if (asin && normalizeHeader(asin) === 'asin') continue;
    if (asin || order) lastData = r;
  }
  return lastData + 2; // 0-based lastData → next empty as 1-based
}

export function prepInboundDuplicateKey(
  orderReference: string,
  asin: string,
): string {
  return `${orderReference.trim()}::${asin.trim().toUpperCase()}`;
}

export function collectPrepInboundExistingKeys(
  values: string[][],
  headerRowIndex: number,
  header: string[],
): Set<string> {
  const asinIdx = findAsinColumnIndex(header);
  const orderIdx = findHeaderColumnIndex(header, [
    'Order Reference',
    'Order Ref',
    'Order Num',
    'Order Number',
    'Order #',
  ]);
  const existing = new Set<string>();
  if (asinIdx < 0) return existing;
  for (let r = headerRowIndex + 1; r < values.length; r++) {
    const row = values[r] ?? [];
    const asin = String(row[asinIdx] ?? '')
      .trim()
      .toUpperCase();
    if (!asin) continue;
    // Skip stray title / section rows that re-echo headers.
    if (normalizeHeader(asin) === 'asin') continue;
    const orderNum =
      orderIdx >= 0 ? String(row[orderIdx] ?? '').trim() : '';
    existing.add(prepInboundDuplicateKey(orderNum, asin));
  }
  return existing;
}
