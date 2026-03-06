import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SubscriptionService {
  constructor(private readonly prisma: PrismaService) {}

  /** True if user has an active/trialing subscription, or canceled but still within trial end. */
  async hasAccess(userId: string): Promise<boolean> {
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
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
    });
    if (!sub) return null;
    if (await this.hasAccess(userId)) return 'Basic plan';
    return null;
  }

  /** When the user will lose access (trial end or period end). Used to show "You will be locked out as of [date]". */
  async getLockoutAt(userId: string): Promise<Date | null> {
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
    });
    if (!sub || !sub.trialEndAt) return null;
    if (sub.status === 'trialing' || sub.status === 'canceled') return sub.trialEndAt;
    return null;
  }

  /** Sync our subscription record from Stripe subscription (e.g. when canceled or payment fails). */
  async syncFromStripeSubscription(stripeSub: { id: string; status: string; trial_end?: number | null }): Promise<void> {
    const existing = await this.prisma.subscription.findFirst({
      where: { stripeSubscriptionId: stripeSub.id },
    });
    if (!existing) return;
    const trialEndAt =
      stripeSub.trial_end != null ? new Date(stripeSub.trial_end * 1000) : null;
    await this.prisma.subscription.update({
      where: { id: existing.id },
      data: {
        status: stripeSub.status,
        trialEndAt: trialEndAt ?? undefined,
      },
    });
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
  }
}
