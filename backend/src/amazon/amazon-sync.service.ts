import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class AmazonSyncService {
  constructor(@InjectQueue('amazon-sync') private readonly queue: Queue) {}

  /**
   * Enqueue a full background sync for a given user.
   * This is the main entry point to start pulling data from SP-API
   * without blocking HTTP requests.
   */
  async enqueueFullSync(userId: string): Promise<void> {
    console.log('[AmazonSyncService] Enqueuing full-sync job', { userId });
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

