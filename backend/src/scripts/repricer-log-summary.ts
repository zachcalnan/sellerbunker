import { PrismaClient } from '@prisma/client';

async function main() {
  const orgId = process.argv[2]?.trim();
  if (!orgId) throw new Error('Usage: repricer-log-summary.ts <orgId>');
  const prisma = new PrismaClient();
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const logs = await (prisma as any).repricerLog.findMany({
      where: { orgId, createdAt: { gte: since } },
      select: { sku: true, message: true, kind: true },
    });
    const bySku = new Map<
      string,
      { errors: number; updated: number; unchanged: number; last: string }
    >();
    for (const l of logs) {
      const k = String(l.sku ?? '');
      if (!bySku.has(k)) {
        bySku.set(k, { errors: 0, updated: 0, unchanged: 0, last: '' });
      }
      const b = bySku.get(k)!;
      const m = String(l.message ?? '');
      b.last = m.slice(0, 120);
      if (m.includes('Amazon listing price updated')) b.updated++;
      else if (m.includes('unchanged') || m.includes('No change')) b.unchanged++;
      else if (l.kind === 'error') b.errors++;
    }
    const arr = [...bySku.entries()]
      .map(([sku, v]) => ({ sku, ...v }))
      .sort((a, b) => b.errors - a.errors);
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          orgId,
          hours: 24,
          logLines: logs.length,
          skusTouched: arr.length,
          totalUpdated: arr.reduce((s, x) => s + x.updated, 0),
          topByErrors: arr.slice(0, 15),
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
