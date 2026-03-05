import { Body, Controller, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { SubscriptionService } from '../subscription/subscription.service';
import { StripeService } from './stripe.service';

@Controller('stripe')
export class StripeConfirmController {
  constructor(
    private readonly stripeService: StripeService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  /**
   * Confirm a Stripe checkout session and record the subscription.
   * Used when the user returns from Stripe (success_url) so we don't rely on the webhook
   * (e.g. in local dev the webhook may not be received).
   */
  @Post('confirm-checkout')
  @UseGuards(ClerkAuthGuard)
  async confirmCheckout(
    @Body('sessionId') sessionId: string | undefined,
    @Req() req: { user: { userId: string; clerkId?: string } },
  ) {
    const clerkId = req.user.clerkId;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new UnauthorizedException('sessionId required');
    }
    if (!clerkId) {
      throw new UnauthorizedException('User has no clerk id');
    }
    const data = await this.stripeService.retrieveCheckoutSession(sessionId.trim());
    if (!data || data.clientReferenceId !== clerkId) {
      throw new UnauthorizedException('Invalid or mismatched checkout session');
    }
    await this.subscriptionService.recordFromCheckout({
      clerkUserId: clerkId,
      stripeSubscriptionId: data.subscriptionId,
      stripeCustomerId: data.customerId,
      status: data.status,
      trialEndAt: data.trialEndAt,
    });
    return { ok: true };
  }
}
