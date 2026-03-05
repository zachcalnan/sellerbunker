import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class AmazonSyncService implements OnModuleInit {
  private readonly logger = new Logger(AmazonSyncService.name);
  constructor(@InjectQueue('amazon-sync') private readonly queue: Queue) {}

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

    this.logger.log(
      `Scheduled Amazon sync jobs (ordersEveryMs=${ordersEveryMs}, inventoryEveryMs=${inventoryEveryMs}, feeEstimateCron=${feeEstimateCron})`,
    );
  }

  /**
   * Enqueue a full background sync for a given user.
   * This is the main entry point to start pulling data from SP-API
   * without blocking HTTP requests.
   */
  async enqueueFullSync(userId: string): Promise<void> {
    this.logger.log(`Enqueuing full-sync job (userId=${userId})`);
    await this.queue.add(
      'full-sync',
      { userId },
      {
        // retries if Amazon/SP-API fails
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },

        // keep Redis clean
        removeOnComplete: true,
        removeOnFail: 500,

        // dedupe: prevent multiple concurrent full-syncs per user
        jobId: `full-sync-${userId}`,
      },
    );
  }
}
