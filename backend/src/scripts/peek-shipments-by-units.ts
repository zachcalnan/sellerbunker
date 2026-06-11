import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();

async function main() {
  const arg = process.argv[2];
  const exact = arg != null && arg.length > 0 && !arg.includes('.');
  const minUnits = Number(arg ?? 25);
  const rows = await p.shipment.findMany({
    where: exact ? { unitsSent: minUnits } : { unitsSent: { gte: minUnits } },
    orderBy: [{ unitsSent: 'desc' }, { updatedAt: 'desc' }],
    take: 20,
    select: {
      userId: true,
      shipmentId: true,
      shipmentName: true,
      shipmentStatus: true,
      unitsSent: true,
      unitsReceived: true,
      createdDate: true,
      updatedAt: true,
      _count: { select: { itemLines: true } },
    },
  });
  console.log(`Shipments with unitsSent >= ${minUnits}: ${rows.length}`);
  console.log(JSON.stringify(rows, null, 2));

  const dupes = await p.$queryRaw<
    Array<{ shipment_id: string; cnt: bigint }>
  >`
    SELECT shipment_id, COUNT(*)::bigint AS cnt
    FROM shipments
    GROUP BY shipment_id
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 10
  `;
  console.log('\nDuplicate shipment_id rows (same FBA id, different user):');
  console.log(JSON.stringify(dupes, (_, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
}

main().finally(() => p.$disconnect());
