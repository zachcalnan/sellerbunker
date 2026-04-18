import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AmazonService } from './amazon.service';
import {
  AMAZON_EXTENDED_ORDER_HISTORY_DONE_KEY_PREFIX,
  AMAZON_EXTENDED_ORDER_HISTORY_EMAIL,
  AMAZON_EXTENDED_ORDER_HISTORY_LOCK_KEY_PREFIX,
} from './amazon-extended-sync.constants';

/**
 * **Single allowlisted login only** — same email as `AMAZON_EXTENDED_ORDER_HISTORY_EMAIL`
 * (`rugby.4.lif3@hotmail.com` in `amazon-extended-sync.constants.ts`). No loop over orgs or
 * all `users` rows; we `findFirst` that email and exit otherwise.
 *
 * Bump version when fee logic changes so that one account gets one more automatic backfill (no manual POST).
 * Redis key suffix is that account’s internal `user.id` — not “every user”.
 */
const DONE_KEY_PREFIX = 'sb:order-line-fee-backfill-done:v4:';
const LOCK_KEY_PREFIX = 'sb:order-line-fee-backfill-lock:v4:';
const LOCK_TTL_SEC = 12 * 60 * 60;
/** Initial defer so Nest + extended-history can acquire Redis before we poll the extended lock. */
const START_DELAY_MS = 15_000;
const EXTENDED_LOCK_POLL_MS = 30_000;
const EXTENDED_LOCK_MAX_WAIT_MS = 45 * 60 * 1000;
/** After extended finishes (or was never running), pause so Orders/Finances quotas recover before backfill. */
const POST_EXTENDED_COOLDOWN_MS = 150_000;
const POST_EXTENDED_DONE_COOLDOWN_MS = 20_000;

/** Auto fee line refresh for the one hardcoded allowlist email only — not for other customers. */
@Injectable()
export class AmazonOrderLineFeeBackfillBootstrap
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(AmazonOrderLineFeeBackfillBootstrap.name);
  private lockKeyHeld: string | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly amazonService: AmazonService,
    private readonly redis: RedisService,
  ) {}

  onApplicationBootstrap(): void {
    const bootOn = (process.env.AMAZON_ORDER_LINE_FEE_BACKFILL_BOOTSTRAP ?? 'true').toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(bootOn)) {
      this.logger.log(
        '[order-line-fee-backfill] Skipped (set AMAZON_ORDER_LINE_FEE_BACKFILL_BOOTSTRAP=false to reduce Finances 429s while debugging)',
      );
      return;
    }
    this.logger.log(
      `[order-line-fee-backfill] Scheduled allowlist-only fee line refresh in ${START_DELAY_MS / 1000}s (after boot)`,
    );
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.runOnceInBackground();
    }, START_DELAY_MS);
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.lockKeyHeld) {
      try {
        await this.redis.del(this.lockKeyHeld);
        this.logger.log(
          `[order-line-fee-backfill] Released lock on shutdown (${this.lockKeyHeld})`,
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
        select: { id: true },
      });
      if (!user) {
        this.logger.log(
          `[order-line-fee-backfill] No user with email ${AMAZON_EXTENDED_ORDER_HISTORY_EMAIL}; skipping`,
        );
        return;
      }

      const doneKey = `${DONE_KEY_PREFIX}${user.id}`;
      if (await this.redis.exists(doneKey)) {
        this.logger.log(
          `[order-line-fee-backfill] Already completed for userId=${user.id.slice(0, 8)}…; skipping`,
        );
        return;
      }

      const amazon = await this.prisma.sellerAccount.findFirst({
        where: { userId: user.id, marketplace: 'amazon', isActive: true },
        select: { id: true },
      });
      if (!amazon) {
        this.logger.log(
          `[order-line-fee-backfill] No active Amazon seller account for userId=${user.id.slice(0, 8)}…; skipping`,
        );
        return;
      }

      // Coordinate with extended-history: do NOT take our Redis lock until extended is done or idle,
      // then cool down so getOrders + listFinancialEvents are not stacked (429 QuotaExceeded).
      const extLockKey = `${AMAZON_EXTENDED_ORDER_HISTORY_LOCK_KEY_PREFIX}${user.id}`;
      const extDoneKey = `${AMAZON_EXTENDED_ORDER_HISTORY_DONE_KEY_PREFIX}${user.id}`;
      if (await this.redis.exists(extDoneKey)) {
        this.logger.log(
          `[order-line-fee-backfill] Extended history already marked done; waiting ${POST_EXTENDED_DONE_COOLDOWN_MS / 1000}s before Finances backfill`,
        );
        await new Promise((r) => setTimeout(r, POST_EXTENDED_DONE_COOLDOWN_MS));
      } else {
        const lockWaitDeadline = Date.now() + EXTENDED_LOCK_MAX_WAIT_MS;
        while (await this.redis.exists(extLockKey)) {
          if (Date.now() >= lockWaitDeadline) {
            this.logger.warn(
              `[order-line-fee-backfill] Extended-history lock still present after ${EXTENDED_LOCK_MAX_WAIT_MS / 60000}m; continuing with cool-down anyway`,
            );
            break;
          }
          this.logger.log(
            `[order-line-fee-backfill] Extended-history sync holds the SP-API lock; waiting ${EXTENDED_LOCK_POLL_MS / 1000}s…`,
          );
          await new Promise((r) => setTimeout(r, EXTENDED_LOCK_POLL_MS));
        }
        this.logger.log(
          `[order-line-fee-backfill] Waiting ${POST_EXTENDED_COOLDOWN_MS / 1000}s so Orders/Finances quotas recover before backfill`,
        );
        await new Promise((r) => setTimeout(r, POST_EXTENDED_COOLDOWN_MS));
      }

      const lockKey = `${LOCK_KEY_PREFIX}${user.id}`;
      let gotLock = await this.redis.setIfNotExistsWithExpiry(
        lockKey,
        String(process.pid),
        LOCK_TTL_SEC,
      );
      if (!gotLock && !(await this.redis.exists(doneKey))) {
        this.logger.warn(
          `[order-line-fee-backfill] Stale lock; clearing once and retrying (${lockKey})`,
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
          `[order-line-fee-backfill] Lock held; skipping. To force: DEL ${lockKey} in Redis, bump DONE version in code, restart.`,
        );
        return;
      }

      this.lockKeyHeld = lockKey;

      try {
        this.logger.log(
          `[order-line-fee-backfill] Starting backfillOrderItems(365) for allowlist email only (${AMAZON_EXTENDED_ORDER_HISTORY_EMAIL}) userId=${user.id.slice(0, 8)}…`,
        );
        const result = await this.amazonService.backfillOrderItems(user.id, 365);
        this.logger.log(
          `[order-line-fee-backfill] Finished: processedOrders=${result.processedOrders} upsertedItems=${result.upsertedItems} totalOrders=${result.totalOrders}`,
        );
        await this.redis.set(doneKey, '1');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(`[order-line-fee-backfill] Failed: ${msg}`);
      } finally {
        await this.redis.del(lockKey).catch(() => undefined);
        this.lockKeyHeld = null;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`[order-line-fee-backfill] Bootstrap error: ${msg}`);
    }
  }
}
