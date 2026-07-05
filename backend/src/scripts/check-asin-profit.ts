import { PrismaClient } from '@prisma/client';

async function main() {
  const asin = (process.argv[2] ?? 'B0BRYNPN93').toUpperCase();
  const prisma = new PrismaClient();
  try {
    const products = await prisma.product.findMany({
      where: { asin },
      select: {
        sku: true,
        title: true,
        costOfGoods: true,
        currentListedPrice: true,
        estimatedReferralFeePerUnit: true,
        estimatedFbaFeePerUnit: true,
        estimatedDigitalServiceFeePerUnit: true,
        estimatedAmazonFeePerUnit: true,
        inventory: { select: { totalQty: true, availableQty: true } },
      },
    });
    const orders = await prisma.orderItem.findMany({
      where: { asin },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: {
        quantity: true,
        revenueTotal: true,
        profit: true,
        cogsTotal: true,
        amazonFeesTotal: true,
        createdAt: true,
        order: { select: { orderDate: true, amazonOrderStatus: true } },
      },
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ asin, products, recentOrderLines: orders }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
