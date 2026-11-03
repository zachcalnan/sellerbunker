import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  /** Absolute HTTPS URL — used as notification icon (and large image where supported). */
  icon?: string;
  image?: string;
  badge?: string;
  /** In-app toast uses this for emerald profit styling. */
  profitLabel?: string;
};

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private configured = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    const publicKey = (this.config.get<string>('VAPID_PUBLIC_KEY') ?? '').trim();
    const privateKey = (this.config.get<string>('VAPID_PRIVATE_KEY') ?? '').trim();
    const subject = (
      this.config.get<string>('VAPID_SUBJECT') ?? 'mailto:support@sellerbunker.com'
    ).trim();
    if (publicKey && privateKey) {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      this.configured = true;
    } else {
      this.logger.warn(
        'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — web push disabled until configured',
      );
    }
  }

  isConfigured(): boolean {
    return this.configured;
  }

  getPublicKey(): string | null {
    const k = (this.config.get<string>('VAPID_PUBLIC_KEY') ?? '').trim();
    return k || null;
  }

  async upsertSubscription(args: {
    userId: string;
    orgId?: string | null;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
  }) {
    return this.prisma.pushSubscription.upsert({
      where: {
        userId_endpoint: {
          userId: args.userId,
          endpoint: args.endpoint,
        },
      },
      create: {
        userId: args.userId,
        orgId: args.orgId ?? null,
        endpoint: args.endpoint,
        p256dh: args.p256dh,
        auth: args.auth,
        userAgent: args.userAgent ?? null,
      },
      update: {
        orgId: args.orgId ?? null,
        p256dh: args.p256dh,
        auth: args.auth,
        userAgent: args.userAgent ?? null,
      },
    });
  }

  async removeSubscription(userId: string, endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
  }

  /** Notify all org members who have a browser subscription. */
  async notifyOrg(
    orgId: string,
    payload: PushPayload,
    opts?: {
      dedupeKey?: string;
      dedupeTtlSec?: number;
      /** Always include these user ids (e.g. the seller) even if org lookup is empty. */
      alsoUserIds?: string[];
    },
  ): Promise<{ sent: number; skipped: boolean }> {
    if (!this.configured) return { sent: 0, skipped: true };
    if (opts?.dedupeKey) {
      const key = `push:dedupe:${opts.dedupeKey}`;
      const ttl = opts.dedupeTtlSec ?? 60 * 60 * 24;
      try {
        const ok = await this.redis.setIfNotExistsWithExpiry(key, '1', ttl);
        if (!ok) return { sent: 0, skipped: true };
      } catch {
        // If Redis is down, still attempt send (may duplicate).
      }
    }

    const members = await this.prisma.organizationMembership.findMany({
      where: { orgId },
      select: { userId: true },
    });
    const userIds = Array.from(
      new Set([
        ...members.map((m) => m.userId),
        ...(opts?.alsoUserIds ?? []).filter(Boolean),
      ]),
    );
    if (userIds.length === 0) return { sent: 0, skipped: false };

    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId: { in: userIds } },
    });
    if (subs.length === 0) {
      this.logger.warn(
        `Push skipped (no subscriptions) orgId=${orgId} tag=${payload.tag ?? ''}`,
      );
      return { sent: 0, skipped: false };
    }
    let sent = 0;
    for (const sub of subs) {
      const ok = await this.sendToSubscription(sub, payload);
      if (ok) sent += 1;
    }
    if (sent === 0) {
      this.logger.warn(
        `Push sent=0 for orgId=${orgId} tag=${payload.tag ?? ''} subs=${subs.length}`,
      );
    } else {
      this.logger.log(
        `Push sent=${sent} orgId=${orgId} tag=${payload.tag ?? ''}`,
      );
    }
    return { sent, skipped: false };
  }

  /** Send a test notification to every subscription for this user. */
  async notifyUser(
    userId: string,
    payload: PushPayload,
  ): Promise<{ sent: number }> {
    if (!this.configured) return { sent: 0 };
    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId },
    });
    let sent = 0;
    for (const sub of subs) {
      const ok = await this.sendToSubscription(sub, payload);
      if (ok) sent += 1;
    }
    return { sent };
  }

  private async sendToSubscription(
    sub: {
      id: string;
      endpoint: string;
      p256dh: string;
      auth: string;
    },
    payload: PushPayload,
  ): Promise<boolean> {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(payload),
        {
          // Prefer immediate delivery (helps when the app is backgrounded / locked).
          urgency: 'high',
          // Keep long enough that a brief offline / Doze window still delivers.
          TTL: 60 * 60 * 24,
          headers: {
            Urgency: 'high',
          },
        },
      );
      return true;
    } catch (e: unknown) {
      const statusCode =
        e && typeof e === 'object' && 'statusCode' in e
          ? Number((e as { statusCode?: number }).statusCode)
          : 0;
      if (statusCode === 404 || statusCode === 410) {
        await this.prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      } else {
        this.logger.warn(
          `Push failed for ${sub.endpoint.slice(0, 48)}…: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      return false;
    }
  }
}
