import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { SubscriptionService } from './subscription.service';

@Controller('subscription')
@UseGuards(ClerkAuthGuard)
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get('status')
  async status(@Req() req: { user: { userId: string } }) {
    const hasAccess = await this.subscriptionService.hasAccess(req.user.userId);
    const plan = await this.subscriptionService.getPlanName(req.user.userId);
    const lockoutAt = await this.subscriptionService.getLockoutAt(req.user.userId);
    return {
      hasAccess,
      plan,
      lockoutAt: lockoutAt ? lockoutAt.toISOString() : null,
    };
  }
}
