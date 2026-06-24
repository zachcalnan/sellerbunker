import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const now = new Date();
    const accounts = await prisma.sellerAccount.findMany({
      where: { marketplace: 'amazon', isActive: true },
      select: { userId: true, sellerId: true, ordersLastSyncedAt: true },
      orderBy: { ordersLastSyncedAt: 'desc' },
    });
    const sellerAccounts = accounts.map((a) => ({
      userId: a.userId,
      sellerId: a.sellerId,
      ordersLastSyncedAt: a.ordersLastSyncedAt?.toISOString() ?? null,
      minutesAgo:
        a.ordersLastSyncedAt != null
          ? Math.round((now.getTime() - a.ordersLastSyncedAt.getTime()) / 60_000)
          : null,
    }));
    const recentOrders = await prisma.order.findMany({
      where: { orderDate: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        orderId: true,
        orderDate: true,
        createdAt: true,
        amazonOrderStatus: true,
        userId: true,
      },
    });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          checkedAt: now.toISOString(),
          databaseHost: (process.env.DATABASE_URL ?? '').includes('render.com')
            ? 'render-postgres'
            : 'other',
          localEnv: {
            REDIS_URL: process.env.REDIS_URL ?? null,
            ENABLE_AMAZON_SYNC_SCHEDULER:
              process.env.ENABLE_AMAZON_SYNC_SCHEDULER ?? '(default true)',
            INTERNAL_REDIS_URL: process.env.INTERNAL_REDIS_URL ? 'set' : 'unset',
          },
          sellerAccounts,
          latestOrderWrites: recentOrders,
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
