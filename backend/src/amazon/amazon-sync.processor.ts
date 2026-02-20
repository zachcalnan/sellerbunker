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
   * Basic full-sync processor.
   *
   * For now this just calls into the existing AmazonService logic so you can
   * verify BullMQ is wired up. Later we can evolve this to:
   * - fetch recent orders from SP-API
   * - persist them via Prisma
   * - compute and cache aggregates for the dashboard
   */
  async process(
    job: Job<AmazonSyncJobData | Record<string, never>>,
  ): Promise<void> {
    console.log('[AmazonSyncProcessor] Received job', {
      id: job.id,
      name: job.name,
      data: job.data,
    });

    if (job.name === 'full-sync') {
      const { userId } = job.data;

      // Trigger a background sync of recent orders into Prisma.
      console.log('[AmazonSyncProcessor] Starting full-sync for user', {
        userId,
      });
      await this.amazonService.syncRecentOrdersToDb(userId);
      console.log('[AmazonSyncProcessor] Finished full-sync for user', {
        userId,
      });
    } else if (job.name === 'orders-batch-sync') {
      console.log(
        '[AmazonSyncProcessor] Starting batch orders sync for all sellers',
      );
      await this.amazonService.syncRecentOrdersForAllSellers();
      console.log(
        '[AmazonSyncProcessor] Finished batch orders sync for all sellers',
      );
    } else if (job.name === 'inventory-batch-sync') {
      // Best-effort: sync inventory per org using an active Amazon-linked org member.
      const orgs = await this.prisma.organization.findMany({
        select: { id: true },
      });

      for (const org of orgs) {
        const membership = await this.prisma.organizationMembership.findFirst({
          where: { orgId: org.id },
          select: { userId: true },
          orderBy: { updatedAt: 'desc' },
        });
        const preferredUserId = membership?.userId;
        await this.amazonService.syncFbaInventory(org.id, preferredUserId);
      }
    }
  }
}
