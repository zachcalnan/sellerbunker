import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AmazonService } from './amazon.service';
import { PrismaService } from '../prisma/prisma.service';

interface AmazonSyncJobData {
  userId: string;
}

@Processor('amazon-sync')
export class AmazonSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(AmazonSyncProcessor.name);
  constructor(
    private readonly amazonService: AmazonService,
    private readonly prisma: PrismaService,
  ) {
    super();
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
      await this.amazonService.syncRecentOrdersToDb(userId);
    }

    if (job.name === 'orders-batch-sync') {
      await this.amazonService.syncRecentOrdersForAllSellers();
    }
  }
}
