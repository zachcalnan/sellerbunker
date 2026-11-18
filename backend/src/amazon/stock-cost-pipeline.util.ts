/**
 * Stock cost by pipeline stage — exclusive qty waterfall (COGS × qty).
 *
 * Production dashboard prefers sheet-aware stages in `stock-cost-sheet.util.ts`:
 *   purchased = Delivered ≠ Yes; prep = Delivered=Yes − amazonHeld.
 * This util remains the Amazon + DB-ledger waterfall (fallback / unit tests):
 * 1. Available stock  = fulfillable / available qty
 * 2. Stock sent       = inbound working + shipped + receiving (or inboundQty)
 * 3. Stock purchased  = max(0, qtyPurchased − qtyDelivered)
 * 4. Stock for prep   = max(0, qtyDelivered − (available + inbound))
 *
 * Each unit sits in exactly one bucket. Reserved / FC-processing qty is
 * intentionally excluded from these four stages.
 */

export type StockCostPipelineSkuInput = {
  availableQty: number;
  inboundQty: number;
  qtyPurchased: number;
  qtyDelivered: number;
  /** Per-unit COGS (Product.costOfGoods or purchase landed cost). */
  unitCost: number;
};

export type StockCostPipelineSkuQtys = {
  stockPurchasedQty: number;
  stockForPrepQty: number;
  stockSentQty: number;
  availableStockQty: number;
};

export type StockCostPipelineSkuResult = StockCostPipelineSkuQtys & {
  stockPurchasedCost: number;
  stockForPrepCost: number;
  stockSentCost: number;
  availableStockCost: number;
};

export type StockCostPipelineTotals = StockCostPipelineSkuResult & {
  totalCost: number;
};

function nonNegInt(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}

function nonNegMoney(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Exclusive qty assignment for one SKU / product line. */
export function allocateStockCostPipelineQtys(
  input: Omit<StockCostPipelineSkuInput, 'unitCost'>,
): StockCostPipelineSkuQtys {
  const availableStockQty = nonNegInt(input.availableQty);
  const stockSentQty = nonNegInt(input.inboundQty);
  const qtyPurchased = nonNegInt(input.qtyPurchased);
  let qtyDelivered = nonNegInt(input.qtyDelivered);
  if (qtyDelivered > qtyPurchased) qtyDelivered = qtyPurchased;

  const amazonHeld = availableStockQty + stockSentQty;
  const stockPurchasedQty = Math.max(0, qtyPurchased - qtyDelivered);
  const stockForPrepQty = Math.max(0, qtyDelivered - amazonHeld);

  return {
    stockPurchasedQty,
    stockForPrepQty,
    stockSentQty,
    availableStockQty,
  };
}

export function allocateStockCostPipelineSku(
  input: StockCostPipelineSkuInput,
): StockCostPipelineSkuResult {
  const qtys = allocateStockCostPipelineQtys(input);
  const unitCost = nonNegMoney(input.unitCost);
  const costOf = (qty: number) => round2(qty * unitCost);
  return {
    ...qtys,
    stockPurchasedCost: costOf(qtys.stockPurchasedQty),
    stockForPrepCost: costOf(qtys.stockForPrepQty),
    stockSentCost: costOf(qtys.stockSentQty),
    availableStockCost: costOf(qtys.availableStockQty),
  };
}

export function sumStockCostPipeline(
  rows: StockCostPipelineSkuResult[],
): StockCostPipelineTotals {
  let stockPurchasedQty = 0;
  let stockForPrepQty = 0;
  let stockSentQty = 0;
  let availableStockQty = 0;
  let stockPurchasedCost = 0;
  let stockForPrepCost = 0;
  let stockSentCost = 0;
  let availableStockCost = 0;

  for (const r of rows) {
    stockPurchasedQty += r.stockPurchasedQty;
    stockForPrepQty += r.stockForPrepQty;
    stockSentQty += r.stockSentQty;
    availableStockQty += r.availableStockQty;
    stockPurchasedCost += r.stockPurchasedCost;
    stockForPrepCost += r.stockForPrepCost;
    stockSentCost += r.stockSentCost;
    availableStockCost += r.availableStockCost;
  }

  stockPurchasedCost = round2(stockPurchasedCost);
  stockForPrepCost = round2(stockForPrepCost);
  stockSentCost = round2(stockSentCost);
  availableStockCost = round2(availableStockCost);

  return {
    stockPurchasedQty,
    stockForPrepQty,
    stockSentQty,
    availableStockQty,
    stockPurchasedCost,
    stockForPrepCost,
    stockSentCost,
    availableStockCost,
    totalCost: round2(
      stockPurchasedCost +
        stockForPrepCost +
        stockSentCost +
        availableStockCost,
    ),
  };
}
