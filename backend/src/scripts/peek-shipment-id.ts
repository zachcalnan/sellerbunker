import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();
const shipmentId = process.argv[2];
if (!shipmentId) {
  console.error('Usage: peek-shipment-id.ts FBA15...');
  process.exit(1);
}

async function main() {
  const rows = await p.shipment.findMany({
    where: { shipmentId },
    include: {
      itemLines: true,
      _count: { select: { itemLines: true } },
    },
  });
  console.log(JSON.stringify(rows, null, 2));
}

main().finally(() => p.$disconnect());
