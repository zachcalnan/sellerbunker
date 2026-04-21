import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AmazonService } from './amazon.service';
import { AmazonSyncService } from './amazon-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const SYNC_PROGRESS_TTL = 24 * 60 * 60; // 24h

interface AmazonSyncJobData {
  userId?: string;
  orgId?: string;
}

@Processor('amazon-sync')
export class AmazonSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(AmazonSyncProcessor.name);
  constructor(
    private readonly amazonService: AmazonService,
    private readonly amazonSyncService: AmazonSyncService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  /** Persist core sync progress and phase to Redis so GET /sync-progress can return it. */
  private async setCoreSyncProgress(userId: string, progress: number, phase?: string): Promise<void> {
    const key = `amazon-initial-sync:${userId}`;
    const p = Math.min(100, Math.max(0, progress));
    const data: { progress: number; phase?: string } = { progress: p };
    if (phase != null) data.phase = phase;
    await this.redis.set(key, JSON.stringify(data), SYNC_PROGRESS_TTL);
  }

  private async setFeeSyncProgress(
    userId: string,
    progress: number,
    phase?: string,
  ): Promise<void> {
    const key = `amazon-fee-sync:${userId}`;
    const p = Math.min(100, Math.max(0, progress));
    const data: { progress: number; phase?: string } = { progress: p };
    if (phase != null && phase.trim() !== '') data.phase = phase.trim();
    await this.redis.set(key, JSON.stringify(data), SYNC_PROGRESS_TTL);
  }

  /** Org for Amazon sync: active org or first membership. */
  private async resolveOrgIdForUser(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { activeOrgId: true },
    });
    let orgId = user?.activeOrgId ?? null;
    if (!orgId) {
      const membership = await this.prisma.organizationMembership.findFirst({
        where: { userId },
        select: { orgId: true },
      });
      orgId = membership?.orgId ?? null;
    }
    return orgId;
  }

  /**
   * Full catalog pass after the mini initial sync: all FBA inventory, shipments, then enqueue fee-sync.
   * Shared by the post-initial-sync job (retries / legacy) and inline continuation right after full-sync.
   */
  private async executePostInitialCatalogSync(userId: string, orgId: string): Promise<void> {
    this.logger.log(`[post-initial-sync] Starting for userId=${userId}, orgId=${orgId}`);
    await this.setFeeSyncProgress(
      userId,
      0,
      'Syncing full inventory & shipments',
    );
    // Do NOT sync full orders here: that was causing many orders to appear right after the bar moved.
    // Full 30-day order backfill is done by recurring orders-batch-sync.
    try {
      await this.amazonService.syncFbaInventory(orgId, userId);
      this.logger.log(`[post-initial-sync] full inventory done`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[post-initial-sync] FBA inventory failed for userId=${userId}, orgId=${orgId}: ${msg}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }
    try {
      await this.amazonService.syncShipments(orgId, userId);
      this.logger.log(`[post-initial-sync] shipments done`);
    } catch (shipErr) {
      const msg = shipErr instanceof Error ? shipErr.message : String(shipErr);
      this.logger.warn(`[post-initial-sync] shipments failed (non-fatal): ${msg}`);
    }
    // Mini sync only pulled a handful of orders (capped). Pull 30d here for everyone; the
    // allowlisted account gets a one-time 365d ignoreCursor job on app boot (see bootstrap).
    try {
      await this.amazonService.syncRecentOrdersToDb(userId, { days: 30 });
      this.logger.log(
        `[post-initial-sync] 30-day orders backfill done (userId=${userId.slice(0, 8)}…)`,
      );
    } catch (ordErr) {
      const msg = ordErr instanceof Error ? ordErr.message : String(ordErr);
      this.logger.warn(
        `[post-initial-sync] orders sync failed (non-fatal); orders-batch-sync will retry: ${msg}`,
      );
    }
    await this.amazonSyncService.enqueueFeeSync(userId, orgId);
    this.logger.log(
      `[post-initial-sync] enqueued fee-sync for all products (userId=${userId}); background job may take a while for large catalogs`,
    );
    this.logger.log(`[post-initial-sync] Completed for userId=${userId}, orgId=${orgId}`);
  }

  /**
   * After limited mini sync: full inventory / fees only if the user has paid access (subscription).
   * Unpaid users get the limited pass only; checkout calls enqueueAmazonSyncAfterSubscription to run the rest.
   */
  private async afterInitialMiniSyncComplete(userId: string): Promise<void> {
    const orgId = await this.resolveOrgIdForUser(userId);
    if (!orgId) {
      this.logger.warn(
        `[full-sync] afterInitialMiniSyncComplete: no org for userId=${userId}; skipping post-initial`,
      );
      return;
    }
    const paid = await this.amazonSyncService.userHasPaidAccess(userId);
    if (!paid) {
      this.logger.log(
        `[full-sync] Skipping full catalog sync — no paid subscription yet (userId=${userId}). Runs after checkout.`,
      );
      return;
    }
    await this.executePostInitialCatalogSync(userId, orgId);
    this.logger.log(
      `[full-sync] Ran full catalog sync after mini sync (userId=${userId}, orgId=${orgId})`,
    );
  }

  /** True when initial sync has reached 100%. */
  private async isInitialSyncComplete(userId: string): Promise<boolean> {
    const raw = await this.redis.get(`amazon-initial-sync:${userId}`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { progress?: number };
        const p = Number(parsed?.progress);
        return Number.isFinite(p) && p >= 100;
      } catch {
        return false;
      }
    }
    const row = await this.prisma.initialSyncProgress.findUnique({
      where: { userId },
      select: { progress: true },
    });
    const p = row?.progress ?? 0;
    return Number.isFinite(p) && p >= 100;
  }

  /** Skip org if any member has initial sync still in progress (so batch jobs don't override limited initial sync). */
  private async shouldSkipOrgForBatch(orgId: string): Promise<boolean> {
    const members = await this.prisma.organizationMembership.findMany({
      where: { orgId },
      select: { userId: true },
    });
    for (const { userId } of members) {
      if (!(await this.isInitialSyncComplete(userId))) return true;
    }
    return false;
  }

  /**
   * Runs when queue job name = inventory-batch-sync
   */
  public async runFullSyncInline(userId: string): Promise<void> {
    this.logger.log(`[full-sync:inline] Starting for userId=${userId}`);
    const setProgress = async (p: number, phase?: string) => {
      await this.setCoreSyncProgress(userId, p, phase);
      try {
        await this.amazonSyncService.setInitialSyncProgressInDb(userId, p);
      } catch (e) {
        this.logger.warn(
          `[full-sync:inline] setInitialSyncProgressInDb failed (progress=${p}): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    };
    await this.runFullSyncFlow(userId, setProgress);
    await this.afterInitialMiniSyncComplete(userId);
  }

  private async runFullSyncFlow(
    userId: string,
    setProgress: (p: number, phase?: string) => Promise<void>,
  ): Promise<void> {
    await setProgress(0, 'Syncing orders');
    await this.amazonService.syncRecentOrdersToDb(userId, {
      days: 30,
      maxOrders: 5,
      maxOrderItems: 5,
      onProgress: (p) => setProgress(p, 'Syncing orders'),
    });
    await setProgress(25, 'Syncing orders');
    this.logger.log(`[full-sync] 30-day orders + finances done → 25%`);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { activeOrgId: true },
    });
    let orgIdForSync = user?.activeOrgId ?? null;
    if (!orgIdForSync) {
      const membership = await this.prisma.organizationMembership.findFirst({
        where: { userId },
        select: { orgId: true },
      });
      orgIdForSync = membership?.orgId ?? null;
      if (orgIdForSync) {
        this.logger.log(
          `[full-sync] userId=${userId} has no activeOrgId; using first org ${orgIdForSync}`,
        );
      }
    }
    if (orgIdForSync) {
      await setProgress(25, 'Syncing inventory');
      await this.amazonService.syncFbaInventory(orgIdForSync, userId, {
        maxPages: 1,
      });
      await setProgress(50, 'Syncing inventory');
      this.logger.log(`[full-sync] minimal inventory done → 50%`);
      await setProgress(50, 'Syncing shipments');
      try {
        await this.amazonService.syncShipments(orgIdForSync, userId, {
          days: 30,
          maxShipments: 2,
          onProgress: async ({ processed, total }) => {
            if (total <= 0) return;
            const nextProgress = Math.min(
              75,
              50 + Math.floor((processed / total) * 25),
            );
            await setProgress(nextProgress, 'Syncing shipments');
          },
        });
      } catch (shipErr) {
        const msg =
          shipErr instanceof Error ? shipErr.message : String(shipErr);
        this.logger.warn(`[full-sync] 30-day shipments failed: ${msg}`);
      }
      await setProgress(75, 'Syncing shipments');
      this.logger.log(`[full-sync] last 30-day shipments done → 75%`);
      await setProgress(75, 'Syncing fee estimates');
      try {
        await this.amazonService.refreshFeeEstimatesForOrg(orgIdForSync, {
          topByQuantityInStock: 3,
          onProgress: async ({ processed, total }) => {
            if (total <= 0) return;
            const pct = processed / total;
            const nextProgress = Math.min(100, 75 + Math.floor(pct * 25));
            await setProgress(nextProgress, 'Syncing fee estimates');
          },
        });
      } catch (feeErr) {
        const msg = feeErr instanceof Error ? feeErr.message : String(feeErr);
        this.logger.warn(`[full-sync] Top 10 fee estimate failed: ${msg}`);
      }
      await setProgress(100, 'Complete');
      this.logger.log(`[full-sync] Initial mini sync completed → 100%`);
    } else {
      this.logger.warn(
        `[full-sync] userId=${userId} has no activeOrgId and no org membership; skipping inventory/fees`,
      );
    }
    await setProgress(100, 'Complete');
    this.logger.log(`[full-sync] Completed → 100%`);
  }

  async process(
    job: Job<AmazonSyncJobData | Record<string, never>>,
  ): Promise<void> {
    this.logger.log('[AmazonSyncProcessor] Received job', {
      id: job.id,
      name: job.name,
    });

    if (job.name === 'inventory-batch-sync') {
      this.logger.log('[AmazonSync] Running inventory batch sync');

      const orgs = await this.prisma.organization.findMany({
        select: { id: true },
      });

      const errors: Array<{ orgId: string; error: string }> = [];
      for (const org of orgs) {
        if (await this.shouldSkipOrgForBatch(org.id)) {
          this.logger.log(`[AmazonSync] Skipping org ${org.id} – initial sync not yet complete`);
          continue;
        }
        try {
          await this.amazonService.syncFbaInventory(org.id);
          const missingFees = await this.amazonService.countInventoryProductsMissingFeeSnapshot(org.id);
          if (missingFees > 0) {
            await this.amazonSyncService.enqueueFeeSyncForOrg(org.id);
            this.logger.log(
              `[AmazonSync] inventory-batch-sync: org ${org.id} — ${missingFees} SKU(s) still missing fee/list price; enqueued fee-sync`,
            );
          }
        } catch (e: any) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('Amazon account not linked') || msg.includes('link your Amazon account first')) {
            this.logger.log(`[AmazonSync] Skipping org ${org.id} – no Amazon account linked`);
            continue;
          }
          errors.push({ orgId: org.id, error: msg });
          this.logger.error(
            `[AmazonSync] Inventory sync failed for org ${org.id}: ${msg}`,
          );
        }
      }

      if (errors.length) {
        throw new Error(
          `[AmazonSync] inventory-batch-sync completed with ${errors.length} errors`,
        );
      }
    }

    if (job.name === 'full-sync') {
      const { userId } = job.data as AmazonSyncJobData;
      if (!userId) {
        throw new Error('Missing userId for full-sync job');
      }
      try {
        this.logger.log(
          `[full-sync] Starting for userId=${userId} (initial mini sync: 5 orders, minimal inventory sample, 2 latest shipments)`,
        );
        const setProgress = async (p: number, phase?: string) => {
          await job.updateProgress(p);
          await this.setCoreSyncProgress(userId, p, phase);
          try {
            await this.amazonSyncService.setInitialSyncProgressInDb(userId, p);
          } catch (e) {
            this.logger.warn(`[full-sync] setInitialSyncProgressInDb failed (progress=${p}): ${e instanceof Error ? e.message : String(e)}`);
          }
        };
        await this.runFullSyncFlow(userId, setProgress);
        await this.afterInitialMiniSyncComplete(userId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[full-sync] Failed for userId=${userId}: ${msg}`, err instanceof Error ? err.stack : undefined);
        throw err;
      }
    }

    if (job.name === 'post-initial-sync') {
      const { userId, orgId } = job.data as AmazonSyncJobData;
      if (!userId || !orgId) {
        throw new Error('Missing userId or orgId for post-initial-sync job');
      }
      await this.executePostInitialCatalogSync(userId, orgId);
    }

    if (job.name === 'fee-sync') {
      const { userId, orgId } = job.data as AmazonSyncJobData;
      if (!userId || !orgId) {
        throw new Error('Missing userId or orgId for fee-sync job');
      }
      try {
        this.logger.log(`[fee-sync] Starting for userId=${userId}, orgId=${orgId}`);
        let lastFeeProgress = 0;
        await this.setFeeSyncProgress(
          userId,
          0,
          'Syncing fee estimates for all products',
        );
        await this.amazonService.refreshFeeEstimatesForOrg(orgId, {
          onProgress: async ({ processed, total }) => {
            if (total <= 0) return;
            const nextProgress = Math.min(
              99,
              Math.floor((processed / total) * 100),
            );
            if (nextProgress <= lastFeeProgress) return;
            lastFeeProgress = nextProgress;
            await this.setFeeSyncProgress(
              userId,
              nextProgress,
              'Syncing fee estimates for all products',
            );
          },
        });
        await this.setFeeSyncProgress(userId, 100);
        this.logger.log(`[fee-sync] Completed for userId=${userId}, orgId=${orgId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[fee-sync] Failed for userId=${userId}, orgId=${orgId}: ${msg}`,
          err instanceof Error ? err.stack : undefined,
        );
        throw err;
      }
    }

    if (job.name === 'orders-batch-sync') {
      const accounts = await this.prisma.sellerAccount.findMany({
        where: { marketplace: 'amazon', isActive: true },
        select: { userId: true },
      });
      this.logger.log(`[AmazonSync] orders-batch-sync: ${accounts.length} seller(s)`);
      for (const { userId } of accounts) {
        if (!(await this.isInitialSyncComplete(userId))) {
          this.logger.log(`[AmazonSync] Skipping orders for userId=${userId.slice(0, 8)}… – initial sync not yet complete`);
          continue;
        }
        try {
          await this.amazonService.syncRecentOrdersToDb(userId, { days: 30 });
          const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { activeOrgId: true },
          });
          let orgId = user?.activeOrgId ?? null;
          if (!orgId) {
            const membership = await this.prisma.organizationMembership.findFirst({
              where: { userId },
              select: { orgId: true },
            });
            orgId = membership?.orgId ?? null;
          }
          if (orgId) {
            await this.amazonSyncService.enqueueCategoryBackfill(orgId, userId, { limit: 50 });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[AmazonSync] orders-batch-sync failed (userId=${userId}): ${msg}`);
        }
      }
    }

    if (job.name === 'shipments-batch-sync') {
      this.logger.log('[AmazonSync] Running shipments batch sync');

      const orgs = await this.prisma.organization.findMany({
        select: { id: true },
      });

      const errors: Array<{ orgId: string; error: string }> = [];
      for (const org of orgs) {
        if (await this.shouldSkipOrgForBatch(org.id)) {
          this.logger.log(`[AmazonSync] Skipping shipments for org ${org.id} – initial sync not yet complete`);
          continue;
        }
        const member = await this.prisma.organizationMembership.findFirst({
          where: { orgId: org.id },
          select: { userId: true },
        });
        try {
          await this.amazonService.syncShipments(org.id, member?.userId);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push({ orgId: org.id, error: msg });
          this.logger.error(
            `[AmazonSync] Shipments sync failed for org ${org.id}: ${msg}`,
          );
        }
      }

      if (errors.length) {
        throw new Error(
          `[AmazonSync] shipments-batch-sync completed with ${errors.length} errors`,
        );
      }
    }

    if (job.name === 'fee-estimate-refresh') {
      this.logger.log(
        '[AmazonSync] Running fee estimate refresh (all SKUs, batched) for orgs with Amazon linked',
      );

      // Only orgs that have at least one member with a linked Amazon account (avoid touching orphan/test orgs).
      const orgs = await this.prisma.organization.findMany({
        where: {
          members: {
            some: {
              user: {
                sellerAccounts: {
                  some: { marketplace: 'amazon' },
                },
              },
            },
          },
        },
        select: { id: true },
      });

      const errors: Array<{ orgId: string; error: string }> = [];
      for (const org of orgs) {
        if (await this.shouldSkipOrgForBatch(org.id)) {
          this.logger.log(`[AmazonSync] Skipping fee-estimate-refresh for org ${org.id} – initial sync not yet complete`);
          continue;
        }
        try {
          // Full pass: list price + Product Fees API for every product (not just top 10 by qty).
          await this.amazonService.refreshFeeEstimatesForOrg(org.id);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          const isNotLinked = /amazon account not linked|link your amazon account/i.test(msg);
          if (isNotLinked) {
            // Skip silently; no need to log every org without Amazon
          } else {
            errors.push({ orgId: org.id, error: msg });
            this.logger.error(
              `[AmazonSync] Fee estimate refresh failed for org ${org.id}: ${msg}`,
            );
          }
        }
      }

      if (errors.length) {
        throw new Error(
          `[AmazonSync] fee-estimate-refresh completed with ${errors.length} errors`,
        );
      }
    }

    if (job.name === 'listing-price-refresh-hot') {
      this.logger.log(
        '[AmazonSync] Running HOT listing price refresh (Listings API only) for orgs with Amazon linked',
      );

      const orgs = await this.prisma.organization.findMany({
        where: {
          members: {
            some: {
              user: {
                sellerAccounts: {
                  some: { marketplace: 'amazon' },
                },
              },
            },
          },
        },
        select: { id: true },
      });

      const errors: Array<{ orgId: string; error: string }> = [];
      for (const org of orgs) {
        if (await this.shouldSkipOrgForBatch(org.id)) {
          this.logger.log(
            `[AmazonSync] Skipping listing-price-refresh for org ${org.id} – initial sync not yet complete`,
          );
          continue;
        }
        try {
          await this.amazonService.refreshListedPricesForOrg(org.id, { mode: 'hot' });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          const isNotLinked = /amazon account not linked|link your amazon account/i.test(msg);
          if (isNotLinked) {
            // skip
          } else {
            errors.push({ orgId: org.id, error: msg });
            this.logger.error(
              `[AmazonSync] Listing price refresh failed for org ${org.id}: ${msg}`,
            );
          }
        }
      }

      if (errors.length) {
        throw new Error(
          `[AmazonSync] listing-price-refresh-hot completed with ${errors.length} errors`,
        );
      }
    }

    if (job.name === 'listing-price-refresh-cold') {
      this.logger.log(
        '[AmazonSync] Running COLD listing price refresh (Listings API only) for orgs with Amazon linked',
      );

      const orgs = await this.prisma.organization.findMany({
        where: {
          members: {
            some: {
              user: {
                sellerAccounts: {
                  some: { marketplace: 'amazon' },
                },
              },
            },
          },
        },
        select: { id: true },
      });

      const errors: Array<{ orgId: string; error: string }> = [];
      for (const org of orgs) {
        if (await this.shouldSkipOrgForBatch(org.id)) {
          this.logger.log(
            `[AmazonSync] Skipping listing-price-refresh-cold for org ${org.id} – initial sync not yet complete`,
          );
          continue;
        }
        try {
          await this.amazonService.refreshListedPricesForOrg(org.id, { mode: 'cold' });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          const isNotLinked = /amazon account not linked|link your amazon account/i.test(msg);
          if (isNotLinked) {
            // skip
          } else {
            errors.push({ orgId: org.id, error: msg });
            this.logger.error(
              `[AmazonSync] Listing price refresh (cold) failed for org ${org.id}: ${msg}`,
            );
          }
        }
      }

      if (errors.length) {
        throw new Error(
          `[AmazonSync] listing-price-refresh-cold completed with ${errors.length} errors`,
        );
      }
    }

    if (job.name === 'titles-backfill') {
      const { orgId, userId, limit } = job.data as { orgId?: string; userId?: string; limit?: number };
      if (!orgId) {
        throw new Error('Missing orgId for titles-backfill job');
      }
      const safeLimit = Math.min(300, Math.max(1, Number(limit) || 100));
      this.logger.log(`[AmazonSync] Running titles backfill for org ${orgId} (limit=${safeLimit})`);
      const result = await this.amazonService.backfillProductTitles(orgId, safeLimit, userId);
      this.logger.log(
        `[AmazonSync] Titles backfill org ${orgId}: requested=${result?.requested ?? 0} updated=${result?.updated ?? 0} skipped=${result?.skipped ?? 0} errors=${result?.errorsCount ?? 0}`,
      );
    }

    if (job.name === 'category-backfill') {
      const { orgId, userId, limit } = job.data as { orgId?: string; userId?: string; limit?: number };
      if (!orgId) {
        throw new Error('Missing orgId for category-backfill job');
      }
      let preferredUserId = userId;
      if (!preferredUserId) {
        const member = await this.prisma.organizationMembership.findFirst({
          where: { orgId },
          select: { userId: true },
        });
        preferredUserId = member?.userId ?? '';
      }
      if (!preferredUserId) {
        this.logger.warn(`[AmazonSync] Category backfill skipped for org ${orgId}: no userId and no org members`);
        return;
      }
      const safeLimit = Math.min(250, Math.max(1, Number(limit) || 100));
      this.logger.log(`[AmazonSync] Running category backfill for org ${orgId} (limit=${safeLimit})`);
      const result = await this.amazonService.backfillCatalogCategoriesForNewAsins(orgId, preferredUserId, undefined, safeLimit);
      this.logger.log(
        `[AmazonSync] Category backfill org ${orgId}: requested=${result?.requested ?? 0} processed=${result?.processed ?? 0} updated=${result?.updated ?? 0} noData=${result?.noDataCount ?? 0}`,
      );
    }

    if (job.name === 'product-titles-backfill') {
      this.logger.log('[AmazonSync] Running product titles/images backfill for all orgs');

      const orgs = await this.prisma.organization.findMany({
        select: { id: true },
      });

      const limit = Math.min(200, Math.max(50, Number(process.env.AMAZON_TITLES_BACKFILL_LIMIT) || 100));
      const errors: Array<{ orgId: string; error: string }> = [];
      for (const org of orgs) {
        if (await this.shouldSkipOrgForBatch(org.id)) {
          this.logger.log(`[AmazonSync] Skipping product-titles-backfill for org ${org.id} – initial sync not yet complete`);
          continue;
        }
        try {
          const result = await this.amazonService.backfillProductTitles(org.id, limit);
          this.logger.log(
            `[AmazonSync] Titles backfill org ${org.id}: updated=${result?.updated ?? 0} skipped=${result?.skipped ?? 0} errors=${result?.errorsCount ?? 0}`,
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          // Not linked is an expected state for many orgs; don't spam errors or fail the batch.
          if (typeof msg === 'string' && msg.toLowerCase().includes('amazon account not linked')) {
            this.logger.log(
              `[AmazonSync] Titles backfill skipped for org ${org.id}: Amazon account not linked`,
            );
          } else {
            errors.push({ orgId: org.id, error: msg });
            this.logger.error(
              `[AmazonSync] Titles backfill failed for org ${org.id}: ${msg}`,
            );
          }
        }
      }

      if (errors.length) {
        throw new Error(
          `[AmazonSync] product-titles-backfill completed with ${errors.length} errors`,
        );
      }
    }
  }
}
