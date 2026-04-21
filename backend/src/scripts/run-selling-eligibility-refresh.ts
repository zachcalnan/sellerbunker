/**
 * One-off: SP-API Listings Restrictions → upsert `asin_selling_eligibility` for one user (default: rugby account).
 *
 * Usage (from `backend/`):
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register src/scripts/run-selling-eligibility-refresh.ts
 *
 * Optional env:
 *   SELLING_ELIGIBILITY_USER_EMAIL=...   (default: same as extended-order-history dedicated account)
 *   AMAZON_SELLING_ELIGIBILITY_REFRESH_LIMIT=5000   (default; max 5000 per run, UK marketplace only)
 *   AMAZON_SELLING_ELIGIBILITY_REFRESH_DELAY_MS=250
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AmazonService } from '../amazon/amazon.service';
import { PrismaService } from '../prisma/prisma.service';
import { AMAZON_EXTENDED_ORDER_HISTORY_EMAIL } from '../amazon/amazon-extended-sync.constants';

async function main() {
  const email = (
    process.env.SELLING_ELIGIBILITY_USER_EMAIL ?? AMAZON_EXTENDED_ORDER_HISTORY_EMAIL
  )
    .trim()
    .toLowerCase();
  const limitParsed = Number(process.env.AMAZON_SELLING_ELIGIBILITY_REFRESH_LIMIT ?? 5000);
  const limit = Number.isFinite(limitParsed) ? Math.max(1, Math.min(5000, limitParsed)) : 5000;
  const delayParsed = Number(process.env.AMAZON_SELLING_ELIGIBILITY_REFRESH_DELAY_MS ?? 250);
  const delayMs = Number.isFinite(delayParsed) ? Math.max(0, Math.min(5000, delayParsed)) : 250;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const prisma = app.get(PrismaService);
    const amazon = app.get(AmazonService);

    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, email: true },
    });
    if (!user) {
      console.error(`No user found for email=${email}`);
      process.exitCode = 1;
      return;
    }

    console.log(
      `[selling-eligibility] refreshing userId=${user.id} email=${user.email} limit=${limit} delayMs=${delayMs}`,
    );
    const out = await amazon.refreshAsinSellingEligibilityForUser(user.id, {
      limit,
      delayMs,
    });
    console.log('[selling-eligibility] refresh result:', JSON.stringify(out, null, 2));

    const total = await prisma.asinSellingEligibility.count({
      where: { userId: user.id },
    });
    const canTrue = await prisma.asinSellingEligibility.count({
      where: { userId: user.id, canRestock: true },
    });
    const canFalse = await prisma.asinSellingEligibility.count({
      where: { userId: user.id, canRestock: false },
    });
    console.log(
      `[selling-eligibility] DB rows for user: total=${total} canRestock=true=${canTrue} canRestock=false=${canFalse}`,
    );

    const eligibleSample = await prisma.asinSellingEligibility.findMany({
      where: { userId: user.id, canRestock: true, marketplaceId: 'A1F83G8C2ARO7P' },
      orderBy: { asin: 'asc' },
      take: 25,
      select: { asin: true, canRestock: true, notes: true, source: true, checkedAt: true },
    });
    const blockedSample = await prisma.asinSellingEligibility.findMany({
      where: { userId: user.id, canRestock: false, marketplaceId: 'A1F83G8C2ARO7P' },
      orderBy: { asin: 'asc' },
      take: 25,
      select: { asin: true, canRestock: true, notes: true, source: true, checkedAt: true },
    });
    console.log('[selling-eligibility] sample UK — eligible (canRestock=true, up to 25):');
    console.log(JSON.stringify(eligibleSample, null, 2));
    console.log('[selling-eligibility] sample UK — not eligible (canRestock=false; notes = Amazon reason codes, up to 25):');
    console.log(JSON.stringify(blockedSample, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
