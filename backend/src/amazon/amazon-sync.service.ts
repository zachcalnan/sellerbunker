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
        removeOnComplete: true,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      },
    );
  }
}

