import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();

async function main() {
  const rows = await p.shipment.findMany({
    take: 10,
    orderBy: { updatedAt: 'desc' },
    select: {
      shipmentId: true,
      shipmentStatus: true,
      createdDate: true,
      lastUpdatedDate: true,
      checkedInDate: true,
      deliveryDate: true,
      pickupDate: true,
      unitsReceived: true,
      unitsSent: true,
      checkedInDateIsClosedDate: true,
    },
  });
  console.log(JSON.stringify(rows, null, 2));
}

main()
  .finally(() => p.$disconnect());
