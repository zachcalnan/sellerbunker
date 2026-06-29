import { PrismaClient } from '@prisma/client';

/**
 * Diagnose why a repriced ASIN is below its rule's min ROI.
 * Usage: ts-node -r dotenv/config src/scripts/check-repricer-asin.ts B07RM5DCFR
 */
async function main() {
  const asin = (process.argv[2]?.trim() || 'B07RM5DCFR').toUpperCase();
  const prisma = new PrismaClient();
  try {
    const products = await prisma.product.findMany({
      where: { asin },
      select: {
        id: true,
        sku: true,
        asin: true,
        userId: true,
        currentListedPrice: true,
        currentListedPriceUpdatedAt: true,
        costOfGoods: true,
        estimatedAmazonFeePerUnit: true,
        estimatedReferralFeePerUnit: true,
        estimatedFbaFeePerUnit: true,
        estimatedDigitalServiceFeePerUnit: true,
        inventory: { select: { totalQty: true, availableQty: true, updatedAt: true } },
      },
    });

    const out: any[] = [];
    for (const p of products) {
      const selected = await (prisma as any).repricerSelectedSku.findMany({
        where: { productId: p.id },
        select: {
          id: true,
          orgId: true,
          enabled: true,
          ruleSetId: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const ruleSetIds = Array.from(
        new Set(selected.map((s: any) => s.ruleSetId).filter(Boolean)),
      ) as string[];
      const ruleSets = ruleSetIds.length
        ? await (prisma as any).repricerRuleSet.findMany({
            where: { id: { in: ruleSetIds } },
            select: {
              id: true,
              name: true,
              isActive: true,
              chainAfterDays: true,
              followUpRuleSetId: true,
              rule1Strategy: true,
              rule1PriceReference: true,
              rule1MinRoiPct: true,
              rule1MaxRoiPct: true,
              rule1MinProfit: true,
              rule1MaxProfit: true,
              rule1MinListPrice: true,
              rule1MaxListPrice: true,
              rule1EndsAt: true,
              rule1IgnoreFbm: true,
            },
          })
        : [];

      const logs = await (prisma as any).repricerLog.findMany({
        where: { productId: p.id },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          createdAt: true,
          kind: true,
          message: true,
          prevPrice: true,
          nextPrice: true,
          context: true,
        },
      });

      // Recompute ROI at the current listed price using stored estimate fees.
      const num = (v: unknown) => (v == null ? null : Number(v));
      const price = num(p.currentListedPrice);
      const cost = num(p.costOfGoods);
      const ref = Math.abs(num(p.estimatedReferralFeePerUnit) ?? 0);
      const fba = Math.abs(num(p.estimatedFbaFeePerUnit) ?? 0);
      let dig = Math.abs(num(p.estimatedDigitalServiceFeePerUnit) ?? 0);
      if (dig < 1e-9 && (ref > 1e-9 || fba > 1e-9)) dig = Math.round((ref + fba) * 0.02 * 100) / 100;
      const feeSum = ref + fba + dig;
      const rollup = Math.abs(num(p.estimatedAmazonFeePerUnit) ?? 0);
      const feeUsed = feeSum > 1e-9 ? feeSum : rollup;
      const roiAtCurrent =
        price != null && cost != null && cost > 0
          ? ((price - feeUsed - cost) / cost) * 100
          : null;
      // Referral as % of price — to expose frozen/stale referral estimates.
      const refPctOfPrice = price != null && price > 0 ? (ref / price) * 100 : null;

      out.push({
        product: {
          id: p.id,
          sku: p.sku,
          asin: p.asin,
          currentListedPrice: price,
          currentListedPriceUpdatedAt: p.currentListedPriceUpdatedAt,
          costOfGoods: cost,
          fees: {
            estimatedReferralFeePerUnit: ref,
            estimatedFbaFeePerUnit: fba,
            estimatedDigitalServiceFeePerUnit: dig,
            estimatedAmazonFeePerUnit_rollup: rollup,
            feeUsedByRepricer: feeUsed,
            referralAsPctOfCurrentPrice: refPctOfPrice,
          },
          inventory: p.inventory,
        },
        derived: { roiAtCurrentPrice_pct: roiAtCurrent },
        selected,
        ruleSets,
        recentLogs: logs,
      });
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ asin, matches: out.length, out }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
