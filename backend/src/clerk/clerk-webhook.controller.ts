import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SubscriptionService } from '../subscription/subscription.service';

/**
 * Called by the frontend when Clerk sends a user.deleted webhook.
 * Deletes the user's subscription and clears clerkId so re-sign-up goes through payment again.
 */
@Controller('clerk')
export class ClerkWebhookController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly configService: ConfigService,
  ) {}

  @Post('user-deleted')
  async onUserDeleted(
    @Body('clerkId') clerkId: string | undefined,
    @Headers('x-webhook-secret') secret: string | undefined,
  ) {
    const expected = this.configService.get<string>('CLERK_WEBHOOK_SECRET');
    if (!expected || secret !== expected) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
    if (!clerkId || typeof clerkId !== 'string' || !clerkId.trim()) {
      return { ok: false, message: 'clerkId required' };
    }
    await this.subscriptionService.deleteByClerkId(clerkId.trim());
    return { ok: true };
  }
}
