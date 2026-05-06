import { PrismaClient } from '@prisma/client';

async function main() {
  const asin = process.argv[2]?.trim();
  const orgId = process.argv[3]?.trim(); // optional
  if (!asin) throw new Error('Usage: debug-asin-profit-math.ts <asin> [orgId]');
  const prisma = new PrismaClient();
  try {
    const where: any = { asin, marketplace: { in: ['amazon'] } };
    if (orgId) {
      // org aggregation: pick all userIds in org
      const memberships = await (prisma as any).organizationMembership.findMany({
        where: { orgId },
        select: { userId: true },
      });
      where.userId = { in: memberships.map((m: any) => m.userId) };
    }
    const sums = await (prisma as any).orderItem.aggregate({
      where,
      _sum: {
        quantity: true,
        revenueTotal: true,
        amazonFeesTotal: true,
        profit: true,
        cogsTotal: true,
      },
    });
    const q = Number(sums?._sum?.quantity ?? 0);
    const revenue = Number(sums?._sum?.revenueTotal ?? 0);
    const fees = Number(sums?._sum?.amazonFeesTotal ?? 0);
    const profit = Number(sums?._sum?.profit ?? 0);
    const cogs = Number(sums?._sum?.cogsTotal ?? 0);
    const per = (x: number) => (q > 0 ? x / q : null);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          asin,
          qty: q,
          sums: { revenue, fees, profit, cogs },
          perUnit: {
            revenue: per(revenue),
            fees: per(fees),
            profit: per(profit),
            cogs: per(cogs),
          },
          feeSignHint: fees > 0 ? 'fees appear POSITIVE (subtract)' : fees < 0 ? 'fees appear NEGATIVE (add)' : 'fees are 0',
          netAfterFees_ifAdd: q > 0 ? (revenue + fees) / q : null,
          netAfterFees_ifSub: q > 0 ? (revenue - fees) / q : null,
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

