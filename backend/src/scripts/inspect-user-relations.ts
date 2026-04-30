import { PrismaClient } from '@prisma/client';

async function main() {
  const userId = process.argv[2]?.trim();
  if (!userId) {
    throw new Error('Usage: inspect-user-relations.ts <userId>');
  }
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, clerkId: true, createdAt: true },
    });
    if (!user) {
      // eslint-disable-next-line no-console
      console.log('No user found for id', userId);
      return;
    }

    const [
      orders,
      orderItems,
      products,
      purchases,
      sellerAccounts,
      subscriptions,
      orgMemberships,
      marketplaceSettings,
      inventory,
      inventoryByMarketplace,
      shipments,
      asinSellingEligibilities,
      initialSyncProgress,
    ] = await Promise.all([
      prisma.order.count({ where: { userId } }),
      prisma.orderItem.count({ where: { userId } }),
      prisma.product.count({ where: { userId } }),
      prisma.purchase.count({ where: { userId } }),
      prisma.sellerAccount.count({ where: { userId } }),
      prisma.subscription.count({ where: { userId } }),
      (prisma as any).organizationMembership.count({ where: { userId } }),
      (prisma as any).userMarketplaceSetting.count({ where: { userId } }),
      prisma.inventory.count({ where: { userId } }),
      prisma.inventoryByMarketplace.count({ where: { userId } }),
      prisma.shipment.count({ where: { userId } }),
      prisma.asinSellingEligibility.count({ where: { userId } }),
      prisma.initialSyncProgress.count({ where: { userId } }),
    ]);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          user,
          relations: {
            orders,
            orderItems,
            products,
            purchases,
            sellerAccounts,
            subscriptions,
            orgMemberships,
            marketplaceSettings,
            inventory,
            inventoryByMarketplace,
            shipments,
            asinSellingEligibilities,
            initialSyncProgress,
          },
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

