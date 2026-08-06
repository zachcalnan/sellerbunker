import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
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
    opts?: { delay?: number; lockDurationMs?: number },
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
      ...(opts?.lockDurationMs != null && opts.lockDurationMs > 0
        ? { lockDuration: opts.lockDurationMs }
        : {}),
    });
  }

  /**
   * Configure periodic Amazon sync when the module starts.
   *
   * Tiered strategy (minimize SP-API waste):
   * - Frequent: hot orders (~5 min, last few days only).
   * - Moderate: in-stock / recently-sold list prices (~30 min).
   * - Nightly: full orders+finances, inventory, shipments, titles, cold list prices, fee estimates.
   * - On signup: full-sync + post-initial (not on this scheduler).
   */
  async onModuleInit(): Promise<void> {
    const enabled = (process.env.ENABLE_AMAZON_SYNC_SCHEDULER ?? 'true').toLowerCase();
    if (!['1', 'true', 'yes'].includes(enabled)) {
      this.logger.error(
        'Amazon sync scheduler DISABLED (ENABLE_AMAZON_SYNC_SCHEDULER). Background order/inventory jobs will not run — dashboard reads still hot-pull stale orders.',
      );
      return;
    }

    const ordersHotEveryMs =
      Number(process.env.AMAZON_ORDERS_HOT_SYNC_EVERY_MS) || 5 * 60 * 1000;
    const ordersFullSyncCron =
      process.env.AMAZON_ORDERS_FULL_SYNC_CRON ?? '0 2 * * *';
    const inventorySyncCron =
      process.env.AMAZON_INVENTORY_SYNC_CRON ?? '0 3 * * *';
    const shipmentsSyncCron =
      process.env.AMAZON_SHIPMENTS_SYNC_CRON ?? '0 4 * * *';
    const titlesBackfillCron =
      process.env.AMAZON_TITLES_BACKFILL_CRON ?? '0 5 * * *';
    const feeEstimateCron =
      process.env.FEE_ESTIMATE_REFRESH_CRON ?? '0 6 * * *';
    const listingPriceHotEveryMs =
      Number(process.env.LISTING_PRICE_REFRESH_HOT_EVERY_MS) || 30 * 60 * 1000;
    const listingPriceColdCron =
      process.env.LISTING_PRICE_REFRESH_COLD_CRON ?? '0 7 * * *';

    await this.queue.add(
      'orders-hot-sync',
      {},
      {
        repeat: { every: ordersHotEveryMs },
        jobId: 'orders-hot-sync',
      },
    );

    await this.removeLegacyRepeatable(
      'orders-batch-sync',
      Number(process.env.AMAZON_ORDERS_SYNC_EVERY_MS) || 10 * 60 * 1000,
    );
    await this.queue.add(
      'orders-batch-sync',
      {},
      {
        repeat: { pattern: ordersFullSyncCron },
        jobId: 'orders-batch-sync',
      },
    );

    await this.removeLegacyRepeatable(
      'inventory-batch-sync',
      Number(process.env.AMAZON_INVENTORY_SYNC_EVERY_MS) || 2 * 60 * 60 * 1000,
    );
    await this.queue.add(
      'inventory-batch-sync',
      {},
      {
        repeat: { pattern: inventorySyncCron },
        jobId: 'inventory-batch-sync',
      },
    );

    await this.removeLegacyRepeatable(
      'shipments-batch-sync',
      Number(process.env.AMAZON_SHIPMENTS_SYNC_EVERY_MS) || 2 * 60 * 60 * 1000,
    );
    await this.queue.add(
      'shipments-batch-sync',
      {},
      {
        repeat: { pattern: shipmentsSyncCron },
        jobId: 'shipments-batch-sync',
      },
    );

    await this.queue.add(
      'fee-estimate-refresh',
      {},
      {
        repeat: { pattern: feeEstimateCron },
        jobId: 'fee-estimate-refresh',
      },
    );

    const sellingEligibilityCron =
      process.env.SELLING_ELIGIBILITY_REFRESH_CRON ?? '30 6 * * *';
    const sellingEligibilityEnabled = (
      process.env.ENABLE_SELLING_ELIGIBILITY_DAILY ?? 'true'
    ).toLowerCase();
    if (['1', 'true', 'yes'].includes(sellingEligibilityEnabled)) {
      await this.queue.add(
        'selling-eligibility-daily',
        {},
        {
          repeat: { pattern: sellingEligibilityCron },
          jobId: 'selling-eligibility-daily',
        },
      );
    }

    await this.queue.add(
      'listing-price-refresh-hot',
      {},
      {
        repeat: { every: listingPriceHotEveryMs },
        jobId: 'listing-price-refresh-hot',
      },
    );
    await this.removeLegacyRepeatable(
      'listing-price-refresh-cold',
      Number(process.env.LISTING_PRICE_REFRESH_COLD_EVERY_MS) || 60 * 60 * 1000,
    );
    await this.queue.add(
      'listing-price-refresh-cold',
      {},
      {
        repeat: { pattern: listingPriceColdCron },
        jobId: 'listing-price-refresh-cold',
      },
    );

    await this.removeLegacyRepeatable(
      'product-titles-backfill',
      Number(process.env.AMAZON_TITLES_BACKFILL_EVERY_MS) || 4 * 60 * 60 * 1000,
    );
    await this.queue.add(
      'product-titles-backfill',
      {},
      {
        repeat: { pattern: titlesBackfillCron },
        jobId: 'product-titles-backfill',
      },
    );

    this.logger.log(
      `Scheduled Amazon sync (ordersHot=${ordersHotEveryMs}ms, ordersFull=${ordersFullSyncCron}, inventory=${inventorySyncCron}, shipments=${shipmentsSyncCron}, titles=${titlesBackfillCron}, fees=${feeEstimateCron}, listingHot=${listingPriceHotEveryMs}ms, listingCold=${listingPriceColdCron}, sellingEligibility=${['1', 'true', 'yes'].includes(sellingEligibilityEnabled) ? sellingEligibilityCron : 'off'})`,
    );
  }

  /** Remove pre-cron every-N-ms repeatable jobs after schedule changes. */
  private async removeLegacyRepeatable(jobName: string, everyMs: number): Promise<void> {
    if (!Number.isFinite(everyMs) || everyMs <= 0) return;
    try {
      await this.queue.removeRepeatable(jobName, { every: everyMs });
    } catch {
      /* no legacy job */
    }
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

  async enqueueFullSync(userId: string): Promise<boolean> {
    if (!(await this.userHasPaidAccess(userId))) {
      this.logger.log(
        `[enqueueFullSync] Skipping — no active subscription (userId=${userId.slice(0, 8)}…). Subscribe to sync Amazon data.`,
      );
      return false;
    }
    this.logger.log(`Enqueuing full-sync job (userId=${userId})`);
    // Set DB first so batch jobs (orders-batch-sync etc.) see progress 0 and skip this user until initial sync hits 100%
    try {
      await this.setInitialSyncProgressInDb(userId, 0);
    } catch (e) {
      this.logger.warn(`setInitialSyncProgressInDb(0) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Set Redis to 0 and phase so the frontend sees "0% – Fetching orders" as soon as it polls after redirect
    await this.redis.set(
      `amazon-initial-sync:${userId}`,
      JSON.stringify({ progress: 0, phase: 'Fetching orders' }),
      SYNC_PROGRESS_TTL,
    );
    await this.redis.del(`amazon-fee-sync:${userId}`);
    // Mini + full catalog continuation run in one worker job; needs a long lock (default 4h). Override with FULL_SYNC_JOB_LOCK_DURATION_MS.
    const fullSyncDelayMs = Math.max(
      0,
      Number(process.env.AMAZON_FULL_SYNC_DELAY_MS) || 0,
    );
    const fullSyncLockMs = Math.max(
      600_000,
      Number(process.env.FULL_SYNC_JOB_LOCK_DURATION_MS) || 4 * 60 * 60 * 1000,
    );
    await this.enqueueUniqueJob(
      'full-sync',
      `full-sync-${userId}`,
      { userId },
      `Full-sync for userId=${userId}`,
      { delay: fullSyncDelayMs, lockDurationMs: fullSyncLockMs },
    );
    return true;
  }

  /**
   * Resolve sync progress for the UI. Core mini-sync maps to 0–85%; post-initial + full fee job maps 85–100%.
   * `done` and 100% progress only when core is complete and fee-sync Redis is absent or at 100% (legacy: no fee key after core = complete).
   */
  async getSyncProgress(userId: string): Promise<{
    progress: number;
    done: boolean;
    stage: 'core' | 'fees' | 'complete';
    feeProgress: number;
    feeDone: boolean;
    corePhaseEndPct: number;
    phase?: string;
  }> {
    this.logger.log(`[sync-progress] getSyncProgress called userId=${userId.slice(0, 8)}…`);
    const parseRedisSync = (raw: string | null): { progress: number | null; phase?: string } => {
      if (!raw) return { progress: null };
      try {
        const parsed = JSON.parse(raw) as { progress?: number; phase?: string };
        const p = Number(parsed.progress);
        const progress = Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : null;
        return {
          progress,
          phase: typeof parsed.phase === 'string' ? parsed.phase : undefined,
        };
      } catch {
        return { progress: null };
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
    const redisSync = parseRedisSync(await this.redis.get(coreKey));
    const fromRedis = redisSync.progress;
    let progressSource: 'db' | 'job' | 'redis' | 'default';
    if (fullSyncJob) {
      jobState = await fullSyncJob.getState();
      if (jobState === 'active' || jobState === 'waiting') {
        const fromJob = fullSyncJob.progress;
        let jobNum: number | null = null;
        if (typeof fromJob === 'number' && Number.isFinite(fromJob)) {
          jobNum = Math.min(100, Math.max(0, fromJob));
        } else if (
          fromJob != null &&
          typeof fromJob === 'object' &&
          typeof (fromJob as { progress?: number }).progress === 'number'
        ) {
          jobNum = Math.min(100, Math.max(0, (fromJob as { progress: number }).progress));
        }
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

    const corePhase = redisSync.phase;
    const feeRaw = await this.redis.get(`amazon-fee-sync:${userId}`);
    const feeKeyPresent = feeRaw != null && feeRaw !== '';
    let feeProgressNum = 100;
    let feePhaseLabel: string | undefined;
    if (feeKeyPresent) {
      try {
        const parsed = JSON.parse(feeRaw) as { progress?: number; phase?: string };
        const p = Number(parsed.progress);
        feeProgressNum = Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0;
        if (typeof parsed.phase === 'string' && parsed.phase.trim() !== '') {
          feePhaseLabel = parsed.phase.trim();
        }
      } catch {
        feeProgressNum = 0;
      }
    }

    const coreComplete = coreProgress >= 100;
    const feeWorkPending =
      coreComplete && feeKeyPresent && feeProgressNum < 100;

    const done = coreComplete && !feeWorkPending;
    const stage: 'core' | 'fees' | 'complete' = !coreComplete
      ? 'core'
      : feeWorkPending
        ? 'fees'
        : 'complete';

    const unifiedProgress = !coreComplete
      ? Math.round(Math.min(100, Math.max(0, coreProgress)) * 0.85)
      : feeWorkPending
        ? Math.round(85 + (feeProgressNum / 100) * 15)
        : 100;

    const feeDone = !feeWorkPending;
    const corePhaseEndPct = 85;

    const resolvedPhase =
      corePhase != null && corePhase.trim() !== ''
        ? corePhase
        : !coreComplete
          ? coreProgress < 25
            ? 'Syncing orders'
            : coreProgress < 50
              ? 'Syncing inventory'
              : coreProgress < 75
                ? 'Syncing shipments'
                : 'Syncing fee estimates'
          : feeWorkPending
            ? feePhaseLabel ?? 'Completing catalog sync'
            : undefined;

    this.logger.log(
      `[sync-progress] userId=${userId.slice(0, 8)}… jobState=${jobState ?? 'none'} core=${coreProgress} unified=${unifiedProgress} stage=${stage} from=${progressSource}`,
    );
    if (progressSource === 'default' && coreProgress === 0) {
      this.logger.log(
        '[sync-progress] No job/Redis/DB for this user. For local dev, ensure OAuth redirect and API use the same backend – see docs/local-sync-bar.md',
      );
    }

    return {
      progress: unifiedProgress,
      done,
      stage,
      feeProgress: feeKeyPresent ? feeProgressNum : 100,
      feeDone,
      corePhaseEndPct,
      phase: resolvedPhase,
    };
  }

  async enqueueFeeSync(userId: string, orgId: string): Promise<void> {
    if (!(await this.userHasPaidAccess(userId))) {
      this.logger.log(
        `[enqueueFeeSync] Skipping — no active subscription (userId=${userId.slice(0, 8)}…)`,
      );
      return;
    }
    this.logger.log(`Enqueuing fee-sync job (userId=${userId}, orgId=${orgId})`);
    await this.redis.set(
      `amazon-fee-sync:${userId}`,
      JSON.stringify({ progress: 0 }),
      SYNC_PROGRESS_TTL,
    );
    // Large catalogs can exceed BullMQ’s default lock (~30s) and get marked stalled mid-run.
    const lockDurationMs = Math.max(
      600_000,
      Number(process.env.FEE_SYNC_JOB_LOCK_DURATION_MS) || 4 * 60 * 60 * 1000,
    );
    await this.enqueueUniqueJob(
      'fee-sync',
      `fee-sync-${userId}`,
      { userId, orgId },
      `Fee-sync for userId=${userId}`,
      { lockDurationMs },
    );
  }

  /**
   * Enqueue full fee + list-price refresh for an org (first member with an active Amazon link).
   * Used after inventory batch when some SKUs still lack data for stock value.
   */
  async enqueueFeeSyncForOrg(orgId: string): Promise<void> {
    const members = await this.prisma.organizationMembership.findMany({
      where: { orgId },
      select: { userId: true },
    });
    for (const { userId } of members) {
      const linked = await this.prisma.sellerAccount.findFirst({
        where: { userId, marketplace: 'amazon', isActive: true },
        select: { id: true },
      });
      if (linked) {
        await this.enqueueFeeSync(userId, orgId);
        return;
      }
    }
  }

  /** Enqueue titles backfill to run in background after initial sync (Catalog API, 1 req per product). */
  async enqueueTitlesBackfill(orgId: string, userId: string): Promise<void> {
    const limit = Math.min(
      300,
      Math.max(0, Number(process.env.AMAZON_INITIAL_TITLES_BACKFILL_LIMIT) || 100),
    );
    if (limit <= 0) return;
    this.logger.log(`Enqueuing titles-backfill job (orgId=${orgId}, limit=${limit})`);
    await this.enqueueUniqueJob(
      'titles-backfill',
      `titles-backfill-${orgId}`,
      { orgId, userId, limit },
      `Titles backfill for org ${orgId}`,
    );
  }

  /** Enqueue category backfill (productType/displayGroup) to run in background. Runs after initial sync and after order sync so new ASINs get categories. */
  async enqueueCategoryBackfill(orgId: string, userId: string, options?: { limit?: number }): Promise<void> {
    if (!(await this.userHasPaidAccess(userId))) {
      this.logger.log(
        `[enqueueCategoryBackfill] Skipping — no active subscription (userId=${userId.slice(0, 8)}…)`,
      );
      return;
    }
    const limit = Math.min(
      250,
      Math.max(1, options?.limit ?? (Number(process.env.AMAZON_CATEGORY_BACKFILL_LIMIT) || 100)),
    );
    this.logger.log(`Enqueuing category-backfill job (orgId=${orgId}, limit=${limit})`);
    await this.enqueueUniqueJob(
      'category-backfill',
      `category-backfill-${orgId}`,
      { orgId, userId, limit },
      `Category backfill for org ${orgId}`,
    );
  }

  private billingBypassed(): boolean {
    const flag = (process.env.BYPASS_BILLING ?? '').toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(flag);
  }

  /**
   * Same rules as SubscriptionService.hasAccess (no Subscription import — avoids module cycle).
   * All Amazon SP-API sync / DB writes require this (active, trialing, or canceled within trial).
   */
  async userHasPaidAccess(userId: string): Promise<boolean> {
    if (this.billingBypassed()) return true;
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
      select: { status: true, trialEndAt: true },
    });
    if (!sub) return false;
    if (sub.status === 'active' || sub.status === 'trialing') return true;
    if (sub.status === 'canceled' && sub.trialEndAt && new Date() < sub.trialEndAt)
      return true;
    return false;
  }

  /** Org is sync-eligible when a member with an active Amazon link has paid access. */
  async orgHasPaidAccess(orgId: string): Promise<boolean> {
    if (this.billingBypassed()) return true;
    const members = await this.prisma.organizationMembership.findMany({
      where: { orgId },
      select: { userId: true },
    });
    for (const { userId } of members) {
      const linked = await this.prisma.sellerAccount.findFirst({
        where: { userId, marketplace: 'amazon', isActive: true },
        select: { id: true },
      });
      if (!linked) continue;
      if (await this.userHasPaidAccess(userId)) return true;
    }
    return false;
  }

  private subscribedAmazonSellerAccountWhere(): Prisma.SellerAccountWhereInput {
    if (this.billingBypassed()) {
      return { marketplace: 'amazon', isActive: true };
    }
    const now = new Date();
    return {
      marketplace: 'amazon',
      isActive: true,
      user: {
        subscriptions: {
          some: {
            OR: [
              { status: { in: ['active', 'trialing'] } },
              { status: 'canceled', trialEndAt: { gt: now } },
            ],
          },
        },
      },
    };
  }

  private subscribedAmazonOrgWhere(): Prisma.OrganizationWhereInput {
    return {
      members: {
        some: {
          user: {
            sellerAccounts: {
              some: this.subscribedAmazonSellerAccountWhere(),
            },
          },
        },
      },
    };
  }

  /** Active Amazon sellers with a paid subscription — for scheduled order sync jobs. */
  async findAmazonSellerUserIdsForScheduledSync(): Promise<string[]> {
    const allow = this.scheduledSyncEmailAllowlist();
    const accounts = await this.prisma.sellerAccount.findMany({
      where: this.subscribedAmazonSellerAccountWhere(),
      select: {
        userId: true,
        user: { select: { email: true } },
      },
    });
    let ids = accounts.map((a) => a.userId);
    if (allow) {
      ids = accounts
        .filter((a) => allow.has(String(a.user?.email ?? '').toLowerCase()))
        .map((a) => a.userId);
      this.logger.log(
        `[AmazonSync] scheduled sync email allowlist active (${[...allow].join(', ')}): ${ids.length} seller user(s)`,
      );
    }
    return [...new Set(ids)];
  }

  /**
   * Optional comma-separated login emails. When set, scheduled Amazon sync (and related batch
   * jobs that use these helpers) only run for those accounts — useful on a personal VPS that
   * still holds a multi-tenant DB dump.
   */
  private scheduledSyncEmailAllowlist(): Set<string> | null {
    const raw = (process.env.AMAZON_SCHEDULED_SYNC_EMAILS ?? '').trim();
    if (!raw) return null;
    const set = new Set(
      raw
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0),
    );
    return set.size > 0 ? set : null;
  }

  /** Orgs with a subscribed Amazon link — for inventory/shipments/listings batch jobs. */
  async findAmazonOrgIdsForScheduledSync(): Promise<string[]> {
    const allow = this.scheduledSyncEmailAllowlist();
    if (!allow) {
      const orgs = await this.prisma.organization.findMany({
        where: this.subscribedAmazonOrgWhere(),
        select: { id: true },
      });
      return orgs.map((o) => o.id);
    }
    const users = await this.prisma.user.findMany({
      where: {
        OR: [...allow].map((email) => ({
          email: { equals: email, mode: 'insensitive' as const },
        })),
      },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    if (!userIds.length) {
      this.logger.warn(
        `[AmazonSync] AMAZON_SCHEDULED_SYNC_EMAILS set but no matching users; skipping org batch sync`,
      );
      return [];
    }
    const memberships = await this.prisma.organizationMembership.findMany({
      where: {
        userId: { in: userIds },
        org: this.subscribedAmazonOrgWhere(),
      },
      select: { orgId: true },
    });
    const ids = [...new Set(memberships.map((m) => m.orgId))];
    this.logger.log(
      `[AmazonSync] scheduled org allowlist (${[...allow].join(', ')}): ${ids.length} org(s)`,
    );
    return ids;
  }

  /** True when the limited initial-sync job has written 100% to InitialSyncProgress. */
  async isInitialMiniSyncComplete(userId: string): Promise<boolean> {
    const row = await this.prisma.initialSyncProgress.findUnique({
      where: { userId },
      select: { progress: true },
    });
    const p = row?.progress ?? 0;
    return Number.isFinite(p) && p >= 100;
  }

  /** Fee-sync Redis key exists (full catalog pipeline was started or completed). */
  async hasAmazonFeeSyncProgressKey(userId: string): Promise<boolean> {
    const raw = await this.redis.get(`amazon-fee-sync:${userId}`);
    return raw != null && raw !== '';
  }

  async resolveOrgIdForAmazonSync(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { activeOrgId: true },
    });
    let orgId = user?.activeOrgId ?? null;
    if (!orgId) {
      const membership = await this.prisma.organizationMembership.findFirst({
        where: { userId },
        select: { orgId: true },
      });
      orgId = membership?.orgId ?? null;
    }
    return orgId;
  }

  /**
   * After Stripe checkout (subscription row exists): kick the right Amazon job.
   * - No Amazon link → no-op.
   * - Mini sync not finished → full-sync (limited pass; full catalog runs at end only if still paid).
   * - Mini done, no fee-sync key (connected Amazon while unpaid) → post-initial only.
   * - Fee-sync key already present → no-op (renewal / repeat webhook).
   */
  async enqueueAmazonSyncAfterSubscription(userId: string): Promise<void> {
    const linked = await this.prisma.sellerAccount.findFirst({
      where: { userId, marketplace: 'amazon', isActive: true },
      select: { id: true },
    });
    if (!linked) return;

    const miniDone = await this.isInitialMiniSyncComplete(userId);
    if (!miniDone) {
      await this.enqueueFullSync(userId);
      return;
    }
    if (await this.hasAmazonFeeSyncProgressKey(userId)) {
      this.logger.log(
        `[subscription-sync] Skip post-initial (fee-sync key exists) userId=${userId.slice(0, 8)}…`,
      );
      return;
    }
    const orgId = await this.resolveOrgIdForAmazonSync(userId);
    if (!orgId) {
      this.logger.warn(
        `[subscription-sync] Cannot enqueue post-initial — no org userId=${userId.slice(0, 8)}…`,
      );
      return;
    }
    await this.enqueuePostInitialSync(userId, orgId);
  }

  /**
   * Enqueue full catalog sync as its own job (after subscription when mini sync was done unpaid, or retries).
   */
  async enqueuePostInitialSync(userId: string, orgId: string): Promise<void> {
    this.logger.log(`Enqueuing post-initial-sync job (userId=${userId}, orgId=${orgId})`);
    await this.enqueueUniqueJob(
      'post-initial-sync',
      `post-initial-sync-${userId}`,
      { userId, orgId },
      `Post-initial sync for userId=${userId}`,
    );
  }

  /**
   * Wipe all Amazon-synced data for a user and re-enqueue initial sync.
   * Keeps SellerAccount (credentials) so they don't have to re-auth.
   * Use for testing when initial sync misbehaves.
   */
  async wipeSyncDataAndRestartInitialSync(userId: string): Promise<void> {
    this.logger.log(`[wipe-sync-data] Starting for userId=${userId}`);
    await this.prisma.orderItem.deleteMany({ where: { userId } });
    await this.prisma.order.deleteMany({ where: { userId } });
    await this.prisma.inventory.deleteMany({ where: { userId } });
    await this.prisma.inventoryByMarketplace.deleteMany({ where: { userId } });
    await this.prisma.shipment.deleteMany({ where: { userId } });
    await this.prisma.initialSyncProgress.deleteMany({ where: { userId } });
    await this.redis.del(`amazon-initial-sync:${userId}`);
    await this.redis.del(`amazon-fee-sync:${userId}`);
    await this.prisma.sellerAccount.updateMany({
      where: { userId, marketplace: 'amazon' },
      data: { ordersLastSyncedAt: null } as any,
    });
    for (const jobId of [`full-sync-${userId}`, `post-initial-sync-${userId}`]) {
      try {
        const job = await this.queue.getJob(jobId);
        if (job) await job.remove();
      } catch {
        // Job may not exist
      }
    }
    this.logger.log(`[wipe-sync-data] Data wiped for userId=${userId}; enqueuing full-sync`);
    await this.enqueueFullSync(userId);
  }

  /**
   * Dashboard / Orders polls: if Amazon order sync is stale, queue a fast hot pull (Pending sales).
   * Complements the 5-minute repeatable job when the worker was down or the app was closed.
   */
  async nudgeHotOrdersSyncForOrg(orgId: string): Promise<void> {
    const memberships = await this.prisma.organizationMembership.findMany({
      where: { orgId },
      select: { userId: true },
    });
    const memberIds = memberships.map((m) => m.userId);
    if (memberIds.length === 0) return;

    const staleMs = Math.max(
      60_000,
      Number(process.env.AMAZON_ORDERS_HOT_NUDGE_STALE_MS) || 8 * 60 * 1000,
    );
    const now = Date.now();

    const accounts = await this.prisma.sellerAccount.findMany({
      where: {
        userId: { in: memberIds },
        marketplace: 'amazon',
        isActive: true,
      },
      select: { userId: true, ordersLastSyncedAt: true },
    });

    for (const account of accounts) {
      const { userId } = account;
      if (!(await this.userHasPaidAccess(userId))) continue;
      if (!(await this.isInitialMiniSyncComplete(userId))) continue;

      const last = account.ordersLastSyncedAt;
      if (last instanceof Date && now - last.getTime() < staleMs) continue;

      await this.enqueueUniqueJob(
        'orders-hot-sync-user',
        `orders-hot-nudge-${userId}`,
        { userId },
        `[orders-hot-nudge] userId=${userId.slice(0, 8)}…`,
      );
    }
  }
}
