import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SubscriptionModule } from '../subscription/subscription.module';
import { ClerkWebhookController } from './clerk-webhook.controller';
import { ClerkService } from './clerk.service';

@Module({
  imports: [ConfigModule, forwardRef(() => SubscriptionModule)],
  controllers: [ClerkWebhookController],
  providers: [ClerkService],
  exports: [ClerkService],
})
export class ClerkModule {}
