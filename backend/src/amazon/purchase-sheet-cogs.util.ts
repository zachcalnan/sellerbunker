/** Parse spreadsheet money like "£32.40", "32.40", "1,234.56". */
export function parseSheetMoney(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) / 100 : null;
  }
  const s = String(raw)
    .trim()
    .replace(/£/g, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

export function normalizeHeader(h: unknown): string {
  return String(h ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** Prefer £/Unit (not Units). */
export function findUnitCostColumnIndex(headers: string[]): number {
  const norms = headers.map(normalizeHeader);
  const preferred = ['£/unit', '£unit', 'gbp/unit', 'unitcost', 'cost/unit', 'costperunit'];
  for (let i = 0; i < norms.length; i++) {
    if (preferred.includes(norms[i])) return i;
  }
  for (let i = 0; i < norms.length; i++) {
    const n = norms[i];
    if (n === 'units' || n === 'unit') continue;
    if (n.includes('£/unit') || n.includes('/unit') || n.includes('unitcost')) {
      return i;
    }
  }
  return -1;
}

export function findAsinColumnIndex(headers: string[]): number {
  const norms = headers.map(normalizeHeader);
  const i = norms.findIndex((n) => n === 'asin' || n === 'asin1' || n === 'amazonasin');
  return i;
}

export function findDateColumnIndex(headers: string[]): number {
  const norms = headers.map(normalizeHeader);
  return norms.findIndex((n) => n === 'date' || n === 'purchasedate' || n === 'orderdate');
}

export function parseSheetDate(raw: unknown): Date | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Excel serial day
    const excelEpoch = Date.UTC(1899, 11, 30);
    const d = new Date(excelEpoch + raw * 86400000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(raw).trim();
  if (!s) return null;
  // Numeric slash dates: prefer UK D/M/YYYY. If the second part is >12,
  // treat as legacy US M/D/YYYY from older sheet writes.
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const year = Number(slash[3]);
    const day = b > 12 ? b : a;
    const month = b > 12 ? a : b;
    const d = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type SheetAsinUnitCost = {
  asin: string;
  unitCostIncVat: number;
  purchaseDate: Date | null;
  productTitle: string | null;
  supplier: string | null;
  sheetRowIndex: number; // 1-based sheet row (header = 1)
  tabTitle: string;
};

/**
 * Build latest unit cost per ASIN from sheet rows (header + body).
 * Later / newer dates win.
 */
export function buildLatestAsinUnitCostsFromSheet(
  tabTitle: string,
  values: unknown[][],
): { costs: Map<string, SheetAsinUnitCost>; header: string[]; errors: string[] } {
  const errors: string[] = [];
  const costs = new Map<string, SheetAsinUnitCost>();
  if (!values?.length) {
    return { costs, header: [], errors: ['empty sheet'] };
  }
  const header = (values[0] ?? []).map((h) => String(h ?? ''));
  const asinIdx = findAsinColumnIndex(header);
  const unitIdx = findUnitCostColumnIndex(header);
  const dateIdx = findDateColumnIndex(header);
  const productIdx = header.findIndex((h) => normalizeHeader(h) === 'product');
  const supplierIdx = header.findIndex((h) => {
    const n = normalizeHeader(h);
    return n === 'supplier' || n === 'suppliers';
  });

  if (asinIdx < 0) errors.push(`${tabTitle}: ASIN column not found`);
  if (unitIdx < 0) errors.push(`${tabTitle}: £/Unit column not found`);
  if (asinIdx < 0 || unitIdx < 0) {
    return { costs, header, errors };
  }

  for (let r = 1; r < values.length; r++) {
    const row = values[r] ?? [];
    const asin = String(row[asinIdx] ?? '')
      .trim()
      .toUpperCase();
    if (!asin || asin === '-' || asin === 'N/A') continue;
    const unitCostIncVat = parseSheetMoney(row[unitIdx]);
    if (unitCostIncVat == null) continue;
    const purchaseDate = dateIdx >= 0 ? parseSheetDate(row[dateIdx]) : null;
    const next: SheetAsinUnitCost = {
      asin,
      unitCostIncVat,
      purchaseDate,
      productTitle:
        productIdx >= 0 && row[productIdx] != null
          ? String(row[productIdx]).trim() || null
          : null,
      supplier:
        supplierIdx >= 0 && row[supplierIdx] != null
          ? String(row[supplierIdx]).trim() || null
          : null,
      sheetRowIndex: r + 1,
      tabTitle,
    };
    const prev = costs.get(asin);
    if (!prev) {
      costs.set(asin, next);
      continue;
    }
    const prevT = prev.purchaseDate?.getTime() ?? 0;
    const nextT = next.purchaseDate?.getTime() ?? 0;
    if (nextT > prevT || (nextT === prevT && next.sheetRowIndex > prev.sheetRowIndex)) {
      costs.set(asin, next);
    }
  }

  return { costs, header, errors };
}

export function colIndexToA1(colIndex0: number): string {
  let n = colIndex0 + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Whether an existing product cost should be left alone. */
export function shouldPreserveExistingCogs(opts: {
  costOfGoods: number | null | undefined;
  cogsSource: string | null | undefined;
}): boolean {
  const cost = opts.costOfGoods == null ? null : Number(opts.costOfGoods);
  const hasCost = cost != null && Number.isFinite(cost) && cost > 0;
  if (!hasCost) return false;
  const src = (opts.cogsSource ?? '').trim().toLowerCase();
  // Explicit sheet/auto sources may be refreshed from the spreadsheet.
  if (src === 'sheet' || src === 'auto_asin') return false;
  // manual, legacy null, or anything else with a cost → do not overwrite.
  return true;
}

export function findHeaderColumnIndex(
  headers: string[],
  candidates: string[],
): number {
  const norms = headers.map(normalizeHeader);
  const candNorms = candidates.map(normalizeHeader);
  for (const c of candNorms) {
    const i = norms.findIndex((n) => n === c);
    if (i >= 0) return i;
  }
  for (let i = 0; i < norms.length; i++) {
    if (candNorms.some((c) => c && norms[i].includes(c))) return i;
  }
  return -1;
}

export function parseSheetUnits(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  const s = String(raw ?? '')
    .trim()
    .replace(/,/g, '');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

export type SheetPurchaseRow = {
  rowIndex0: number; // 0-based in values[] (0 = header)
  sheetRow: number; // 1-based spreadsheet row
  asin: string;
  units: number;
  purchaseDate: Date | null;
};

export function parseSheetPurchaseRows(values: unknown[][]): {
  header: string[];
  rows: SheetPurchaseRow[];
  col: {
    asin: number;
    units: number;
    date: number;
    delivered: number;
    toAmz: number;
    final: number;
  };
} {
  const header = (values[0] ?? []).map((h) => String(h ?? ''));
  const asin = findAsinColumnIndex(header);
  const units = findHeaderColumnIndex(header, ['Units', 'Qty', 'Quantity']);
  const date = findDateColumnIndex(header);
  const delivered = findHeaderColumnIndex(header, ['Delivered']);
  const toAmz = findHeaderColumnIndex(header, [
    'to AMZ',
    'toAMZ',
    'To Amazon',
    'Amazon',
  ]);
  const final = findHeaderColumnIndex(header, [
    'Final',
    'Sold',
    'Complete',
    'Ebay/Return',
  ]);
  const rows: SheetPurchaseRow[] = [];
  if (asin < 0) return { header, rows, col: { asin, units, date, delivered, toAmz, final } };

  for (let r = 1; r < values.length; r++) {
    const row = values[r] ?? [];
    const a = String(row[asin] ?? '')
      .trim()
      .toUpperCase();
    if (!a || a === '-' || a === 'N/A') continue;
    rows.push({
      rowIndex0: r,
      sheetRow: r + 1,
      asin: a,
      units: units >= 0 ? parseSheetUnits(row[units]) : 0,
      purchaseDate: date >= 0 ? parseSheetDate(row[date]) : null,
    });
  }
  return { header, rows, col: { asin, units, date, delivered, toAmz, final } };
}

/**
 * FIFO-allocate a pool of units across purchase rows of the same ASIN
 * (oldest purchaseDate first, then sheet order).
 */
export function fifoAllocateByAsin(
  rows: SheetPurchaseRow[],
  poolByAsin: Map<string, number>,
): Map<number, number> {
  const allocated = new Map<number, number>(); // rowIndex0 -> qty
  const byAsin = new Map<string, SheetPurchaseRow[]>();
  for (const r of rows) {
    const list = byAsin.get(r.asin) ?? [];
    list.push(r);
    byAsin.set(r.asin, list);
  }
  for (const [asin, list] of byAsin) {
    let remaining = Math.max(0, Number(poolByAsin.get(asin) ?? 0) || 0);
    const ordered = [...list].sort((a, b) => {
      const at = a.purchaseDate?.getTime() ?? 0;
      const bt = b.purchaseDate?.getTime() ?? 0;
      if (at !== bt) return at - bt;
      return a.rowIndex0 - b.rowIndex0;
    });
    for (const r of ordered) {
      if (remaining <= 0) {
        allocated.set(r.rowIndex0, 0);
        continue;
      }
      const need = r.units > 0 ? r.units : remaining; // if Units blank, dump remaining onto first row
      const take = Math.min(need, remaining);
      allocated.set(r.rowIndex0, take);
      remaining -= take;
    }
  }
  return allocated;
}

export type OpsCellDecision = {
  delivered: string | null; // null = leave existing
  toAmz: string | null;
  final: string | null;
  sbOps: string;
};

/**
 * Decide Delivered / to AMZ / Final writes for one sheet row.
 * - If any units were shipped to Amazon, Delivered becomes Yes (order must have arrived).
 * - to AMZ becomes Sent / Partial (n/u).
 * - Final becomes Complete when sold covers Units (never overwrite Returned).
 */
export function decideOpsCells(opts: {
  units: number;
  shippedAlloc: number;
  receivedAlloc: number;
  soldAlloc: number;
  existingDelivered: string;
  existingToAmz: string;
  existingFinal: string;
}): OpsCellDecision {
  const units = Math.max(0, opts.units || 0);
  const shipped = Math.max(0, opts.shippedAlloc || 0);
  const received = Math.max(0, opts.receivedAlloc || 0);
  const sold = Math.max(0, opts.soldAlloc || 0);

  const existingFinal = opts.existingFinal.trim();
  const existingFinalLower = existingFinal.toLowerCase();
  const protectFinal =
    existingFinalLower.includes('return') ||
    existingFinalLower.includes('ebay') ||
    existingFinalLower === 'cancelled' ||
    existingFinalLower === 'canceled';

  let toAmz: string | null = null;
  if (shipped > 0) {
    if (units > 0 && shipped < units) {
      toAmz = `Sent (${shipped}/${units})`;
    } else {
      toAmz = 'Sent';
    }
  }

  let delivered: string | null = null;
  // Sent to Amazon (or FC received) ⇒ purchase has "come" — set Delivered Yes.
  if (shipped > 0 || received > 0) {
    const cur = opts.existingDelivered.trim().toLowerCase();
    if (!cur || cur === 'no' || cur === 'n' || cur === '0') {
      delivered = 'Yes';
    } else if (cur === 'yes' || cur === 'y') {
      delivered = null; // already good
    } else {
      delivered = 'Yes';
    }
  }

  let final: string | null = null;
  if (!protectFinal && units > 0 && sold >= units) {
    final = 'Complete';
  } else if (!protectFinal && units > 0 && sold > 0 && sold < units) {
    // leave Final blank-ish progress in SB ops only; don't write Partial to Final
    final = null;
  }

  const sbOps = [
    shipped > 0 ? `shipped=${shipped}${units ? `/${units}` : ''}` : null,
    received > 0 ? `recv=${received}` : null,
    sold > 0 ? `sold=${sold}${units ? `/${units}` : ''}` : null,
    units > 0 && sold >= units
      ? protectFinal
        ? 'SOLD_BUT_FINAL_PROTECTED'
        : 'COMPLETE'
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  // Don't rewrite identical values
  if (
    toAmz &&
    opts.existingToAmz.trim().toLowerCase() === toAmz.toLowerCase()
  ) {
    toAmz = null;
  }
  if (
    delivered &&
    opts.existingDelivered.trim().toLowerCase() === delivered.toLowerCase()
  ) {
    delivered = null;
  }
  if (
    final &&
    opts.existingFinal.trim().toLowerCase() === final.toLowerCase()
  ) {
    final = null;
  }

  return { delivered, toAmz, final, sbOps };
}

/** FBA statuses that mean units have left for / arrived at Amazon. */
export const SHEET_OPS_SHIPPED_STATUSES = [
  'SHIPPED',
  'IN_TRANSIT',
  'DELIVERED',
  'CHECKED_IN',
  'RECEIVING',
  'CLOSED',
] as const;

