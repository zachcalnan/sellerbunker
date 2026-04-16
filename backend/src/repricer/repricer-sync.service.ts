import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class RepricerSyncService implements OnModuleInit {
  private readonly logger = new Logger(RepricerSyncService.name);
  constructor(@InjectQueue('repricer') private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    // On by default so local dev works with docker-compose Redis only. Opt out: ENABLE_REPRICER_SCHEDULER=false
    const raw = (process.env.ENABLE_REPRICER_SCHEDULER ?? 'true').toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(raw)) {
      this.logger.log('Repricer scheduler disabled (set ENABLE_REPRICER_SCHEDULER=false)');
      return;
    }

    const everyMs = Number(process.env.REPRICER_TICK_EVERY_MS) || 5 * 60 * 1000;
    await this.queue.add(
      'tick',
      {},
      {
        repeat: { every: everyMs },
        jobId: 'repricer-tick',
      },
    );

    this.logger.log(`Scheduled repricer tick (every=${everyMs}ms)`);
  }
}

