import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();
const uid = process.argv[2] ?? '060668d6-460f-4874-8143-bfe8cf61188b';

async function main() {
  const acct = await p.sellerAccount.findUnique({
    where: { userId_marketplace: { userId: uid, marketplace: 'amazon' } },
    select: { ordersLastSyncedAt: true, sellerId: true },
  });
  const recent = await p.orderItem.findMany({
    where: { userId: uid },
    orderBy: { orderDate: 'desc' },
    take: 10,
    select: {
      orderId: true,
      orderDate: true,
      sku: true,
      revenueTotal: true,
      order: { select: { amazonOrderStatus: true } },
    },
  });
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const ordersNoItems = await p.order.findMany({
    where: {
      userId: uid,
      orderDate: { gte: since },
      orderItems: { none: {} },
    },
    select: { orderId: true, orderDate: true, amazonOrderStatus: true },
    take: 20,
  });
  const headerOnly = await p.order.findMany({
    where: { userId: uid, orderDate: { gte: since } },
    select: {
      orderId: true,
      orderDate: true,
      amazonOrderStatus: true,
      _count: { select: { orderItems: true } },
    },
    orderBy: { orderDate: 'desc' },
  });
  console.log(JSON.stringify({ acct, recent, ordersNoItems, headerOnly }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
