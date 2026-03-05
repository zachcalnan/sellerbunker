import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ClerkModule } from '../clerk/clerk.module';
import { UsersModule } from '../users/users.module';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';

@Module({
  imports: [PrismaModule, ClerkModule, UsersModule],
  controllers: [SubscriptionController],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
