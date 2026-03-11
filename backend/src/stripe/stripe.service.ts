import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

export type CheckoutSessionData = {
  clientReferenceId: string | null;
  subscriptionId: string | undefined;
  customerId: string | undefined;
  status: string;
  trialEndAt: Date | null;
};

@Injectable()
export class StripeService {
  private stripe: Stripe | null = null;

  constructor(private readonly configService: ConfigService) {
    const secret = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (secret) {
      this.stripe = new Stripe(secret, { apiVersion: '2026-02-25.clover' });
    }
  }

  async retrieveCheckoutSession(sessionId: string): Promise<CheckoutSessionData | null> {
    if (!this.stripe) return null;
    try {
      const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['subscription'],
      });
      const subId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id ?? undefined;
      let trialEndAt: Date | null = null;
      if (subId) {
        try {
          const sub = await this.stripe.subscriptions.retrieve(subId);
          if (typeof sub.trial_end === 'number') trialEndAt = new Date(sub.trial_end * 1000);
        } catch {
          // ignore
        }
      }
      return {
        clientReferenceId: session.client_reference_id as string | null,
        subscriptionId: subId,
        customerId:
          typeof session.customer === 'string'
            ? session.customer
            : session.customer && typeof session.customer === 'object' && 'id' in session.customer
              ? (session.customer as { id: string }).id
              : undefined,
        status: 'trialing',
        trialEndAt,
      };
    } catch {
      return null;
    }
  }

  /**
   * Cancel the subscription at the end of the current billing period (or trial end).
   * Returns the date when access will end so we can store it in our DB.
   */
  async cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<{ periodEnd: Date } | null> {
    if (!this.stripe) return null;
    try {
      const sub = await this.stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
      }) as { current_period_end?: number; trial_end?: number };
      const periodEndSec = sub.current_period_end;
      const trialEndSec = sub.trial_end;
      const end =
        typeof periodEndSec === 'number'
          ? new Date(periodEndSec * 1000)
          : typeof trialEndSec === 'number'
            ? new Date(trialEndSec * 1000)
            : new Date();
      return { periodEnd: end };
    } catch {
      return null;
    }
  }
}
