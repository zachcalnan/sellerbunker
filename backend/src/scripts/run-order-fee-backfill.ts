/**
 * One-off: re-pull Finances fees into `order_items` for every active seller (or one user).
 *
 * Usage (from `backend/`):
 *   npx ts-node -r tsconfig-paths/register src/scripts/run-order-fee-backfill.ts
 *
 * Optional env:
 *   FEE_BACKFILL_DAYS=365   (default 365, max 365)
 *   FEE_BACKFILL_USER_ID=<uuid>   (only this user if set)
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AmazonService } from '../amazon/amazon.service';
import { PrismaService } from '../prisma/prisma.service';

async function main() {
  const rawDays = Number(process.env.FEE_BACKFILL_DAYS ?? 365);
  const days = Number.isFinite(rawDays)
    ? Math.max(1, Math.min(365, Math.floor(rawDays)))
    : 365;
  const singleUserId = process.env.FEE_BACKFILL_USER_ID?.trim() || null;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const prisma = app.get(PrismaService);
    const amazon = app.get(AmazonService);

    const rows = await prisma.sellerAccount.findMany({
      where: { isActive: true },
      select: { userId: true },
      distinct: ['userId'],
    });

    let targets = rows;
    if (singleUserId) {
      targets = rows.filter((r) => r.userId === singleUserId);
      if (targets.length === 0) {
        console.error(
          `No active seller account for FEE_BACKFILL_USER_ID=${singleUserId}`,
        );
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
        `[fee-backfill] starting userId=${userId.slice(0, 8)}… days=${days}`,
      );
      const result = await amazon.backfillOrderItems(userId, days);
      console.log(`[fee-backfill] finished userId=${userId.slice(0, 8)}…`, result);
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
