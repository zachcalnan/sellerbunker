import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AmazonService } from './amazon.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const SYNC_PROGRESS_TTL = 24 * 60 * 60; // 24h

interface AmazonSyncJobData {
  userId: string;
}

@Processor('amazon-sync')
export class AmazonSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(AmazonSyncProcessor.name);
  constructor(
    private readonly amazonService: AmazonService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  private async setInitialSyncProgress(userId: string, progress: number): Promise<void> {
    const key = `amazon-initial-sync:${userId}`;
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
      await this.setInitialSyncProgress(userId, 0);
      // 1) Orders first – populates orders and order items for dashboard summary
      await this.amazonService.syncRecentOrdersToDb(userId);
      await this.setInitialSyncProgress(userId, 25);
      // 2) FBA inventory – stock levels and catalog
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { activeOrgId: true },
      });
      if (user?.activeOrgId) {
        await this.amazonService.syncFbaInventory(user.activeOrgId, userId);
        await this.setInitialSyncProgress(userId, 50);
        // 3) Shipments – FBA shipment list and status
        await this.amazonService.syncShipments(user.activeOrgId, userId);
        await this.setInitialSyncProgress(userId, 75);
        // 4) Fee estimates – so profit/COGS calculations can use FBA fees
        await this.amazonService.refreshFeeEstimatesForOrg(user.activeOrgId);
      }
      await this.setInitialSyncProgress(userId, 100);
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
      this.logger.log('[AmazonSync] Running fee estimate refresh for all orgs');

      const orgs = await this.prisma.organization.findMany({
        select: { id: true },
      });

      const errors: Array<{ orgId: string; error: string }> = [];
      for (const org of orgs) {
        try {
          await this.amazonService.refreshFeeEstimatesForOrg(org.id);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push({ orgId: org.id, error: msg });
          this.logger.error(
            `[AmazonSync] Fee estimate refresh failed for org ${org.id}: ${msg}`,
          );
        }
      }

      if (errors.length) {
        throw new Error(
          `[AmazonSync] fee-estimate-refresh completed with ${errors.length} errors`,
        );
      }
    }
  }
}
