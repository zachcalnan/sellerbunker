import { BadRequestException, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { AmazonSyncService } from '../amazon/amazon-sync.service';

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    @Inject(forwardRef(() => AmazonSyncService))
    private readonly amazonSyncService: AmazonSyncService,
  ) {}

  private isBillingBypassed(): boolean {
    const flag = (process.env.BYPASS_BILLING ?? '').toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(flag);
  }

  /** True if user has an active/trialing subscription, or canceled but still within trial end. */
  async hasAccess(userId: string): Promise<boolean> {
    if (this.isBillingBypassed()) return true;
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
    });
    if (!sub) return false;
    if (sub.status === 'active' || sub.status === 'trialing') return true;
    if (sub.status === 'canceled' && sub.trialEndAt && new Date() < sub.trialEndAt) return true;
    return false;
  }

  /** Returns the user's subscription plan name for display (e.g. "Basic plan"). Defaults to Basic when they have access. */
  async getPlanName(userId: string): Promise<string | null> {
    if (this.isBillingBypassed()) return 'Test access';
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
    });
    if (!sub) return null;
    if (await this.hasAccess(userId)) return 'Basic plan';
    return null;
  }

  /** When the user will lose access (trial end or period end), or when the next billing date is (for trialing with card). */
  async getLockoutAt(userId: string): Promise<Date | null> {
    if (this.isBillingBypassed()) return null;
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
    });
    if (!sub || !sub.trialEndAt) return null;
    if (sub.status === 'trialing' || sub.status === 'canceled') return sub.trialEndAt;
    return null;
  }

  /** Subscription status for display: trialing (will convert to paid at trial end), active, canceled, or null. */
  async getSubscriptionStatus(userId: string): Promise<string | null> {
    if (this.isBillingBypassed()) return null;
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
    });
    if (!sub) return null;
    return sub.status;
  }

  /** Map Stripe subscription → DB (webhooks + Stripe Dashboard cancel). */
  mapStripeSubscriptionToDb(stripeSub: {
    status: string;
    trial_end?: number | null;
    current_period_end?: number | null;
    cancel_at_period_end?: boolean;
  }): { status: string; trialEndAt: Date | null } {
    const trialEnd =
      stripeSub.trial_end != null ? new Date(stripeSub.trial_end * 1000) : null;
    const periodEnd =
      stripeSub.current_period_end != null
        ? new Date(stripeSub.current_period_end * 1000)
        : null;

    // Match in-app cancel: scheduled end → status canceled + lockout date.
    if (stripeSub.cancel_at_period_end) {
      return {
        status: 'canceled',
        trialEndAt: periodEnd ?? trialEnd,
      };
    }

    if (stripeSub.status === 'trialing') {
      return { status: 'trialing', trialEndAt: trialEnd ?? periodEnd };
    }

    if (stripeSub.status === 'active') {
      return { status: 'active', trialEndAt: periodEnd };
    }

    return {
      status: stripeSub.status,
      trialEndAt: trialEnd ?? periodEnd,
    };
  }

  /** Sync our subscription record from Stripe (Dashboard cancel, payment failure, etc.). */
  async syncFromStripeSubscription(stripeSub: {
    id: string;
    status: string;
    trial_end?: number | null;
    current_period_end?: number | null;
    cancel_at_period_end?: boolean;
  }): Promise<void> {
    const existing = await this.prisma.subscription.findFirst({
      where: { stripeSubscriptionId: stripeSub.id },
    });
    if (!existing) return;

    const mapped = this.mapStripeSubscriptionToDb(stripeSub);
    await this.prisma.subscription.update({
      where: { id: existing.id },
      data: {
        status: mapped.status,
        trialEndAt: mapped.trialEndAt,
      },
    });
    this.logger.log(
      `Synced subscription ${stripeSub.id} → status=${mapped.status} lockout=${mapped.trialEndAt?.toISOString() ?? 'none'}`,
    );
  }

  /** Remove subscription when Clerk account is deleted so re-sign-up must go through payment again. */
  async deleteByClerkId(clerkId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { clerkId },
    });
    if (!user) return;
    await this.prisma.subscription.deleteMany({
      where: { userId: user.id },
    });
    await this.prisma.user.update({
      where: { id: user.id },
      data: { clerkId: null },
    });
  }

  /**
   * Cancel the user's subscription at period end (or trial end). Tells Stripe to cancel at period end,
   * then sets our DB to status=canceled and trialEndAt=end date so access continues until then.
   */
  async cancelSubscription(userId: string): Promise<{ lockoutAt: Date }> {
    if (this.isBillingBypassed()) {
      throw new BadRequestException('Billing is bypassed');
    }
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
    });
    if (!sub?.stripeSubscriptionId) {
      throw new BadRequestException('No active subscription to cancel');
    }
    if (sub.status === 'canceled') {
      const existing = sub.trialEndAt ?? new Date();
      return { lockoutAt: existing };
    }
    const result = await this.stripeService.cancelSubscriptionAtPeriodEnd(sub.stripeSubscriptionId);
    if (!result) {
      throw new BadRequestException('Could not cancel subscription with Stripe');
    }
    await this.prisma.subscription.update({
      where: { userId },
      data: {
        status: 'canceled',
        trialEndAt: result.periodEnd,
      },
    });
    return { lockoutAt: result.periodEnd };
  }

  async recordFromCheckout(params: {
    clerkUserId: string;
    stripeSubscriptionId?: string;
    stripeCustomerId?: string;
    status?: string;
    trialEndAt?: Date | null;
  }): Promise<void> {
    const { clerkUserId, stripeSubscriptionId, stripeCustomerId, status = 'trialing', trialEndAt } = params;
    const user = await this.prisma.user.findUnique({
      where: { clerkId: clerkUserId },
    });
    if (!user) return;
    await this.prisma.subscription.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        stripeSubscriptionId: stripeSubscriptionId ?? null,
        stripeCustomerId: stripeCustomerId ?? null,
        status,
        trialEndAt: trialEndAt ?? null,
      },
      update: {
        stripeSubscriptionId: stripeSubscriptionId ?? undefined,
        stripeCustomerId: stripeCustomerId ?? undefined,
        status,
        trialEndAt: trialEndAt ?? undefined,
      },
    });

    // After payment: limited initial sync can have run while unpaid; full catalog only after subscription.
    try {
      await this.amazonSyncService.enqueueAmazonSyncAfterSubscription(user.id);
    } catch (e) {
      this.logger.warn(
        `recordFromCheckout: failed to enqueue Amazon sync for userId=${user.id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
