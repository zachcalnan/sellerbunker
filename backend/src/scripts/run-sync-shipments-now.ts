/**
 * One-off: sync FBA shipments for an org member.
 *
 * Usage (from `backend/`):
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register src/scripts/run-sync-shipments-now.ts
 *
 * Optional env:
 *   SYNC_SHIPMENTS_USER_ID=<uuid>  (default zach org canonical)
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AmazonService } from '../amazon/amazon.service';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_USER = '060668d6-460f-4874-8143-bfe8cf61188b';

async function main() {
  const userId = process.env.SYNC_SHIPMENTS_USER_ID?.trim() || DEFAULT_USER;
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const prisma = app.get(PrismaService);
    const amazon = app.get(AmazonService);
    const membership = await prisma.organizationMembership.findFirst({
      where: { userId },
      select: { orgId: true },
    });
    if (!membership) {
      console.error('No org for user', userId);
      process.exitCode = 1;
      return;
    }
    console.log('syncShipments orgId=', membership.orgId, 'userId=', userId);
    const result = await amazon.syncShipments(membership.orgId, userId);
    console.log('synced', result.synced, 'errors', result.errors.length);
    if (result.errors.length > 0) {
      console.log(result.errors.slice(0, 20));
    }
    const sample = await prisma.shipment.findMany({
      where: { userId },
      orderBy: { unitsMissing: 'desc' },
      take: 5,
      select: {
        shipmentId: true,
        unitsSent: true,
        unitsReceived: true,
        unitsMissing: true,
        _count: { select: { itemLines: true } },
      },
    });
    console.log('top shipments after sync:', sample);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
