import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const accounts = await prisma.sellerAccount.findMany({
      where: { marketplace: 'amazon', isActive: true },
      select: {
        userId: true,
        sellerId: true,
        ordersLastSyncedAt: true,
        user: {
          select: {
            email: true,
            activeOrgId: true,
            subscriptions: { select: { status: true, trialEndAt: true } },
          },
        },
      },
      orderBy: { ordersLastSyncedAt: 'desc' },
    });

    const rows: Array<Record<string, unknown>> = [];
    for (const a of accounts) {
      const sub = a.user.subscriptions[0];
      const hasAccess =
        ['1', 'true', 'yes', 'on'].includes(
          (process.env.BYPASS_BILLING ?? '').toLowerCase(),
        ) ||
        (sub != null &&
          (sub.status === 'active' ||
            sub.status === 'trialing' ||
            (sub.status === 'canceled' &&
              sub.trialEndAt != null &&
              new Date() < sub.trialEndAt)));
      rows.push({
        sellerId: a.sellerId,
        userId: a.userId,
        email: a.user.email,
        activeOrgId: a.user.activeOrgId,
        subscriptionStatus: sub?.status ?? 'no-sub-row',
        syncEligible: hasAccess,
        ordersLastSyncedAt: a.ordersLastSyncedAt?.toISOString() ?? null,
      });
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          BYPASS_BILLING: process.env.BYPASS_BILLING ?? '(unset)',
          ENABLE_AMAZON_SYNC_SCHEDULER:
            process.env.ENABLE_AMAZON_SYNC_SCHEDULER ?? '(default true)',
          accounts: rows,
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
