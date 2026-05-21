/**
 * One-off: run syncRecentOrdersToDb for active seller(s).
 *
 * Usage (from `backend/`):
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register src/scripts/run-sync-orders-now.ts
 *
 * Optional env:
 *   SYNC_ORDERS_DAYS=30
 *   SYNC_ORDERS_USER_ID=<uuid>
 *   SYNC_ORDERS_IGNORE_CURSOR=1   (default 1)
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AmazonService } from '../amazon/amazon.service';
import { PrismaService } from '../prisma/prisma.service';

const TARGET_ORDER = '202-4890946-5805126';

async function main() {
  const rawDays = Number(process.env.SYNC_ORDERS_DAYS ?? 30);
  const days = Number.isFinite(rawDays)
    ? Math.max(1, Math.min(365, Math.floor(rawDays)))
    : 30;
  const singleUserId = process.env.SYNC_ORDERS_USER_ID?.trim() || null;
  const ignoreCursor =
    process.env.SYNC_ORDERS_IGNORE_CURSOR !== '0' &&
    process.env.SYNC_ORDERS_IGNORE_CURSOR !== 'false';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const prisma = app.get(PrismaService);
    const amazon = app.get(AmazonService);

    const rows = await prisma.sellerAccount.findMany({
      where: { marketplace: 'amazon', isActive: true },
      select: { userId: true },
      distinct: ['userId'],
    });

    let targets = rows;
    if (singleUserId) {
      targets = rows.filter((r) => r.userId === singleUserId);
      if (targets.length === 0) {
        console.error(`No active amazon seller for SYNC_ORDERS_USER_ID=${singleUserId}`);
        process.exitCode = 1;
        return;
      }
    }

    if (targets.length === 0) {
      console.log('No active seller accounts; nothing to do.');
      return;
    }

    for (const { userId } of targets) {
      console.log(
        `[sync-orders] starting userId=${userId.slice(0, 8)}… days=${days} ignoreCursor=${ignoreCursor}`,
      );
      await amazon.syncRecentOrdersToDb(userId, {
        days,
        ignoreCursor,
      });
      console.log(`[sync-orders] finished userId=${userId.slice(0, 8)}…`);

      const hit = await prisma.order.findFirst({
        where: { userId, orderId: TARGET_ORDER },
        select: { id: true, amazonOrderStatus: true, orderDate: true },
      });
      const lines = await prisma.orderItem.findMany({
        where: { userId, orderId: TARGET_ORDER },
        select: { id: true, sku: true, revenueTotal: true, profit: true, quantity: true },
      });
      console.log(`[sync-orders] check ${TARGET_ORDER}:`, {
        parentOrder: hit,
        lineCount: lines.length,
        lines,
      });
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
