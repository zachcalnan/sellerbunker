import { PrismaClient } from '@prisma/client';

function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const asin = process.argv[2]?.trim();
  if (!asin) throw new Error('Usage: inspect-repricer-asin.ts <asin>');
  const prisma = new PrismaClient();
  try {
    const products = await prisma.product.findMany({
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

    const productIds = products.map((p: any) => p.id);
    const selected = productIds.length
      ? await (prisma as any).repricerSelectedSku.findMany({
          where: { productId: { in: productIds }, enabled: true },
          select: {
            id: true,
            orgId: true,
            productId: true,
            ruleSetId: true,
            ruleSet: true,
          },
        })
      : [];

    const latestLogs = productIds.length
      ? await (prisma as any).repricerLog.findMany({
          where: { productId: { in: productIds } },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { createdAt: true, productId: true, sku: true, message: true, context: true },
        })
      : [];

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          asin,
          products: products.map((p: any) => ({
            id: p.id,
            userId: p.userId,
            sku: p.sku,
            price: toNum(p.currentListedPrice),
            cogs: toNum(p.costOfGoods),
            feeRollup: toNum(p.estimatedAmazonFeePerUnit),
            ref: toNum(p.estimatedReferralFeePerUnit),
            fba: toNum(p.estimatedFbaFeePerUnit),
            dig: toNum(p.estimatedDigitalServiceFeePerUnit),
          })),
          selected,
          latestLogs,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

