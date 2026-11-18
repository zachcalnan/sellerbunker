import {
  allocateStockCostPipelineQtys,
  allocateStockCostPipelineSku,
  sumStockCostPipeline,
} from './stock-cost-pipeline.util';

describe('stock-cost-pipeline.util', () => {
  it('assigns exclusive stages: Amazon first, then purchase ledger', () => {
    // Bought 100, delivered 80 → 20 still purchased/in-transit to seller.
    // Amazon shows 30 available + 20 inbound = 50 held → prep = 80 - 50 = 30.
    const r = allocateStockCostPipelineSku({
      availableQty: 30,
      inboundQty: 20,
      qtyPurchased: 100,
      qtyDelivered: 80,
      unitCost: 2.5,
    });
    expect(r).toEqual({
      availableStockQty: 30,
      stockSentQty: 20,
      stockForPrepQty: 30,
      stockPurchasedQty: 20,
      availableStockCost: 75,
      stockSentCost: 50,
      stockForPrepCost: 75,
      stockPurchasedCost: 50,
    });
    // Mutual exclusion: qty buckets do not overlap.
    expect(
      r.availableStockQty +
        r.stockSentQty +
        r.stockForPrepQty +
        r.stockPurchasedQty,
    ).toBe(100);
  });

  it('clamps delivered above purchased and never goes negative', () => {
    const qtys = allocateStockCostPipelineQtys({
      availableQty: 5,
      inboundQty: 2,
      qtyPurchased: 10,
      qtyDelivered: 99,
    });
    expect(qtys.stockPurchasedQty).toBe(0);
    expect(qtys.stockForPrepQty).toBe(3); // 10 delivered capped − 7 amazon
    expect(qtys.availableStockQty).toBe(5);
    expect(qtys.stockSentQty).toBe(2);
  });

  it('treats all delivered-not-yet-Amazon as stock for prep when no FBA qty', () => {
    const r = allocateStockCostPipelineSku({
      availableQty: 0,
      inboundQty: 0,
      qtyPurchased: 40,
      qtyDelivered: 40,
      unitCost: 1,
    });
    expect(r.stockPurchasedQty).toBe(0);
    expect(r.stockForPrepQty).toBe(40);
    expect(r.stockSentQty).toBe(0);
    expect(r.availableStockQty).toBe(0);
    expect(r.stockForPrepCost).toBe(40);
  });

  it('values Amazon qty even when purchase ledger is empty', () => {
    const r = allocateStockCostPipelineSku({
      availableQty: 12,
      inboundQty: 3,
      qtyPurchased: 0,
      qtyDelivered: 0,
      unitCost: 4,
    });
    expect(r.availableStockCost).toBe(48);
    expect(r.stockSentCost).toBe(12);
    expect(r.stockPurchasedCost).toBe(0);
    expect(r.stockForPrepCost).toBe(0);
  });

  it('zeros cost when unit cost missing', () => {
    const r = allocateStockCostPipelineSku({
      availableQty: 10,
      inboundQty: 0,
      qtyPurchased: 10,
      qtyDelivered: 0,
      unitCost: 0,
    });
    expect(r.availableStockQty).toBe(10);
    expect(r.stockPurchasedQty).toBe(10);
    expect(r.availableStockCost).toBe(0);
    expect(r.stockPurchasedCost).toBe(0);
  });

  it('sums sku rows into totals', () => {
    const a = allocateStockCostPipelineSku({
      availableQty: 2,
      inboundQty: 1,
      qtyPurchased: 5,
      qtyDelivered: 3,
      unitCost: 10,
    });
    const b = allocateStockCostPipelineSku({
      availableQty: 1,
      inboundQty: 0,
      qtyPurchased: 1,
      qtyDelivered: 1,
      unitCost: 3,
    });
    const tot = sumStockCostPipeline([a, b]);
    expect(tot.availableStockQty).toBe(3);
    expect(tot.stockSentQty).toBe(1);
    expect(tot.stockForPrepQty).toBe(0); // a: max(0,3-3)=0; b: max(0,1-1)=0
    expect(tot.stockPurchasedQty).toBe(2);
    expect(tot.availableStockCost).toBe(23); // 20 + 3
    expect(tot.stockSentCost).toBe(10);
    expect(tot.stockPurchasedCost).toBe(20);
    expect(tot.totalCost).toBe(53);
  });
});
