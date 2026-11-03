import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AmazonService } from './amazon.service';
import { AmazonSyncService } from './amazon-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * Dedicated worker for new-sale detection / push.
 * Must not share the amazon-sync queue — listing-price and fee jobs
 * were starving orders-hot-sync so alerts only fired when the app opened.
 */
@Processor('amazon-orders-hot', { concurrency: 2 })
export class AmazonOrdersHotSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(AmazonOrdersHotSyncProcessor.name);

  constructor(
    private readonly amazonService: AmazonService,
    private readonly amazonSyncService: AmazonSyncService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super();
  }

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

  async process(job: Job): Promise<void> {
    if (job.name !== 'orders-hot-sync' && job.name !== 'orders-hot-sync-user') {
      return;
    }

    if (job.name === 'orders-hot-sync-user') {
      const userId =
        typeof (job.data as { userId?: unknown })?.userId === 'string'
          ? String((job.data as { userId: string }).userId)
          : '';
      if (!userId) return;
      if (!(await this.isInitialSyncComplete(userId))) return;
      try {
        await this.amazonService.syncHotRecentOrdersToDb(userId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[orders-hot] user sync failed (userId=${userId}): ${msg}`,
        );
      }
      return;
    }

    const userIds =
      await this.amazonSyncService.findAmazonSellerUserIdsForScheduledSync();
    this.logger.log(`[orders-hot] syncing ${userIds.length} seller(s)`);
    const concurrency = Math.max(
      1,
      Math.min(
        4,
        Number(process.env.AMAZON_ORDERS_HOT_SYNC_CONCURRENCY) || 4,
      ),
    );
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, userIds.length) },
      async () => {
        while (cursor < userIds.length) {
          const userId = userIds[cursor++];
          if (!(await this.isInitialSyncComplete(userId))) continue;
          try {
            await this.amazonService.syncHotRecentOrdersToDb(userId);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `[orders-hot] failed (userId=${userId}): ${msg}`,
            );
          }
        }
      },
    );
    await Promise.all(workers);
  }
}
