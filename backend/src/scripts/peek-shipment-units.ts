import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();

async function main() {
  const ids = process.argv.slice(2);
  const targets =
    ids.length > 0
      ? ids
      : ['FBA15L5G56Z8', 'FBA15LW48VM4'];

  for (const sid of targets) {
    const rows = await p.shipment.findMany({
      where: { shipmentId: sid },
      include: {
        itemLines: { orderBy: { quantityShipped: 'desc' } },
        _count: { select: { itemLines: true } },
      },
    });
    console.log('---', sid, `(${rows.length} row(s)) ---`);
    for (const r of rows) {
      const lineSent = r.itemLines.reduce((s, l) => s + l.quantityShipped, 0);
      const lineRecv = r.itemLines.reduce((s, l) => s + l.quantityReceived, 0);
      console.log({
        id: r.id,
        userId: r.userId,
        status: r.shipmentStatus,
        unitsSent: r.unitsSent,
        unitsReceived: r.unitsReceived,
        unitsMissing: r.unitsMissing,
        lineCount: r._count.itemLines,
        lineSent,
        lineRecv,
      });
    }
  }

  const withMissing = await p.shipment.findMany({
    where: { unitsMissing: { gt: 0 } },
    select: {
      shipmentId: true,
      unitsSent: true,
      unitsReceived: true,
      unitsMissing: true,
      userId: true,
    },
    orderBy: { unitsMissing: 'desc' },
    take: 15,
  });
  console.log('\nrows with unitsMissing > 0:', JSON.stringify(withMissing, null, 2));
}

main().finally(() => p.$disconnect());
