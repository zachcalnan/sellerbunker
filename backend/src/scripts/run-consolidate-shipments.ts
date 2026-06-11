import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();
const orgId = process.argv[2] ?? '0f491501-90a4-4c45-ab1d-3c2a70fa5489';

async function main() {
  const members = await p.organizationMembership.findMany({
    where: { orgId },
    select: { userId: true },
  });
  const memberIds = members.map((m) => m.userId);
  const accounts = await p.sellerAccount.findMany({
    where: { userId: { in: memberIds }, marketplace: 'amazon', isActive: true },
    select: { userId: true, sellerId: true, ordersLastSyncedAt: true, updatedAt: true },
  });
  let canonical = memberIds[0]!;
  let bestTs = -1;
  for (const acc of accounts) {
    const ts = Math.max(
      acc.ordersLastSyncedAt?.getTime() ?? 0,
      acc.updatedAt.getTime(),
    );
    if (ts > bestTs) {
      bestTs = ts;
      canonical = acc.userId;
    }
  }

  const before = await p.shipment.findMany({
    where: { userId: { in: memberIds } },
    select: { shipmentId: true, userId: true, unitsSent: true, unitsMissing: true },
  });
  console.log('before count', before.length);

  const readUserIds = [...new Set(memberIds)];
  const sellerIds = [
    ...new Set(
      accounts
        .map((a) => (a.sellerId != null ? String(a.sellerId).trim().toUpperCase() : ''))
        .filter(Boolean),
    ),
  ];
  if (sellerIds.length > 0) {
    const linked = await p.sellerAccount.findMany({
      where: { marketplace: 'amazon', isActive: true, sellerId: { in: sellerIds } },
      select: { userId: true },
    });
    for (const a of linked) readUserIds.push(a.userId);
  }

  const allRows = await p.shipment.findMany({
    where: { userId: { in: [...new Set(readUserIds)] } },
    include: { itemLines: true },
  });
  const groups = new Map<string, typeof allRows>();
  for (const row of allRows) {
    const arr = groups.get(row.shipmentId) ?? [];
    arr.push(row);
    groups.set(row.shipmentId, arr);
  }

  let removed = 0;
  for (const [shipmentId, duplicates] of groups) {
    if (
      duplicates.length === 1 &&
      duplicates[0]!.userId === canonical
    ) {
      continue;
    }

    const best = [...duplicates].sort((a, b) => {
      const aLines = a.itemLines.length;
      const bLines = b.itemLines.length;
      if (bLines !== aLines) return bLines - aLines;
      if (b.unitsSent !== a.unitsSent) return b.unitsSent - a.unitsSent;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    })[0]!;

    const unitsSent = Math.max(...duplicates.map((d) => d.unitsSent));
    const unitsReceived = Math.max(...duplicates.map((d) => d.unitsReceived));
    const unitsMissing = Math.max(...duplicates.map((d) => d.unitsMissing));
    const lineByKey = new Map<string, (typeof best.itemLines)[number]>();
    for (const row of duplicates) {
      for (const line of row.itemLines) {
        const key = `${line.sellerSku}\0${line.fnsku}`;
        const prev = lineByKey.get(key);
        if (!prev || line.quantityShipped > prev.quantityShipped) {
          lineByKey.set(key, line);
        }
      }
    }
    const itemLines = [...lineByKey.values()];

    const canonicalRow = await p.shipment.upsert({
      where: { userId_shipmentId: { userId: canonical, shipmentId } },
      create: {
        userId: canonical,
        shipmentId,
        shipmentName: best.shipmentName,
        shipmentStatus: best.shipmentStatus,
        destinationFulfillmentCenterId: best.destinationFulfillmentCenterId,
        createdDate: best.createdDate,
        lastUpdatedDate: best.lastUpdatedDate,
        unitsSent,
        unitsReceived,
        unitsDamaged: Math.max(...duplicates.map((d) => d.unitsDamaged)),
        unitsDisposed: Math.max(...duplicates.map((d) => d.unitsDisposed)),
        unitsMissing,
        pickupDate: best.pickupDate,
        deliveryDate: best.deliveryDate,
        damageClosedDate: best.damageClosedDate,
        checkInDurationDays: best.checkInDurationDays,
        checkedInDate: best.checkedInDate,
        checkedInDateIsClosedDate: best.checkedInDateIsClosedDate,
        transportStatus: best.transportStatus,
      },
      update: {
        shipmentName: best.shipmentName,
        shipmentStatus: best.shipmentStatus,
        destinationFulfillmentCenterId: best.destinationFulfillmentCenterId,
        createdDate: best.createdDate,
        lastUpdatedDate: best.lastUpdatedDate,
        unitsSent,
        unitsReceived,
        unitsDamaged: Math.max(...duplicates.map((d) => d.unitsDamaged)),
        unitsDisposed: Math.max(...duplicates.map((d) => d.unitsDisposed)),
        unitsMissing,
        pickupDate: best.pickupDate,
        deliveryDate: best.deliveryDate,
        damageClosedDate: best.damageClosedDate,
        checkInDurationDays: best.checkInDurationDays,
        checkedInDate: best.checkedInDate,
        checkedInDateIsClosedDate: best.checkedInDateIsClosedDate,
        transportStatus: best.transportStatus,
      },
    });

    if (itemLines.length > 0) {
      await p.shipmentItemLine.deleteMany({ where: { shipmentId: canonicalRow.id } });
      await p.shipmentItemLine.createMany({
        data: itemLines.map((line) => ({
          shipmentId: canonicalRow.id,
          sellerSku: line.sellerSku,
          fnsku: line.fnsku,
          asin: line.asin,
          productTitle: line.productTitle,
          quantityShipped: line.quantityShipped,
          quantityReceived: line.quantityReceived,
          quantityDamaged: line.quantityDamaged,
          quantityDisposed: line.quantityDisposed,
        })),
      });
    }

    for (const dup of duplicates) {
      if (dup.id === canonicalRow.id) continue;
      await p.shipment.delete({ where: { id: dup.id } });
      removed += 1;
    }
  }

  const after = await p.shipment.findMany({
    where: { userId: canonical },
    select: {
      shipmentId: true,
      unitsSent: true,
      unitsReceived: true,
      unitsMissing: true,
      _count: { select: { itemLines: true } },
    },
    orderBy: { unitsMissing: 'desc' },
    take: 10,
  });
  console.log('removed duplicates', removed);
  console.log('canonical user', canonical);
  console.log('top after:', after);
}

main().finally(() => p.$disconnect());
