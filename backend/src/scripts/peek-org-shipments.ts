import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();
const orgId = process.argv[2];
if (!orgId) {
  console.error('Usage: peek-org-shipments.ts <orgId>');
  process.exit(1);
}

async function main() {
  const members = await p.organizationMembership.findMany({
    where: { orgId },
    select: { userId: true, user: { select: { email: true } } },
  });
  const userIds = members.map((m) => m.userId);
  const rows = await p.shipment.findMany({
    where: { userId: { in: userIds } },
    orderBy: { updatedAt: 'desc' },
    take: 15,
    select: {
      userId: true,
      shipmentId: true,
      shipmentName: true,
      unitsSent: true,
      shipmentStatus: true,
      createdDate: true,
      updatedAt: true,
      _count: { select: { itemLines: true } },
    },
  });
  console.log('members:', members);
  console.log('recent shipments:', JSON.stringify(rows, null, 2));
}

main().finally(() => p.$disconnect());
