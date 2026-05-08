import { PrismaClient } from '@prisma/client';

function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const asin = process.argv[2]?.trim();
  if (!asin) throw new Error('Usage: inspect-asin-repricer-math.ts <asin>');

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.product.findMany({
      where: { asin },
      select: {
        id: true,
        userId: true,
        sku: true,
        asin: true,
        title: true,
        currentListedPrice: true,
        costOfGoods: true,
        estimatedAmazonFeePerUnit: true,
        estimatedReferralFeePerUnit: true,
        estimatedFbaFeePerUnit: true,
        estimatedDigitalServiceFeePerUnit: true,
      } as any,
      take: 20,
    });

    const out = rows.map((p: any) => {
      const price = toNum(p.currentListedPrice);
      const cogs = toNum(p.costOfGoods);
      const feeRollup = toNum(p.estimatedAmazonFeePerUnit);
      const ref = toNum(p.estimatedReferralFeePerUnit);
      const fba = toNum(p.estimatedFbaFeePerUnit);
      const dig = toNum(p.estimatedDigitalServiceFeePerUnit);
      const feeSum =
        (ref != null ? Math.abs(ref) : 0) +
        (fba != null ? Math.abs(fba) : 0) +
        (dig != null ? Math.abs(dig) : 0);
      const feeUsed = feeSum > 0 ? feeSum : feeRollup != null ? Math.abs(feeRollup) : 0;
      const profit =
        price != null && cogs != null ? price - feeUsed - cogs : null;
      const roiPct =
        profit != null && cogs != null && cogs > 0 ? (profit / cogs) * 100 : null;
      return {
        productId: p.id,
        userId: p.userId,
        sku: p.sku,
        price,
        cogs,
        feeUsed,
        profit,
        roiPct: roiPct != null && Number.isFinite(roiPct) ? Math.round(roiPct * 10) / 10 : null,
      };
    });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ asin, matches: out.length, rows: out }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

