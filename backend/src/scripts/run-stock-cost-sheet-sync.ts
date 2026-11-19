/**
 * One-off: force CURRENT ORDERS sheet stage sync (Delivered / Home/Prep=sent /
 * Final Complete+Returned / sold⇒sent backfill / Final colors).
 *
 * Usage (from `backend/` or inside the API container):
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register src/scripts/run-stock-cost-sheet-sync.ts
 *
 * Optional env:
 *   SYNC_SHEET_ORG_ID=<uuid>
 *   SYNC_SHEET_USER_ID=<uuid>
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AmazonService } from '../amazon/amazon.service';
import { StockCostSheetReadService } from '../amazon/stock-cost-sheet-read.service';
import { PrismaService } from '../prisma/prisma.service';

async function main() {
  const orgId = process.env.SYNC_SHEET_ORG_ID?.trim();
  const userId = process.env.SYNC_SHEET_USER_ID?.trim();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const prisma = app.get(PrismaService);
    const amazon = app.get(AmazonService);
    const sheetRead = app.get(StockCostSheetReadService);

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

    // Force sold→sent (+ format) first so the flip count is accurate.
    console.log('Forcing CURRENT ORDERS sheet sync (sold⇒sent backfill)…');
    const sync = await sheetRead.syncBlue30ReceivedToPurchaseDelivered({
      force: true,
    });
    console.log(
      JSON.stringify(
        {
          attempted: sync.attempted,
          skippedThrottle: sync.skippedThrottle,
          deliveredUpdated: sync.updated,
          homePrepSentUpdated: sync.sentUpdated,
          completeUpdated: sync.completeUpdated,
          returnedUpdated: sync.returnedUpdated,
          formatsUpdated: sync.formatsUpdated,
          errors: sync.errors,
          sentSheetRows: sync.sentUpdates.map((u) => u.sheetRow),
        },
        null,
        2,
      ),
    );
    console.log(
      `Home/Prep cells flipped to sent (this force pass): ${sync.sentUpdated}`,
    );

    // Full pipeline with held/sold maps (Complete/Returned FIFO + prep clamps).
    // Bypass SWR caches so script totals reflect cells we just wrote.
    if (targetOrgId) {
      console.log(`Running stock-cost pipeline for org ${targetOrgId}…`);
      await sheetRead.invalidatePipelineCache();
      const pipeline = await amazon.getStockCostPipeline(targetOrgId, undefined, {
        bypassCache: true,
        awaitSheetSync: true,
      });
      console.log('Pipeline note:', pipeline.note);
      console.log(
        `stockPurchased=${pipeline.stockPurchased.qty} prep=${pipeline.stockForPrep.qty} sent=${pipeline.stockSent.qty} available=${pipeline.availableStock.qty}`,
      );
    } else {
      console.log(
        'No org resolved — skipped held/sold pipeline pass (sold⇒sent already forced).',
      );
    }
  } finally {
    await app.close();
  }
}

void main();
