import { PrismaClient } from '@prisma/client';

async function main() {
  const orgFilter = (process.argv[2] ?? '').trim();
  const prisma = new PrismaClient();
  try {
    const orgs = await prisma.organization.findMany({
      where: orgFilter ? { OR: [{ name: { contains: orgFilter, mode: 'insensitive' } }, { id: orgFilter }] } : undefined,
      select: { id: true, name: true, repricerLastEngineAt: true },
    });
    for (const o of orgs) {
      const selectedWithRule = await (prisma as any).repricerSelectedSku.count({
        where: { orgId: o.id, enabled: true, ruleSetId: { not: null } },
      });
      const logs = await (prisma as any).repricerLog.findMany({
        where: { orgId: o.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          createdAt: true,
          sku: true,
          message: true,
          kind: true,
          context: true,
        },
      });
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            org: o.name,
            orgId: o.id,
            repricerLastEngineAt: o.repricerLastEngineAt,
            selectedWithRule,
            recentLogs: logs.map((l: any) => ({
              at: l.createdAt,
              sku: l.sku,
              kind: l.kind,
              message: l.message,
              dryRun: l.context?.dryRun,
              liveAmazonUpdate: l.context?.liveAmazonUpdate,
              gateReason: l.context?.gateReason,
            })),
          },
          null,
          2,
        ),
      );
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const logs24 = await (prisma as any).repricerLog.findMany({
        where: { orgId: o.id, createdAt: { gte: since } },
        select: { message: true, kind: true, context: true },
      });
      const counts: Record<string, number> = {};
      for (const l of logs24) {
        let key = 'other';
        const m = String(l.message ?? '');
        if (m.includes('Amazon listing price updated')) key = 'price_updated';
        else if (m.includes('DRY-RUN')) key = 'dry_run';
        else if (m.includes('No change') || m.includes('Leaving price unchanged')) key = 'unchanged';
        else if (l.context?.gateReason === 'cooldown' || m.toLowerCase().includes('cooldown')) key = 'cooldown';
        else if (m.includes('out of stock')) key = 'out_of_stock';
        else if (m.includes('price update failed')) key = 'amazon_patch_failed';
        else if (m.includes('missing COGS')) key = 'missing_cogs';
        counts[key] = (counts[key] ?? 0) + 1;
      }
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ logSummary24h: counts }, null, 2));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
