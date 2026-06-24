import { PrismaClient } from '@prisma/client';

async function main() {
  const orderId = process.argv[2]?.trim() || '204-9066901-8902716';
  const prisma = new PrismaClient();
  try {
    const byOrder = await prisma.order.findMany({
      where: { orderId: orderId },
      include: { orderItems: true },
    });
    const bySku = await prisma.product.findMany({
      where: { OR: [{ sku: '62-LY3T-OS0P' }, { asin: 'B0FQSRCM57' }] },
      select: { id: true, sku: true, asin: true, userId: true },
    });
    const recent = await prisma.order.findMany({
      where: { orderDate: { gte: new Date('2026-06-24T00:00:00Z') } },
      orderBy: { orderDate: 'desc' },
      take: 15,
      select: {
        orderId: true,
        orderDate: true,
        amazonOrderStatus: true,
        marketplace: true,
        userId: true,
      },
    });
    const sellerAccounts = await prisma.sellerAccount.findMany({
      where: { marketplace: 'amazon' },
      select: {
        userId: true,
        ordersLastSyncedAt: true,
        isActive: true,
      },
      take: 10,
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ orderId, byOrder, bySku, recent, sellerAccounts }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
