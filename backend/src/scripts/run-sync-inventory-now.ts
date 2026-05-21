/**
 * One-off: run FBA inventory sync for an org (force, full pagination + SKU backfill).
 *
 * Usage (from `backend/`):
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register src/scripts/run-sync-inventory-now.ts
 *
 * Optional env:
 *   SYNC_INVENTORY_ORG_ID=<uuid>
 *   SYNC_INVENTORY_USER_ID=<uuid>
 *   SYNC_INVENTORY_SKU=LW-43N5-V319   (prints that SKU from DB after sync)
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AmazonService } from '../amazon/amazon.service';
import { PrismaService } from '../prisma/prisma.service';

async function main() {
  const orgId = process.env.SYNC_INVENTORY_ORG_ID?.trim();
  const userId = process.env.SYNC_INVENTORY_USER_ID?.trim();
  const checkSku = process.env.SYNC_INVENTORY_SKU?.trim();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const prisma = app.get(PrismaService);
    const amazon = app.get(AmazonService);

    let targetOrgId = orgId ?? null;
    if (!targetOrgId && userId) {
      const m = await prisma.organizationMembership.findFirst({
        where: { userId },
        select: { orgId: true },
      });
      targetOrgId = m?.orgId ?? null;
    }
    if (!targetOrgId) {
      const acct = await prisma.sellerAccount.findFirst({
        where: { marketplace: 'amazon', isActive: true },
        select: { userId: true },
      });
      if (acct) {
        const m = await prisma.organizationMembership.findFirst({
          where: { userId: acct.userId },
          select: { orgId: true },
        });
        targetOrgId = m?.orgId ?? null;
      }
    }
    if (!targetOrgId) {
      console.error('Set SYNC_INVENTORY_ORG_ID or SYNC_INVENTORY_USER_ID');
      process.exitCode = 1;
      return;
    }

    console.log(`Syncing FBA inventory for org ${targetOrgId}…`);
    const result = await amazon.syncFbaInventory(targetOrgId, userId ?? undefined, {
      force: true,
    });
    console.log('Sync result:', result);

    if (checkSku) {
      const products = await prisma.product.findMany({
        where: { sku: checkSku },
        include: {
          inventory: true,
          inventoryByMarketplace: {
            where: { marketplaceId: 'A1F83G8C2ARO7P' },
          },
        },
      });
      console.log(JSON.stringify(products, null, 2));
    }
  } finally {
    await app.close();
  }
}

void main();
