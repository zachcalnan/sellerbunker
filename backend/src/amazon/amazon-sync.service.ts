import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';

const SYNC_PROGRESS_TTL = 24 * 60 * 60; // 24h, must match amazon-sync.processor

@Injectable()
export class AmazonSyncService implements OnModuleInit {
  private readonly logger = new Logger(AmazonSyncService.name);
  constructor(
    @InjectQueue('amazon-sync') private readonly queue: Queue,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  private async enqueueUniqueJob(
    jobName: string,
    stableJobId: string,
    data: Record<string, unknown>,
    logPrefix: string,
    opts?: { delay?: number },
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
      ...(opts?.delay != null && opts.delay > 0 ? { delay: opts.delay } : {}),
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
  /** Write progress to DB so the bar has a single source of truth (survives Redis/job). */
  async setInitialSyncProgressInDb(userId: string, progress: number): Promise<void> {
    const p = Math.min(100, Math.max(0, progress));
    await this.prisma.initialSyncProgress.upsert({
      where: { userId },
      create: { userId, progress: p },
      update: { progress: p },
    });
  }

  async enqueueFullSync(userId: string): Promise<void> {
    this.logger.log(`Enqueuing full-sync job (userId=${userId})`);
    // Set Redis to 0 immediately so the frontend sees "0%" as soon as it polls after redirect
    await this.redis.set(
      `amazon-initial-sync:${userId}`,
      JSON.stringify({ progress: 0 }),
      SYNC_PROGRESS_TTL,
    );
    await this.redis.del(`amazon-fee-sync:${userId}`);
    // Delay job start by 2.5s so the redirect + frontend load happens first; avoids "backend already started" and gives the bar time to show 0%
    await this.enqueueUniqueJob(
      'full-sync',
      `full-sync-${userId}`,
      { userId },
      `Full-sync for userId=${userId}`,
      { delay: 2500 },
    );
    try {
      await this.setInitialSyncProgressInDb(userId, 0);
    } catch (e) {
      this.logger.warn(`setInitialSyncProgressInDb(0) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Resolve current sync progress for the UI. Core progress comes from the
   * full-sync BullMQ job (job.updateProgress in worker, job.progress here) so
   * there is a single source of truth – no separate Redis key that can get out of sync.
   */
  async getSyncProgress(userId: string): Promise<{
    progress: number;
    done: boolean;
    stage: 'core' | 'fees' | 'complete';
    feeProgress: number;
    feeDone: boolean;
  }> {
    this.logger.log(`[sync-progress] getSyncProgress called userId=${userId.slice(0, 8)}…`);
    const parseProgress = (raw: string | null): number | null => {
      if (!raw) return null;
      try {
        const { progress } = JSON.parse(raw) as { progress?: number };
        const p = Number(progress);
        return Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : null;
      } catch {
        return null;
      }
    };

    // DB is the source of truth – worker writes every setProgress(), so we always read it first.
    // job.progress from BullMQ can be stale or non-numeric when fetched from Redis, so don't rely on it alone.
    const dbRow = await this.prisma.initialSyncProgress.findUnique({
      where: { userId },
      select: { progress: true },
    });
    const coreKey = `amazon-initial-sync:${userId}`;
    const fullSyncJob = await this.queue.getJob(`full-sync-${userId}`);
    let coreProgress: number;
    let jobState: string | null = null;
    const fromRedis = parseProgress(await this.redis.get(coreKey));
    let progressSource: 'db' | 'job' | 'redis' | 'default';
    if (fullSyncJob) {
      jobState = await fullSyncJob.getState();
      if (jobState === 'active' || jobState === 'waiting') {
        const fromJob = fullSyncJob.progress;
        let jobNum: number | null = null;
        if (typeof fromJob === 'number' && Number.isFinite(fromJob)) {
          jobNum = Math.min(100, Math.max(0, fromJob));
        } else if (fromJob != null && typeof fromJob === 'object' && typeof (fromJob as { progress?: number }).progress === 'number') {
          jobNum = Math.min(100, Math.max(0, (fromJob as { progress: number }).progress));
        }
        // Use the freshest value across DB, job, Redis so we don't show stale progress (e.g. DB replica lag or slow write).
        const dbVal = dbRow?.progress ?? 0;
        const jobVal = jobNum ?? 0;
        const redisVal = fromRedis ?? 0;
        const best = Math.max(dbVal, jobVal, redisVal);
        if (best > 0 || dbRow != null || jobNum != null || fromRedis != null) {
          coreProgress = Math.min(100, best);
          progressSource = best === redisVal ? 'redis' : best === jobVal ? 'job' : 'db';
        } else {
          coreProgress = 0;
          progressSource = 'default';
        }
      } else {
        coreProgress = dbRow?.progress ?? fromRedis ?? 100;
        progressSource = dbRow != null ? 'db' : fromRedis != null ? 'redis' : 'default';
      }
    } else {
      coreProgress = dbRow?.progress ?? fromRedis ?? 0;
      progressSource = dbRow != null ? 'db' : fromRedis != null ? 'redis' : 'default';
    }

    // Fee progress: still in Redis (fee-sync is a separate job)
    const feeRaw = await this.redis.get(`amazon-fee-sync:${userId}`);
    const feeProgress = parseProgress(feeRaw);
    const done = coreProgress >= 100;
    const feeDone = feeProgress == null || feeProgress >= 100;
    const stage = !done ? 'core' : !feeDone ? 'fees' : 'complete';

    this.logger.log(
      `[sync-progress] userId=${userId.slice(0, 8)}… jobState=${jobState ?? 'none'} progress=${coreProgress} from=${progressSource}`,
    );
    if (progressSource === 'default' && coreProgress === 0) {
      this.logger.log(
        '[sync-progress] No job/Redis/DB for this user. For local dev, ensure OAuth redirect and API use the same backend – see docs/local-sync-bar.md',
      );
    }

    // Percentage at which core phase (orders → inventory → shipments) ends; fees run from this to 100.
    const corePhaseEndPct = 75;

    return {
      progress: coreProgress,
      done,
      stage,
      feeProgress: feeProgress ?? 100,
      feeDone,
      corePhaseEndPct,
    };
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
