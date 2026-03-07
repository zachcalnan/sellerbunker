import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RedisService } from '../redis/redis.service';

const SYNC_PROGRESS_TTL = 24 * 60 * 60; // 24h, must match amazon-sync.processor

@Injectable()
export class AmazonSyncService implements OnModuleInit {
  private readonly logger = new Logger(AmazonSyncService.name);
  constructor(
    @InjectQueue('amazon-sync') private readonly queue: Queue,
    private readonly redis: RedisService,
  ) {}

  private async enqueueUniqueJob(
    jobName: string,
    stableJobId: string,
    data: Record<string, unknown>,
    logPrefix: string,
  ): Promise<void> {
    let jobId = stableJobId;
    const existingJob = await this.queue.getJob(stableJobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === 'active') {
        this.logger.log(
          `${logPrefix} already running (jobId=${existingJob.id})`,
        );
        return;
      }

      this.logger.warn(
        `Replacing stale ${logPrefix} job (state=${state}, jobId=${existingJob.id})`,
      );
      try {
        await existingJob.remove();
      } catch (error) {
        jobId = `${stableJobId}-${Date.now()}`;
        const message =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Could not remove existing ${logPrefix} job; queueing fallback jobId=${jobId} instead (${message})`,
        );
      }
    }

    await this.queue.add(jobName, data, {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: true,
      removeOnFail: 500,
      jobId,
    });
  }

  /**
   * Configure periodic batch sync when the module starts.
   * This enqueues a repeatable job that will run every 10 minutes.
   */
  async onModuleInit(): Promise<void> {
    const enabled = (process.env.ENABLE_AMAZON_SYNC_SCHEDULER ?? 'true').toLowerCase();
    if (!['1', 'true', 'yes'].includes(enabled)) {
      this.logger.log(
        'Amazon sync scheduler disabled via ENABLE_AMAZON_SYNC_SCHEDULER',
      );
      return;
    }

    const ordersEveryMs =
      Number(process.env.AMAZON_ORDERS_SYNC_EVERY_MS) || 10 * 60 * 1000;
    const inventoryEveryMs =
      Number(process.env.AMAZON_INVENTORY_SYNC_EVERY_MS) || 2 * 60 * 60 * 1000;

    await this.queue.add(
      'orders-batch-sync',
      {},
      {
        repeat: {
          every: ordersEveryMs,
        },
        jobId: 'orders-batch-sync',
      },
    );

    await this.queue.add(
      'inventory-batch-sync',
      {},
      {
        repeat: {
          every: inventoryEveryMs,
        },
        jobId: 'inventory-batch-sync',
      },
    );

    const shipmentsEveryMs =
      Number(process.env.AMAZON_SHIPMENTS_SYNC_EVERY_MS) || 2 * 60 * 60 * 1000;
    await this.queue.add(
      'shipments-batch-sync',
      {},
      {
        repeat: {
          every: shipmentsEveryMs,
        },
        jobId: 'shipments-batch-sync',
      },
    );

    // Fee estimate refresh: once per day (default 6 AM) to avoid rate limits
    const feeEstimateCron =
      process.env.FEE_ESTIMATE_REFRESH_CRON ?? '0 6 * * *';
    await this.queue.add(
      'fee-estimate-refresh',
      {},
      {
        repeat: {
          pattern: feeEstimateCron,
        },
        jobId: 'fee-estimate-refresh',
      },
    );

    const titlesBackfillEveryMs =
      Number(process.env.AMAZON_TITLES_BACKFILL_EVERY_MS) || 4 * 60 * 60 * 1000;
    await this.queue.add(
      'product-titles-backfill',
      {},
      {
        repeat: { every: titlesBackfillEveryMs },
        jobId: 'product-titles-backfill',
      },
    );

    this.logger.log(
      `Scheduled Amazon sync jobs (orders=${ordersEveryMs}ms, inventory=${inventoryEveryMs}ms, shipments=${shipmentsEveryMs}ms, feeCron=${feeEstimateCron}, titlesBackfill=${titlesBackfillEveryMs}ms)`,
    );
  }

  /**
   * Enqueue a full background sync for a given user.
   * This is the main entry point to start pulling data from SP-API
   * without blocking HTTP requests.
   */
  async enqueueFullSync(userId: string): Promise<void> {
    this.logger.log(`Enqueuing full-sync job (userId=${userId})`);
    // Set progress to 0 immediately so the dashboard shows "Syncing..." until the worker
    // actually runs and updates it. Otherwise GET /sync-progress returns 100 when the key
    // is missing and the UI would show "Sync complete" before any sync runs.
    const progressKey = `amazon-initial-sync:${userId}`;
    await this.redis.set(
      progressKey,
      JSON.stringify({ progress: 0 }),
      SYNC_PROGRESS_TTL,
    );
    await this.redis.del(`amazon-fee-sync:${userId}`);
    await this.enqueueUniqueJob(
      'full-sync',
      `full-sync-${userId}`,
      { userId },
      `Full-sync for userId=${userId}`,
    );
  }

  async enqueueFeeSync(userId: string, orgId: string): Promise<void> {
    this.logger.log(`Enqueuing fee-sync job (userId=${userId}, orgId=${orgId})`);
    await this.redis.set(
      `amazon-fee-sync:${userId}`,
      JSON.stringify({ progress: 0 }),
      SYNC_PROGRESS_TTL,
    );
    await this.enqueueUniqueJob(
      'fee-sync',
      `fee-sync-${userId}`,
      { userId, orgId },
      `Fee-sync for userId=${userId}`,
    );
  }
}
