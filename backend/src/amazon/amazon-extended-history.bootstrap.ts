import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AmazonService } from './amazon.service';
import { AmazonSyncService } from './amazon-sync.service';
import {
  AMAZON_EXTENDED_ORDER_HISTORY_DONE_KEY_PREFIX,
  AMAZON_EXTENDED_ORDER_HISTORY_EMAIL,
  AMAZON_EXTENDED_ORDER_HISTORY_LOCK_KEY_PREFIX,
} from './amazon-extended-sync.constants';

const DONE_KEY_PREFIX = AMAZON_EXTENDED_ORDER_HISTORY_DONE_KEY_PREFIX;
const LOCK_KEY_PREFIX = AMAZON_EXTENDED_ORDER_HISTORY_LOCK_KEY_PREFIX;
/** Long enough for a year-long sync; released in `finally` and on graceful shutdown. */
const LOCK_TTL_SEC = 12 * 60 * 60;

/**
 * One-time (per user id) full-year order + finances pull for the allowlisted email only.
 * Runs in the background after app boot so you do not need to call the API manually.
 */
@Injectable()
export class AmazonExtendedHistoryBootstrap
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(AmazonExtendedHistoryBootstrap.name);
  /** Lock key we currently hold (so we can release on SIGTERM / nest --watch restart). */
  private lockKeyHeld: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly amazonService: AmazonService,
    private readonly amazonSyncService: AmazonSyncService,
    private readonly redis: RedisService,
  ) {}

  onApplicationBootstrap(): void {
    void this.runOnceInBackground();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.lockKeyHeld) {
      try {
        await this.redis.del(this.lockKeyHeld);
        this.logger.log(
          `[extended-history] Released lock on shutdown (${this.lockKeyHeld})`,
        );
      } catch {
        /* ignore */
      }
      this.lockKeyHeld = null;
    }
  }

  private async runOnceInBackground(): Promise<void> {
    try {
      const user = await this.prisma.user.findFirst({
        where: {
          email: { equals: AMAZON_EXTENDED_ORDER_HISTORY_EMAIL, mode: 'insensitive' },
        },
        select: { id: true, activeOrgId: true },
      });
      if (!user) {
        this.logger.log(
          `[extended-history] No user with email ${AMAZON_EXTENDED_ORDER_HISTORY_EMAIL}; skipping`,
        );
        return;
      }

      const doneKey = `${DONE_KEY_PREFIX}${user.id}`;
      if (await this.redis.exists(doneKey)) {
        this.logger.log(
          `[extended-history] Already completed for userId=${user.id.slice(0, 8)}…; skipping`,
        );
        return;
      }

      const amazon = await this.prisma.sellerAccount.findFirst({
        where: { userId: user.id, marketplace: 'amazon', isActive: true },
        select: { id: true },
      });
      if (!amazon) {
        this.logger.log(
          `[extended-history] No active Amazon seller account for userId=${user.id.slice(0, 8)}…; skipping`,
        );
        return;
      }

      if (!(await this.amazonSyncService.userHasPaidAccess(user.id))) {
        this.logger.log(
          `[extended-history] No active subscription for userId=${user.id.slice(0, 8)}…; skipping`,
        );
        return;
      }

      const lockKey = `${LOCK_KEY_PREFIX}${user.id}`;
      let gotLock = await this.redis.setIfNotExistsWithExpiry(
        lockKey,
        String(process.pid),
        LOCK_TTL_SEC,
      );
      // nest --watch / SIGKILL often leaves a stale lock while `done` is still unset — clear once and retry.
      if (!gotLock && !(await this.redis.exists(doneKey))) {
        this.logger.warn(
          `[extended-history] Lock present but job not marked done (stale lock or crashed run). Clearing lock and retrying once.`,
        );
        await this.redis.del(lockKey);
        gotLock = await this.redis.setIfNotExistsWithExpiry(
          lockKey,
          String(process.pid),
          LOCK_TTL_SEC,
        );
      }
      if (!gotLock) {
        this.logger.log(
          `[extended-history] Lock held by another process (or retry lost race); skipping. To force: DEL ${lockKey} in Redis, then restart.`,
        );
        return;
      }

      this.lockKeyHeld = lockKey;

      try {
        this.logger.log(
          `[extended-history] Starting 365-day order sync (ignoreCursor) for userId=${user.id.slice(0, 8)}…`,
        );
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) {
            const waitMs = 180_000;
            this.logger.warn(
              `[extended-history] Waiting ${waitMs / 1000}s before retry ${attempt + 1}/3 (quota / transient)`,
            );
            await new Promise((r) => setTimeout(r, waitMs));
          }
          try {
            await this.amazonService.syncRecentOrdersToDb(user.id, {
              days: 365,
              ignoreCursor: true,
            });
            break;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const is429 =
              msg.includes('429') ||
              msg.includes('QuotaExceeded') ||
              msg.includes('quota');
            if (!is429 || attempt === 2) {
              throw e;
            }
            this.logger.warn(
              `[extended-history] 365-day sync failed (will retry): ${msg.slice(0, 200)}`,
            );
          }
        }

        let orgId = user.activeOrgId ?? null;
        if (!orgId) {
          const m = await this.prisma.organizationMembership.findFirst({
            where: { userId: user.id },
            select: { orgId: true },
          });
          orgId = m?.orgId ?? null;
        }
        if (orgId) {
          try {
            await this.amazonSyncService.enqueueFeeSync(user.id, orgId);
          } catch (feeErr) {
            const msg = feeErr instanceof Error ? feeErr.message : String(feeErr);
            this.logger.warn(`[extended-history] enqueueFeeSync failed (non-fatal): ${msg}`);
          }
        }

        await this.redis.set(doneKey, '1');
        this.logger.log(
          `[extended-history] Completed 365-day order sync for userId=${user.id.slice(0, 8)}…`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(`[extended-history] Sync failed: ${msg}`);
      } finally {
        await this.redis.del(lockKey).catch(() => undefined);
        this.lockKeyHeld = null;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`[extended-history] Bootstrap error: ${msg}`);
    }
  }
}
