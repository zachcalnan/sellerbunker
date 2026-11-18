/**
 * Sheet-driven stock-cost stages (early pipeline):
 *
 * Stock purchased  = CURRENT ORDERS rows with Delivered ≠ Yes, valued at £/Unit.
 * Stock for prep   = CURRENT ORDERS rows with Delivered = Yes and Home/Prep ≠ sent
 *                    and Final ≠ Complete, valued at £/Unit, then clamped by Amazon
 *                    available+inbound.
 *
 * Blue30 Quantity Received is NOT a second cost pile — it only drives a sync that
 * flips matching purchase-sheet Delivered → Yes. When Amazon held (available+inbound)
 * covers Delivered=Yes rows, Home/Prep is set to "sent" (middle column). When Amazon
 * sales consume units, Final (next status column after Home/Prep) is set to Complete.
 *
 * Exclusivity waterfall (caller): Available → Sent → Prep → Purchased.
 * Completed (sold-through) rows leave every stage — Available is Amazon inventory
 * after sales; sheet Complete rows are excluded from prep / sheet-sent clamps.
 * prep = max(0, deliveredNotSent − amazonHeld); purchased = not delivered.
 */

import {
  deriveUnitCostOfGoodsExVat,
  findAsinColumnIndex,
  findDateColumnIndex,
  findHeaderColumnIndex,
  findUnitCostColumnIndex,
  parseSheetDate,
  parseSheetMoney,
  parseSheetUnits,
} from './purchase-sheet-cogs.util';
import { findPrepInboundHeaderRowIndex } from './prep-center-inbound-sheet.util';
import { normalizeShipDestinationLabel } from './purchase-sheet-order-write.service';

export type SheetCostLine = {
  asin: string;
  qty: number;
  /** Per-unit cost on the same basis as Product.costOfGoods (ex-VAT / landed). */
  unitCost: number;
  orderRef: string;
  homePrep: 'HOME' | 'PREP CENTER' | 'sent' | '';
  /** Final / Sold / Complete column — sold-through purchase rows. */
  finalComplete: boolean;
  /** Raw Final cell (for protect / idempotent writes). */
  finalRaw: string;
  purchaseDate: Date | null;
  sheetRow: number;
};

/** Exact Final cell value when purchase units have sold through on Amazon. */
export const PURCHASE_SHEET_COMPLETE_VALUE = 'Complete';

/** Exact Final cell value when a sold-through purchase lot was returned. */
export const PURCHASE_SHEET_RETURNED_VALUE = 'Returned';

/** Google Sheets RGB (0–1) for Final status cells — Excel-like conditional format. */
export type PurchaseSheetRgb = { red: number; green: number; blue: number };

export type PurchaseSheetFinalStatusFormat = {
  status: 'Complete' | 'Returned';
  backgroundColor: PurchaseSheetRgb;
  foregroundColor: PurchaseSheetRgb;
};

/** Complete: light green fill (#C6EFCE) + dark green text (#006100). */
export const PURCHASE_SHEET_COMPLETE_BG: PurchaseSheetRgb = {
  red: 198 / 255,
  green: 239 / 255,
  blue: 206 / 255,
};
export const PURCHASE_SHEET_COMPLETE_FG: PurchaseSheetRgb = {
  red: 0,
  green: 97 / 255,
  blue: 0,
};

/** Returned: light red fill (#FFC7CE) + dark red text (#9C0006). */
export const PURCHASE_SHEET_RETURNED_BG: PurchaseSheetRgb = {
  red: 255 / 255,
  green: 199 / 255,
  blue: 206 / 255,
};
export const PURCHASE_SHEET_RETURNED_FG: PurchaseSheetRgb = {
  red: 156 / 255,
  green: 0,
  blue: 6 / 255,
};

/** True when CURRENT ORDERS Home/Prep means already sent into Amazon. */
export function isPurchaseSheetHomePrepSent(raw: unknown): boolean {
  return normalizeShipDestinationLabel(raw) === 'sent';
}

/**
 * True when CURRENT ORDERS Final (or Sold / Complete / Done) means sold-through.
 * Does not treat Returned / Ebay / Cancelled as complete.
 */
export function isPurchaseSheetFinalComplete(raw: unknown): boolean {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s) return false;
  if (
    s.includes('return') ||
    s.includes('ebay') ||
    s === 'cancelled' ||
    s === 'canceled'
  ) {
    return false;
  }
  return s === 'complete' || s === 'completed' || s === 'done' || s === 'sold';
}

/** True when Final means a return (Returned / return / refund wording). */
export function isPurchaseSheetFinalReturned(raw: unknown): boolean {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s) return false;
  return s.includes('return') || s.includes('refund');
}

/** Final cell values that must not be overwritten by Complete sync. */
export function isPurchaseSheetFinalProtected(raw: unknown): boolean {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s) return false;
  return (
    s.includes('return') ||
    s.includes('ebay') ||
    s === 'cancelled' ||
    s === 'canceled'
  );
}

/**
 * Map Final cell text → green (Complete) / red (Returned) fill+text, or null.
 */
export function resolvePurchaseSheetFinalStatusFormat(
  raw: unknown,
): PurchaseSheetFinalStatusFormat | null {
  if (isPurchaseSheetFinalComplete(raw)) {
    return {
      status: 'Complete',
      backgroundColor: PURCHASE_SHEET_COMPLETE_BG,
      foregroundColor: PURCHASE_SHEET_COMPLETE_FG,
    };
  }
  if (isPurchaseSheetFinalReturned(raw)) {
    return {
      status: 'Returned',
      backgroundColor: PURCHASE_SHEET_RETURNED_BG,
      foregroundColor: PURCHASE_SHEET_RETURNED_FG,
    };
  }
  return null;
}

/**
 * Resolve the Final / Complete status column on CURRENT ORDERS.
 * Prefer named Final / Sold / Complete / Done / Ebay/Return; else the column
 * immediately after Home/Prep when that header is a status-like / blank name
 * (not Delivered / Units / money).
 */
export function findPurchaseSheetFinalColumnIndex(header: string[]): number {
  const named = findHeaderColumnIndex(header, [
    'Final',
    'Sold',
    'Complete',
    'Done',
    'Ebay/Return',
    'Status',
  ]);
  if (named >= 0) return named;

  const homePrepIdx = findHeaderColumnIndex(header, ['Home/Prep', 'Prep']);
  if (homePrepIdx < 0) return -1;
  const next = homePrepIdx + 1;
  if (next >= header.length) return -1;
  const nextNorm = String(header[next] ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  // Occupied by a known non-final column → do not invent.
  if (
    nextNorm === 'delivered' ||
    nextNorm === 'units' ||
    nextNorm === 'qty' ||
    nextNorm === 'quantity' ||
    nextNorm.includes('£/unit') ||
    nextNorm.includes('/unit') ||
    nextNorm === 'asin' ||
    nextNorm === 'date' ||
    nextNorm === 'supplier' ||
    nextNorm === 'notes' ||
    nextNorm === 'note' ||
    nextNorm === 'product' ||
    nextNorm === 'ordernum' ||
    nextNorm === 'ordernumber' ||
    nextNorm === 'ordercost' ||
    nextNorm === 'toamz' ||
    nextNorm === 'toamazon'
  ) {
    return -1;
  }
  // Blank header or status-ish label after Home/Prep.
  if (
    !nextNorm ||
    nextNorm.includes('final') ||
    nextNorm.includes('sold') ||
    nextNorm.includes('complete') ||
    nextNorm.includes('done') ||
    nextNorm.includes('status') ||
    nextNorm.includes('ebay') ||
    nextNorm.includes('return')
  ) {
    return next;
  }
  return -1;
}

export type AsinQtyCost = {
  qty: number;
  cost: number;
  unitCostWeight: number;
  unitCostQty: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function nonNegInt(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}

/** True when CURRENT ORDERS Delivered cell means received at home/prep. */
export function isPurchaseSheetDeliveredYes(raw: unknown): boolean {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s) return false;
  if (s === 'yes' || s === 'y' || s === 'true' || s === '1') return true;
  if (s.startsWith('yes')) return true;
  if (s.includes('delivered') || s.includes('arrived') || s.includes('received')) {
    return !s.includes('not');
  }
  return false;
}

/** Blank / No / N → still on the way. */
export function isPurchaseSheetInTransit(raw: unknown): boolean {
  return !isPurchaseSheetDeliveredYes(raw);
}

export function sheetUnitCostToCogs(unitCostIncVat: number): number {
  const derived = deriveUnitCostOfGoodsExVat({
    unitCostIncVat,
    vatRatePct: 0,
  });
  return derived != null && derived > 0 ? derived : 0;
}

function emptyAsinAgg(): AsinQtyCost {
  return { qty: 0, cost: 0, unitCostWeight: 0, unitCostQty: 0 };
}

function addAsinQtyCost(
  map: Map<string, AsinQtyCost>,
  asin: string,
  qty: number,
  unitCost: number,
): void {
  if (!(qty > 0)) return;
  const prev = map.get(asin) ?? emptyAsinAgg();
  prev.qty += qty;
  if (unitCost > 0) {
    prev.cost = round2(prev.cost + qty * unitCost);
    prev.unitCostWeight += unitCost * qty;
    prev.unitCostQty += qty;
  }
  map.set(asin, prev);
}

/**
 * Parse CURRENT ORDERS into in-transit (purchased) and delivered lines.
 */
export function parsePurchaseSheetStageRows(values: unknown[][]): {
  header: string[];
  inTransit: SheetCostLine[];
  delivered: SheetCostLine[];
  errors: string[];
} {
  const errors: string[] = [];
  const header = (values[0] ?? []).map((h) => String(h ?? ''));
  const asinIdx = findAsinColumnIndex(header);
  const unitsIdx = findHeaderColumnIndex(header, ['Units', 'Qty', 'Quantity']);
  const unitCostIdx = findUnitCostColumnIndex(header);
  const deliveredIdx = findHeaderColumnIndex(header, ['Delivered']);
  const dateIdx = findDateColumnIndex(header);
  const orderIdx = findHeaderColumnIndex(header, [
    'Order Num',
    'Order Number',
    'Order #',
    'Order Reference',
    'Order Ref',
  ]);
  const homePrepIdx = findHeaderColumnIndex(header, ['Home/Prep', 'Prep']);
  const finalIdx = findPurchaseSheetFinalColumnIndex(header);

  const inTransit: SheetCostLine[] = [];
  const delivered: SheetCostLine[] = [];

  if (asinIdx < 0) {
    errors.push('CURRENT ORDERS: ASIN column not found');
    return { header, inTransit, delivered, errors };
  }
  if (unitsIdx < 0) errors.push('CURRENT ORDERS: Units column not found');
  if (unitCostIdx < 0) errors.push('CURRENT ORDERS: £/Unit column not found');
  if (deliveredIdx < 0) {
    errors.push('CURRENT ORDERS: Delivered column not found');
  }

  for (let r = 1; r < values.length; r++) {
    const row = values[r] ?? [];
    const asin = String(row[asinIdx] ?? '')
      .trim()
      .toUpperCase();
    if (!asin || asin === '-' || asin === 'N/A') continue;
    const qty = unitsIdx >= 0 ? parseSheetUnits(row[unitsIdx]) : 0;
    if (!(qty > 0)) continue;
    const money =
      unitCostIdx >= 0 ? parseSheetMoney(row[unitCostIdx]) : null;
    const unitCost = money != null ? sheetUnitCostToCogs(money) : 0;
    const homeRaw =
      homePrepIdx >= 0 ? String(row[homePrepIdx] ?? '') : '';
    const homePrep = normalizeShipDestinationLabel(homeRaw);
    const finalRaw = finalIdx >= 0 ? String(row[finalIdx] ?? '') : '';
    const line: SheetCostLine = {
      asin,
      qty,
      unitCost,
      orderRef:
        orderIdx >= 0 ? String(row[orderIdx] ?? '').trim() : '',
      homePrep,
      finalComplete: isPurchaseSheetFinalComplete(finalRaw),
      finalRaw,
      purchaseDate: dateIdx >= 0 ? parseSheetDate(row[dateIdx]) : null,
      sheetRow: r + 1,
    };
    const deliveredRaw =
      deliveredIdx >= 0 ? row[deliveredIdx] : '';
    if (isPurchaseSheetDeliveredYes(deliveredRaw)) {
      delivered.push(line);
    } else {
      inTransit.push(line);
    }
  }

  return { header, inTransit, delivered, errors };
}

export type Blue30ArrivedLine = {
  asin: string;
  sku: string | null;
  qtyReceived: number;
  qtyOrdered: number;
  orderRef: string;
  sheetRow: number;
};

/**
 * Parse Blue30 Inbound rows with Quantity Received > 0.
 */
export function parseBlue30ArrivedRows(values: string[][]): {
  header: string[];
  headerRowIndex: number;
  arrived: Blue30ArrivedLine[];
  errors: string[];
} {
  const errors: string[] = [];
  const headerRowIndex = findPrepInboundHeaderRowIndex(values);
  if (headerRowIndex < 0) {
    return {
      header: [],
      headerRowIndex: -1,
      arrived: [],
      errors: ['Blue30 Inbound: header row not found'],
    };
  }
  const header = (values[headerRowIndex] ?? []).map((h) => String(h ?? ''));
  const asinIdx = findAsinColumnIndex(header);
  const qtyIdx = findHeaderColumnIndex(header, ['Quantity', 'Qty', 'Units']);
  const recvIdx = findHeaderColumnIndex(header, [
    'Quantity Received',
    'Qty Received',
    'Received',
    'Received Qty',
  ]);
  const orderIdx = findHeaderColumnIndex(header, [
    'Order Reference',
    'Order Ref',
    'Order Num',
    'Order Number',
    'Order #',
  ]);
  const skuIdx = findHeaderColumnIndex(header, ['SKU', 'Seller SKU']);

  if (asinIdx < 0) {
    errors.push('Blue30 Inbound: ASIN column not found');
    return { header, headerRowIndex, arrived: [], errors };
  }
  if (recvIdx < 0) {
    errors.push('Blue30 Inbound: Quantity Received column not found');
    return { header, headerRowIndex, arrived: [], errors };
  }

  const arrived: Blue30ArrivedLine[] = [];
  for (let r = headerRowIndex + 1; r < values.length; r++) {
    const row = values[r] ?? [];
    const asin = String(row[asinIdx] ?? '')
      .trim()
      .toUpperCase();
    if (!asin || asin === 'ASIN') continue;
    const qtyReceived = parseSheetUnits(row[recvIdx]);
    if (!(qtyReceived > 0)) continue;
    const qtyOrdered = qtyIdx >= 0 ? parseSheetUnits(row[qtyIdx]) : 0;
    const skuRaw =
      skuIdx >= 0 ? String(row[skuIdx] ?? '').trim() : '';
    arrived.push({
      asin,
      sku: skuRaw || null,
      qtyReceived,
      qtyOrdered,
      orderRef: orderIdx >= 0 ? String(row[orderIdx] ?? '').trim() : '',
      sheetRow: r + 1,
    });
  }

  return { header, headerRowIndex, arrived, errors };
}

export function normOrderRef(s: string): string {
  return String(s ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

/**
 * Match arrived qty to purchase-sheet unit costs.
 * Prefer same Order Ref + ASIN; else newest purchase-sheet cost for ASIN.
 */
export function matchUnitCostFromPurchaseSheet(
  asin: string,
  orderRef: string,
  purchaseLines: SheetCostLine[],
): number {
  const a = asin.trim().toUpperCase();
  const wantOrder = normOrderRef(orderRef);
  const sameAsin = purchaseLines.filter((l) => l.asin === a && l.unitCost > 0);
  if (sameAsin.length === 0) return 0;

  if (wantOrder) {
    const byOrder = sameAsin.filter(
      (l) => normOrderRef(l.orderRef) === wantOrder,
    );
    if (byOrder.length > 0) {
      // Weighted average if multiple lines for same order/ASIN.
      let w = 0;
      let q = 0;
      for (const l of byOrder) {
        w += l.unitCost * l.qty;
        q += l.qty;
      }
      return q > 0 ? round2(w / q) : byOrder[byOrder.length - 1].unitCost;
    }
  }

  const ordered = [...sameAsin].sort((x, y) => {
    const xt = x.purchaseDate?.getTime() ?? 0;
    const yt = y.purchaseDate?.getTime() ?? 0;
    if (xt !== yt) return yt - xt;
    return y.sheetRow - x.sheetRow;
  });
  return ordered[0]?.unitCost ?? 0;
}

export type DeliveredYesUpdate = {
  /** 1-based sheet row */
  sheetRow: number;
  deliveredColIndex0: number;
  asin: string;
  orderRef: string;
  match: 'order_asin' | 'asin';
};

export type HomePrepSentUpdate = {
  /** 1-based sheet row */
  sheetRow: number;
  homePrepColIndex0: number;
  asin: string;
  orderRef: string;
  qty: number;
};

export type FinalCompleteUpdate = {
  /** 1-based sheet row */
  sheetRow: number;
  finalColIndex0: number;
  asin: string;
  orderRef: string;
  qty: number;
  match: 'order_asin' | 'asin';
};

export type FinalReturnedUpdate = {
  /** 1-based sheet row */
  sheetRow: number;
  finalColIndex0: number;
  asin: string;
  orderRef: string;
  qty: number;
  match: 'order_asin' | 'asin';
};

export type FinalStatusFormatUpdate = {
  /** 1-based sheet row */
  sheetRow: number;
  finalColIndex0: number;
  status: 'Complete' | 'Returned';
  backgroundColor: PurchaseSheetRgb;
  foregroundColor: PurchaseSheetRgb;
};

/**
 * Plan idempotent Home/Prep → "sent" writes for Delivered=Yes rows covered by
 * Amazon units that reached FBA: held (available+inbound) plus sold-through.
 * Sold is included so already-sold rows still get sent before Complete backfill.
 * Skips Final=Complete / Returned / protected rows. Does not touch £/Unit, Units, or Delivered.
 */
export function planHomePrepSentUpdatesFromAmazonHeld(opts: {
  purchaseDelivered: SheetCostLine[];
  homePrepColIndex0: number;
  amazonHeldByAsin: Map<string, number>;
  /** Cumulative fulfilled sales by ASIN — expands coverage for sold-through backfill. */
  soldByAsin?: Map<string, number>;
}): HomePrepSentUpdate[] {
  if (opts.homePrepColIndex0 < 0) return [];

  const updates: HomePrepSentUpdate[] = [];
  const seenRows = new Set<number>();

  const byAsin = new Map<string, SheetCostLine[]>();
  for (const line of opts.purchaseDelivered) {
    if (line.finalComplete) continue; // sold-through — leave alone
    if (isPurchaseSheetFinalProtected(line.finalRaw)) continue;
    if (line.homePrep === 'sent') continue; // already marked
    const asin = line.asin.trim().toUpperCase();
    if (!asin) continue;
    const list = byAsin.get(asin) ?? [];
    list.push(line);
    byAsin.set(asin, list);
  }

  for (const [asin, lines] of byAsin) {
    const held = Math.max(0, Math.floor(opts.amazonHeldByAsin.get(asin) ?? 0));
    const sold = Math.max(0, Math.floor(opts.soldByAsin?.get(asin) ?? 0));
    // Units that reached Amazon = still held + already sold.
    let remaining = held + sold;
    if (!(remaining > 0)) continue;

    const ordered = [...lines].sort((a, b) => {
      const at = a.purchaseDate?.getTime() ?? 0;
      const bt = b.purchaseDate?.getTime() ?? 0;
      if (at !== bt) return at - bt;
      return a.sheetRow - b.sheetRow;
    });

    for (const line of ordered) {
      if (remaining <= 0) break;
      if (seenRows.has(line.sheetRow)) continue;
      seenRows.add(line.sheetRow);
      updates.push({
        sheetRow: line.sheetRow,
        homePrepColIndex0: opts.homePrepColIndex0,
        asin: line.asin,
        orderRef: line.orderRef,
        qty: line.qty,
      });
      remaining -= line.qty;
    }
  }

  return updates;
}

/**
 * Plan idempotent Final → Complete writes from Amazon fulfilled sales.
 * Eligible = Delivered=Yes rows with Home/Prep=sent (or just-marked sent), not
 * already Complete / protected. Match Order Ref+ASIN when sale refs align,
 * else ASIN FIFO oldest first. Does not touch £/Unit, Units, Delivered, Home/Prep.
 */
export function planFinalCompleteUpdatesFromSold(opts: {
  purchaseDelivered: SheetCostLine[];
  finalColIndex0: number;
  soldByAsin: Map<string, number>;
  /** Optional Order Ref hints per ASIN (usually empty for Amazon sales). */
  soldOrderRefsByAsin?: Map<string, string[]>;
}): FinalCompleteUpdate[] {
  if (opts.finalColIndex0 < 0) return [];

  const updates: FinalCompleteUpdate[] = [];
  const seenRows = new Set<number>();

  type OpenLine = SheetCostLine & { claimed: boolean };
  const byAsin = new Map<string, OpenLine[]>();
  for (const line of opts.purchaseDelivered) {
    if (line.finalComplete) continue;
    if (isPurchaseSheetFinalProtected(line.finalRaw)) continue;
    // Only units that made it into Amazon (sent) can be sold-through.
    if (line.homePrep !== 'sent') continue;
    const asin = line.asin.trim().toUpperCase();
    if (!asin) continue;
    const list = byAsin.get(asin) ?? [];
    list.push({ ...line, claimed: false });
    byAsin.set(asin, list);
  }

  const sortOldest = (a: OpenLine, b: OpenLine) => {
    const at = a.purchaseDate?.getTime() ?? 0;
    const bt = b.purchaseDate?.getTime() ?? 0;
    if (at !== bt) return at - bt;
    return a.sheetRow - b.sheetRow;
  };

  const pushUpdate = (line: OpenLine, match: 'order_asin' | 'asin') => {
    if (line.claimed || seenRows.has(line.sheetRow)) return;
    line.claimed = true;
    seenRows.add(line.sheetRow);
    updates.push({
      sheetRow: line.sheetRow,
      finalColIndex0: opts.finalColIndex0,
      asin: line.asin,
      orderRef: line.orderRef,
      qty: line.qty,
      match,
    });
  };

  for (const [asin, lines] of byAsin) {
    let remaining = Math.max(0, Math.floor(opts.soldByAsin.get(asin) ?? 0));
    if (!(remaining > 0)) continue;

    const open = [...lines].sort(sortOldest);
    const orderHints = (opts.soldOrderRefsByAsin?.get(asin) ?? [])
      .map((r) => normOrderRef(r))
      .filter(Boolean);

    // Prefer Order Ref+ASIN when a sale/ref hint matches a purchase Order Num.
    for (const wantOrder of orderHints) {
      if (!(remaining > 0)) break;
      const byOrder = open.filter(
        (l) =>
          !l.claimed &&
          normOrderRef(l.orderRef) === wantOrder,
      );
      for (const line of byOrder) {
        if (!(remaining > 0)) break;
        pushUpdate(line, 'order_asin');
        remaining -= line.qty;
      }
    }

    for (const line of open) {
      if (!(remaining > 0)) break;
      if (line.claimed) continue;
      pushUpdate(line, 'asin');
      remaining -= line.qty;
    }
  }

  return updates;
}

/**
 * Plan idempotent Final Complete → Returned writes from Amazon returned/refunded units.
 * Eligible = Delivered=Yes, Home/Prep=sent, Final=Complete. ASIN FIFO oldest first.
 * Does not touch £/Unit, Units, Delivered, Home/Prep, or non-Complete Final values.
 */
export function planFinalReturnedUpdatesFromReturns(opts: {
  purchaseDelivered: SheetCostLine[];
  finalColIndex0: number;
  returnedByAsin: Map<string, number>;
  /** Optional Order Ref hints per ASIN. */
  returnedOrderRefsByAsin?: Map<string, string[]>;
}): FinalReturnedUpdate[] {
  if (opts.finalColIndex0 < 0) return [];

  const updates: FinalReturnedUpdate[] = [];
  const seenRows = new Set<number>();

  type OpenLine = SheetCostLine & { claimed: boolean };
  const byAsin = new Map<string, OpenLine[]>();
  for (const line of opts.purchaseDelivered) {
    // Only undo sold-through Complete rows — never overwrite Ebay / blank / etc.
    if (!line.finalComplete) continue;
    if (isPurchaseSheetFinalReturned(line.finalRaw)) continue;
    if (line.homePrep !== 'sent') continue;
    const asin = line.asin.trim().toUpperCase();
    if (!asin) continue;
    const list = byAsin.get(asin) ?? [];
    list.push({ ...line, claimed: false });
    byAsin.set(asin, list);
  }

  const sortOldest = (a: OpenLine, b: OpenLine) => {
    const at = a.purchaseDate?.getTime() ?? 0;
    const bt = b.purchaseDate?.getTime() ?? 0;
    if (at !== bt) return at - bt;
    return a.sheetRow - b.sheetRow;
  };

  const pushUpdate = (line: OpenLine, match: 'order_asin' | 'asin') => {
    if (line.claimed || seenRows.has(line.sheetRow)) return;
    line.claimed = true;
    seenRows.add(line.sheetRow);
    updates.push({
      sheetRow: line.sheetRow,
      finalColIndex0: opts.finalColIndex0,
      asin: line.asin,
      orderRef: line.orderRef,
      qty: line.qty,
      match,
    });
  };

  for (const [asin, lines] of byAsin) {
    let remaining = Math.max(
      0,
      Math.floor(opts.returnedByAsin.get(asin) ?? 0),
    );
    if (!(remaining > 0)) continue;

    const open = [...lines].sort(sortOldest);
    const orderHints = (opts.returnedOrderRefsByAsin?.get(asin) ?? [])
      .map((r) => normOrderRef(r))
      .filter(Boolean);

    for (const wantOrder of orderHints) {
      if (!(remaining > 0)) break;
      const byOrder = open.filter(
        (l) => !l.claimed && normOrderRef(l.orderRef) === wantOrder,
      );
      for (const line of byOrder) {
        if (!(remaining > 0)) break;
        pushUpdate(line, 'order_asin');
        remaining -= line.qty;
      }
    }

    for (const line of open) {
      if (!(remaining > 0)) break;
      if (line.claimed) continue;
      pushUpdate(line, 'asin');
      remaining -= line.qty;
    }
  }

  return updates;
}

/**
 * Plan Final cell format backfill for Complete (green) / Returned (red) values.
 * Idempotent — callers may re-apply the same colors every sync.
 */
export function planFinalStatusFormatUpdates(opts: {
  lines: SheetCostLine[];
  finalColIndex0: number;
}): FinalStatusFormatUpdate[] {
  if (opts.finalColIndex0 < 0) return [];
  const out: FinalStatusFormatUpdate[] = [];
  const seen = new Set<number>();
  for (const line of opts.lines) {
    if (seen.has(line.sheetRow)) continue;
    const fmt = resolvePurchaseSheetFinalStatusFormat(line.finalRaw);
    if (!fmt) continue;
    seen.add(line.sheetRow);
    out.push({
      sheetRow: line.sheetRow,
      finalColIndex0: opts.finalColIndex0,
      status: fmt.status,
      backgroundColor: fmt.backgroundColor,
      foregroundColor: fmt.foregroundColor,
    });
  }
  return out;
}

/**
 * Plan idempotent Delivered=Yes writes from Blue30 Quantity Received.
 * Match Order Ref+ASIN first, else FIFO ASIN-only against undelivered rows.
 * Does not touch £/Unit, Units, or other cells.
 */
export function planDeliveredYesUpdatesFromBlue30(opts: {
  purchaseInTransit: SheetCostLine[];
  deliveredColIndex0: number;
  blue30Arrived: Blue30ArrivedLine[];
}): DeliveredYesUpdate[] {
  if (opts.deliveredColIndex0 < 0) return [];

  type OpenLine = SheetCostLine & { claimed: boolean };
  const open: OpenLine[] = opts.purchaseInTransit.map((l) => ({
    ...l,
    claimed: false,
  }));
  const updates: DeliveredYesUpdate[] = [];
  const seenRows = new Set<number>();

  const pushUpdate = (line: OpenLine, match: 'order_asin' | 'asin') => {
    if (line.claimed || seenRows.has(line.sheetRow)) return;
    line.claimed = true;
    seenRows.add(line.sheetRow);
    updates.push({
      sheetRow: line.sheetRow,
      deliveredColIndex0: opts.deliveredColIndex0,
      asin: line.asin,
      orderRef: line.orderRef,
      match,
    });
  };

  const sortOldest = (a: OpenLine, b: OpenLine) => {
    const at = a.purchaseDate?.getTime() ?? 0;
    const bt = b.purchaseDate?.getTime() ?? 0;
    if (at !== bt) return at - bt;
    return a.sheetRow - b.sheetRow;
  };

  for (const b30 of opts.blue30Arrived) {
    if (!(b30.qtyReceived > 0)) continue;
    const asin = b30.asin.trim().toUpperCase();
    if (!asin) continue;
    const wantOrder = normOrderRef(b30.orderRef);

    if (wantOrder) {
      const byOrder = open
        .filter(
          (l) =>
            !l.claimed &&
            l.asin === asin &&
            normOrderRef(l.orderRef) === wantOrder,
        )
        .sort(sortOldest);
      if (byOrder.length > 0) {
        for (const line of byOrder) pushUpdate(line, 'order_asin');
        continue;
      }
    }

    // ASIN-only: cover received qty FIFO across undelivered rows.
    let remaining = b30.qtyReceived;
    const byAsin = open
      .filter((l) => !l.claimed && l.asin === asin)
      .sort(sortOldest);
    for (const line of byAsin) {
      if (remaining <= 0) break;
      pushUpdate(line, 'asin');
      remaining -= line.qty;
    }
  }

  return updates;
}

/**
 * Build purchased + arrived-for-prep ASIN aggregates from the purchase sheet.
 *
 * Source of truth after Blue30→Delivered / Home/Prep→sent / Final→Complete sync:
 * - Purchased = Delivered ≠ Yes rows (in-transit)
 * - Arrived (prep candidates) = Delivered = Yes, Home/Prep ≠ sent, Final ≠ Complete/Returned
 * - Sheet-sent qty = Delivered = Yes, Home/Prep = sent, Final ≠ Complete/Returned
 * - Final=Complete / Returned / protected rows leave every sheet stage.
 *
 * `blue30Arrived` is ignored for costing (kept optional for call-site compat).
 */
export function buildSheetPurchasedAndArrivedByAsin(opts: {
  purchaseInTransit: SheetCostLine[];
  purchaseDelivered: SheetCostLine[];
  blue30Arrived?: Blue30ArrivedLine[];
}): {
  purchasedByAsin: Map<string, AsinQtyCost>;
  arrivedByAsin: Map<string, AsinQtyCost>;
  sheetSentByAsin: Map<string, number>;
} {
  void opts.blue30Arrived;
  const purchasedByAsin = new Map<string, AsinQtyCost>();
  const arrivedByAsin = new Map<string, AsinQtyCost>();
  const sheetSentByAsin = new Map<string, number>();

  for (const line of opts.purchaseInTransit) {
    if (line.finalComplete) continue;
    if (isPurchaseSheetFinalProtected(line.finalRaw)) continue;
    addAsinQtyCost(purchasedByAsin, line.asin, line.qty, line.unitCost);
  }
  for (const line of opts.purchaseDelivered) {
    const asin = line.asin.trim().toUpperCase();
    // Sold-through / returned / protected → gone from prep / sheet-sent.
    if (line.finalComplete) continue;
    if (isPurchaseSheetFinalProtected(line.finalRaw)) continue;
    // Home/Prep=sent → already into Amazon; leave prep (Available/Sent tiles own them).
    if (line.homePrep === 'sent') {
      if (asin && line.qty > 0) {
        sheetSentByAsin.set(asin, (sheetSentByAsin.get(asin) ?? 0) + line.qty);
      }
      continue;
    }
    addAsinQtyCost(arrivedByAsin, line.asin, line.qty, line.unitCost);
  }

  return { purchasedByAsin, arrivedByAsin, sheetSentByAsin };
}

export type SheetAwareSkuInput = {
  asin: string | null;
  availableQty: number;
  inboundQty: number;
  /** Product.costOfGoods for Amazon stages. */
  unitCost: number;
};

export type SheetAwarePipelineResult = {
  stockPurchasedQty: number;
  stockPurchasedCost: number;
  stockForPrepQty: number;
  stockForPrepCost: number;
  stockSentQty: number;
  stockSentCost: number;
  availableStockQty: number;
  availableStockCost: number;
  totalCost: number;
  missingCogsQty: number;
};

/**
 * Exclusive sheet-aware totals:
 * 1) Available / Sent from Amazon inventory (SKU rows)
 * 2) Prep = Delivered=Yes & Home/Prep≠sent, clamped by held not already
 *    explained by sheet-sent rows: max(0, arrived − max(0, held − sheetSent))
 * 3) Purchased = Delivered ≠ Yes purchase-sheet rows
 */
export function sumSheetAwareStockCostPipeline(opts: {
  skuRows: SheetAwareSkuInput[];
  purchasedByAsin: Map<string, AsinQtyCost>;
  arrivedByAsin: Map<string, AsinQtyCost>;
  /** Delivered=Yes rows already marked Home/Prep=sent (qty by ASIN). */
  sheetSentByAsin?: Map<string, number>;
}): SheetAwarePipelineResult {
  const amazonHeldByAsin = new Map<string, number>();
  let stockSentQty = 0;
  let stockSentCost = 0;
  let availableStockQty = 0;
  let availableStockCost = 0;
  let missingCogsQty = 0;

  for (const row of opts.skuRows) {
    const available = nonNegInt(row.availableQty);
    const inbound = nonNegInt(row.inboundQty);
    const unit = row.unitCost > 0 ? row.unitCost : 0;
    availableStockQty += available;
    stockSentQty += inbound;
    if (unit > 0) {
      availableStockCost = round2(availableStockCost + available * unit);
      stockSentCost = round2(stockSentCost + inbound * unit);
    } else if (available + inbound > 0) {
      missingCogsQty += available + inbound;
    }
    const asin = (row.asin ?? '').trim().toUpperCase();
    if (asin) {
      amazonHeldByAsin.set(
        asin,
        (amazonHeldByAsin.get(asin) ?? 0) + available + inbound,
      );
    }
  }

  let stockPurchasedQty = 0;
  let stockPurchasedCost = 0;
  for (const agg of opts.purchasedByAsin.values()) {
    stockPurchasedQty += agg.qty;
    stockPurchasedCost = round2(stockPurchasedCost + agg.cost);
    if (!(agg.cost > 0) && agg.qty > 0) missingCogsQty += agg.qty;
  }

  let stockForPrepQty = 0;
  let stockForPrepCost = 0;
  const asins = new Set<string>([
    ...opts.arrivedByAsin.keys(),
    ...amazonHeldByAsin.keys(),
  ]);
  for (const asin of asins) {
    const arrived = opts.arrivedByAsin.get(asin);
    if (!arrived || !(arrived.qty > 0)) continue;
    const held = amazonHeldByAsin.get(asin) ?? 0;
    const sheetSent = nonNegInt(opts.sheetSentByAsin?.get(asin) ?? 0);
    // Don't double-subtract inventory already attributed to Home/Prep=sent rows.
    const heldForPrepClamp = Math.max(0, held - sheetSent);
    const prepQty = Math.max(0, arrived.qty - heldForPrepClamp);
    if (!(prepQty > 0)) continue;
    stockForPrepQty += prepQty;
    const avgUnit =
      arrived.unitCostQty > 0
        ? arrived.unitCostWeight / arrived.unitCostQty
        : arrived.qty > 0
          ? arrived.cost / arrived.qty
          : 0;
    if (avgUnit > 0) {
      stockForPrepCost = round2(stockForPrepCost + prepQty * avgUnit);
    } else {
      missingCogsQty += prepQty;
    }
  }

  return {
    stockPurchasedQty,
    stockPurchasedCost,
    stockForPrepQty,
    stockForPrepCost,
    stockSentQty,
    stockSentCost,
    availableStockQty,
    availableStockCost,
    totalCost: round2(
      stockPurchasedCost +
        stockForPrepCost +
        stockSentCost +
        availableStockCost,
    ),
    missingCogsQty,
  };
}
