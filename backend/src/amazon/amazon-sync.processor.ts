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

  private async setInitialSyncProgress(userId: string, progress: number): Promise<void> {
    const key = `amazon-initial-sync:${userId}`;
    await this.redis.set(key, JSON.stringify({ progress }), SYNC_PROGRESS_TTL);
  }

  private async setFeeSyncProgress(userId: string, progress: number): Promise<void> {
    const key = `amazon-fee-sync:${userId}`;
    await this.redis.set(key, JSON.stringify({ progress }), SYNC_PROGRESS_TTL);
  }

  /**
   * Runs when queue job name = inventory-batch-sync
   */
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
        try {
          await this.amazonService.syncFbaInventory(org.id);
        } catch (e: any) {
          const msg = e instanceof Error ? e.message : String(e);
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
        this.logger.log(`[full-sync] Starting for userId=${userId}`);
        await this.setInitialSyncProgress(userId, 0);
        // 1) Orders first – populates orders and order items for dashboard summary
        await this.amazonService.syncRecentOrdersToDb(userId);
        await this.setInitialSyncProgress(userId, 25);
        // 2) FBA inventory, shipments, fee estimates – use activeOrgId or first org the user belongs to
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
            this.logger.log(`[full-sync] userId=${userId} has no activeOrgId; using first org ${orgIdForSync} for inventory/shipments/fees`);
          }
        }
        if (orgIdForSync) {
          await this.amazonService.syncFbaInventory(orgIdForSync, userId);
          await this.setInitialSyncProgress(userId, 50);
          const initialTitlesBackfillLimit = Math.min(
            300,
            Math.max(
              0,
              Number(process.env.AMAZON_INITIAL_TITLES_BACKFILL_LIMIT) || 100,
            ),
          );
          if (initialTitlesBackfillLimit > 0) {
            try {
              const result = await this.amazonService.backfillProductTitles(
                orgIdForSync,
                initialTitlesBackfillLimit,
                userId,
              );
              this.logger.log(
                `[full-sync] Initial titles backfill for userId=${userId}: requested=${result?.requested ?? 0} updated=${result?.updated ?? 0} skipped=${result?.skipped ?? 0} errors=${result?.errorsCount ?? 0}`,
              );
            } catch (titleErr) {
              const msg =
                titleErr instanceof Error ? titleErr.message : String(titleErr);
              this.logger.warn(
                `[full-sync] Initial titles backfill failed for userId=${userId}: ${msg}`,
              );
            }
          }
          // 3) Shipments – FBA shipment list and status
          let lastShipmentProgress = 50;
          await this.amazonService.syncShipments(orgIdForSync, userId, {
            onProgress: async ({ processed, total }) => {
              if (total <= 0) return;
              const nextProgress = Math.min(
                75,
                50 + Math.floor((processed / total) * 25),
              );
              if (nextProgress <= lastShipmentProgress) return;
              lastShipmentProgress = nextProgress;
              await this.setInitialSyncProgress(userId, nextProgress);
            },
          });
          await this.setInitialSyncProgress(userId, 75);
          await this.amazonSyncService.enqueueFeeSync(userId, orgIdForSync);
        } else {
          this.logger.warn(`[full-sync] userId=${userId} has no activeOrgId and no org membership; skipping inventory/shipments/fees`);
        }
        await this.setInitialSyncProgress(userId, 100);
        this.logger.log(`[full-sync] Completed for userId=${userId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[full-sync] Failed for userId=${userId}: ${msg}`, err instanceof Error ? err.stack : undefined);
        throw err;
      }
    }

    if (job.name === 'fee-sync') {
      const { userId, orgId } = job.data as AmazonSyncJobData;
      if (!userId || !orgId) {
        throw new Error('Missing userId or orgId for fee-sync job');
      }
      try {
        this.logger.log(`[fee-sync] Starting for userId=${userId}, orgId=${orgId}`);
        let lastFeeProgress = 0;
        await this.setFeeSyncProgress(userId, 0);
        await this.amazonService.refreshFeeEstimatesForOrg(orgId, {
          onProgress: async ({ processed, total }) => {
            if (total <= 0) return;
            const nextProgress = Math.min(
              99,
              Math.floor((processed / total) * 100),
            );
            if (nextProgress <= lastFeeProgress) return;
            lastFeeProgress = nextProgress;
            await this.setFeeSyncProgress(userId, nextProgress);
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
      await this.amazonService.syncRecentOrdersForAllSellers();
    }

    if (job.name === 'shipments-batch-sync') {
      this.logger.log('[AmazonSync] Running shipments batch sync');

      const orgs = await this.prisma.organization.findMany({
        select: { id: true },
      });

      const errors: Array<{ orgId: string; error: string }> = [];
      for (const org of orgs) {
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
      this.logger.log('[AmazonSync] Running fee estimate refresh for orgs with Amazon linked');

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
        try {
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

    if (job.name === 'product-titles-backfill') {
      this.logger.log('[AmazonSync] Running product titles/images backfill for all orgs');

      const orgs = await this.prisma.organization.findMany({
        select: { id: true },
      });

      const limit = Math.min(200, Math.max(50, Number(process.env.AMAZON_TITLES_BACKFILL_LIMIT) || 100));
      const errors: Array<{ orgId: string; error: string }> = [];
      for (const org of orgs) {
        try {
          const result = await this.amazonService.backfillProductTitles(org.id, limit);
          this.logger.log(
            `[AmazonSync] Titles backfill org ${org.id}: updated=${result?.updated ?? 0} skipped=${result?.skipped ?? 0} errors=${result?.errorsCount ?? 0}`,
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push({ orgId: org.id, error: msg });
          this.logger.error(
            `[AmazonSync] Titles backfill failed for org ${org.id}: ${msg}`,
          );
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
