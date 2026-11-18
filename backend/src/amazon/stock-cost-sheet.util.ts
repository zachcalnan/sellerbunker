/**
 * Sheet-driven stock-cost stages (early pipeline):
 *
 * Stock purchased  = CURRENT ORDERS rows still in transit (Delivered ≠ Yes),
 *                    valued at sheet £/Unit (same COGS basis as deriveUnitCostOfGoodsExVat @ VAT 0).
 * Stock for prep   = Blue30 Inbound Quantity Received (+ purchase-sheet Delivered=Yes HOME
 *                    lines not already counted on B30), valued by matching purchase-sheet cost.
 * Then Amazon waterfall (caller): Stock sent / Available from inventory snapshots.
 *
 * Exclusivity: purchased ∩ arrived = ∅; prep = max(0, arrived − amazonHeld).
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
  homePrep: 'HOME' | 'PREP CENTER' | '';
  purchaseDate: Date | null;
  sheetRow: number;
};

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
    const line: SheetCostLine = {
      asin,
      qty,
      unitCost,
      orderRef:
        orderIdx >= 0 ? String(row[orderIdx] ?? '').trim() : '',
      homePrep,
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

function normOrderRef(s: string): string {
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

/**
 * Build purchased + arrived-for-prep ASIN aggregates from sheet snapshots.
 *
 * - Purchased: in-transit purchase rows, minus any B30-received qty still
 *   marked undelivered (B30 arrival wins for exclusivity).
 * - Arrived: B30 Quantity Received + HOME Delivered=Yes purchase rows not
 *   already covered by B30 received for that ASIN (FIFO).
 */
export function buildSheetPurchasedAndArrivedByAsin(opts: {
  purchaseInTransit: SheetCostLine[];
  purchaseDelivered: SheetCostLine[];
  blue30Arrived: Blue30ArrivedLine[];
}): {
  purchasedByAsin: Map<string, AsinQtyCost>;
  arrivedByAsin: Map<string, AsinQtyCost>;
} {
  const allPurchase = [
    ...opts.purchaseInTransit,
    ...opts.purchaseDelivered,
  ];
  const purchasedByAsin = new Map<string, AsinQtyCost>();
  const arrivedByAsin = new Map<string, AsinQtyCost>();

  // B30 arrived first — valued via purchase sheet match.
  const b30QtyByAsin = new Map<string, number>();
  for (const row of opts.blue30Arrived) {
    const unitCost = matchUnitCostFromPurchaseSheet(
      row.asin,
      row.orderRef,
      allPurchase,
    );
    addAsinQtyCost(arrivedByAsin, row.asin, row.qtyReceived, unitCost);
    b30QtyByAsin.set(
      row.asin,
      (b30QtyByAsin.get(row.asin) ?? 0) + row.qtyReceived,
    );
  }

  // HOME (or any) Delivered=Yes on purchase sheet that B30 did not already count.
  const b30Remaining = new Map(b30QtyByAsin);
  for (const line of opts.purchaseDelivered) {
    const covered = b30Remaining.get(line.asin) ?? 0;
    if (covered > 0) {
      const take = Math.min(covered, line.qty);
      b30Remaining.set(line.asin, covered - take);
      const leftover = line.qty - take;
      if (leftover > 0) {
        addAsinQtyCost(arrivedByAsin, line.asin, leftover, line.unitCost);
      }
      continue;
    }
    addAsinQtyCost(arrivedByAsin, line.asin, line.qty, line.unitCost);
  }

  // In-transit purchased; subtract B30 arrivals still flagged undelivered.
  const openByAsin = new Map<string, SheetCostLine[]>();
  for (const line of opts.purchaseInTransit) {
    const list = openByAsin.get(line.asin) ?? [];
    list.push(line);
    openByAsin.set(line.asin, list);
  }
  for (const [asin, lines] of openByAsin) {
    let deduct = b30QtyByAsin.get(asin) ?? 0;
    const ordered = [...lines].sort((a, b) => {
      const at = a.purchaseDate?.getTime() ?? 0;
      const bt = b.purchaseDate?.getTime() ?? 0;
      if (at !== bt) return at - bt;
      return a.sheetRow - b.sheetRow;
    });
    for (const line of ordered) {
      let qty = line.qty;
      if (deduct > 0) {
        const take = Math.min(deduct, qty);
        deduct -= take;
        qty -= take;
      }
      if (qty > 0) {
        addAsinQtyCost(purchasedByAsin, asin, qty, line.unitCost);
      }
    }
  }

  return { purchasedByAsin, arrivedByAsin };
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
 * 2) Prep = max(0, arrived − amazonHeldByAsin), sheet-valued
 * 3) Purchased = in-transit purchase sheet (after B30 exclusivity)
 */
export function sumSheetAwareStockCostPipeline(opts: {
  skuRows: SheetAwareSkuInput[];
  purchasedByAsin: Map<string, AsinQtyCost>;
  arrivedByAsin: Map<string, AsinQtyCost>;
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
    const prepQty = Math.max(0, arrived.qty - held);
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
