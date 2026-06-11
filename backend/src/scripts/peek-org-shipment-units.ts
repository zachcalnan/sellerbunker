import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();
const orgId = process.argv[2] ?? '0f491501-90a4-4c45-ab1d-3c2a70fa5489';

async function main() {
  const members = await p.organizationMembership.findMany({
    where: { orgId },
    select: { userId: true, user: { select: { email: true } } },
  });
  const memberIds = members.map((m) => m.userId);
  const accounts = await p.sellerAccount.findMany({
    where: { userId: { in: memberIds }, marketplace: 'amazon', isActive: true },
    select: { userId: true, sellerId: true },
  });
  const sellerIds = [
    ...new Set(accounts.map((a) => String(a.sellerId ?? '').trim().toUpperCase()).filter(Boolean)),
  ];
  const linked = await p.sellerAccount.findMany({
    where: { marketplace: 'amazon', isActive: true, sellerId: { in: sellerIds } },
    select: { userId: true },
  });
  const readUserIds = [...new Set([...memberIds, ...linked.map((a) => a.userId)])];

  const rows = await p.shipment.findMany({
    where: { userId: { in: readUserIds } },
    select: {
      shipmentId: true,
      shipmentStatus: true,
      unitsSent: true,
      unitsReceived: true,
      unitsMissing: true,
      createdDate: true,
      updatedAt: true,
      userId: true,
      _count: { select: { itemLines: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const totalMissing = rows.reduce((s, r) => s + r.unitsMissing, 0);
  const withMissing = rows.filter((r) => r.unitsMissing > 0);
  const zeroDisplay = rows.filter((r) => r.unitsSent === 0 && r.unitsReceived === 0);

  console.log('org', orgId);
  console.log('members', members);
  console.log('readUserIds', readUserIds.length);
  console.log('total shipments', rows.length);
  console.log('totalMissing sum', totalMissing);
  console.log('\nwith missing:', withMissing);
  console.log('\nzero sent+recv count', zeroDisplay.length);
  console.log('sample zeros:', zeroDisplay.slice(0, 8));
}

main().finally(() => p.$disconnect());
