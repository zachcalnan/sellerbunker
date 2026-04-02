import { Body, Controller, Headers, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { SubscriptionService } from '../subscription/subscription.service';
import { AffiliateService } from '../affiliate/affiliate.service';

@Controller('stripe')
export class StripeWebhookController {
  private stripe: Stripe | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly subscriptionService: SubscriptionService,
    private readonly affiliateService: AffiliateService,
  ) {
    const secret = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (secret) {
      this.stripe = new Stripe(secret, { apiVersion: '2026-02-25.clover' });
    }
  }

  @Post('webhook')
  async webhook(
    @Headers('stripe-signature') signature: string | undefined,
    @Req() req: { rawBody?: Buffer },
  ) {
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!this.stripe || !webhookSecret || !signature) {
      return { received: true };
    }
    const rawBody = req.rawBody;
    if (!rawBody) {
      return { received: true };
    }
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody as Buffer,
        signature,
        webhookSecret,
      );
    } catch (err) {
      return { received: false, error: 'Invalid signature' };
    }
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const clerkUserId = session.client_reference_id as string | null;
      if (clerkUserId) {
        const subId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id ?? undefined;
        let trialEndAt: Date | null = null;
        if (this.stripe && subId) {
          try {
            const sub = await this.stripe.subscriptions.retrieve(subId);
            const trialEnd = sub.trial_end;
            if (typeof trialEnd === 'number') trialEndAt = new Date(trialEnd * 1000);
          } catch {
            // ignore
          }
        }
        await this.subscriptionService.recordFromCheckout({
          clerkUserId,
          stripeSubscriptionId: subId,
          stripeCustomerId:
            typeof session.customer === 'string'
              ? session.customer
              : session.customer && typeof session.customer === 'object' && 'id' in session.customer
                ? (session.customer as { id: string }).id
                : undefined,
          status: 'trialing',
          trialEndAt,
        });
      }
      try {
        await this.affiliateService.handleCheckoutSessionCompleted(
          event.id,
          event.data.object as Stripe.Checkout.Session,
        );
      } catch {
        // non-fatal
      }
    }
    if (event.type === 'invoice.paid') {
      try {
        await this.affiliateService.handleInvoicePaid(
          event.id,
          event.data.object as Stripe.Invoice,
        );
      } catch {
        // non-fatal
      }
    }
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      await this.subscriptionService.syncFromStripeSubscription(
        event.data.object as Stripe.Subscription,
      );
    }
    return { received: true };
  }
}
