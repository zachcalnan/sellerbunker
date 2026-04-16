import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { RepricerService } from './repricer.service';

@Processor('repricer')
export class RepricerProcessor extends WorkerHost {
  private readonly logger = new Logger(RepricerProcessor.name);
  constructor(private readonly repricer: RepricerService) {
    super();
  }

  async process(job: Job<Record<string, unknown>>): Promise<void> {
    if (job.name !== 'tick') return;
    // Live Amazon price PATCH by default. Set REPRICER_DRY_RUN=true (or 1/yes) only when you want
    // simulation-only runs (no Seller Central updates), e.g. local dev or staging.
    const raw = (process.env.REPRICER_DRY_RUN ?? '').toLowerCase();
    const dryRun = ['1', 'true', 'yes'].includes(raw);
    this.logger.log(`[tick] starting (dryRun=${dryRun})`);
    await this.repricer.runEngineForAllOrgs({ dryRun });
    this.logger.log('[tick] done');
  }
}

