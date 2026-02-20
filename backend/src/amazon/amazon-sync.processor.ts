import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AmazonService } from './amazon.service';
import { PrismaService } from '../prisma/prisma.service';

interface AmazonSyncJobData {
  userId: string;
}

@Processor('amazon-sync')
export class AmazonSyncProcessor extends WorkerHost {
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
    console.log('[AmazonSyncProcessor] Received job', {
      id: job.id,
      name: job.name,
    });

    if (job.name === 'inventory-batch-sync') {
      console.log('[AmazonSync] Running inventory batch sync');

      const orgs = await this.prisma.organization.findMany({
        select: { id: true },
      });

      for (const org of orgs) {
        await this.amazonService.syncFbaInventory(org.id);
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
