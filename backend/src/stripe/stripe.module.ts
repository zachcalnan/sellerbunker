import { Module, forwardRef } from '@nestjs/common';
import { ClerkModule } from '../clerk/clerk.module';
import { UsersModule } from '../users/users.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeConfirmController } from './stripe-confirm.controller';
import { StripeService } from './stripe.service';

@Module({
  imports: [
    forwardRef(() => SubscriptionModule),
    forwardRef(() => ClerkModule),
    forwardRef(() => UsersModule),
    AffiliateModule,
  ],
  controllers: [StripeWebhookController, StripeConfirmController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
