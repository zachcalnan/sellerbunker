import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AmazonController } from './amazon.controller';
import { AmazonService } from './amazon.service';
import { AmazonSpApiClient } from './sp-api.client';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { ClerkModule } from '../clerk/clerk.module';
import { UsersModule } from '../users/users.module';
import { AmazonSyncService } from './amazon-sync.service';
import { AmazonSyncProcessor } from './amazon-sync.processor';
import { AmazonOrdersHotSyncProcessor } from './amazon-orders-hot-sync.processor';
import { AmazonExtendedHistoryBootstrap } from './amazon-extended-history.bootstrap';
import { AmazonOrderLineFeeBackfillBootstrap } from './amazon-order-line-fee-backfill.bootstrap';
import { RepricerModule } from '../repricer/repricer.module';
import { PushModule } from '../push/push.module';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    ClerkModule,
    UsersModule,
    forwardRef(() => RepricerModule),
    PushModule,
    BullModule.registerQueue(
      { name: 'amazon-sync' },
      // Separate queue so listing-price / fee jobs cannot starve sale push.
      { name: 'amazon-orders-hot' },
    ),
  ],
  controllers: [AmazonController],
  providers: [
    AmazonService,
    AmazonSpApiClient,
    AmazonSyncService,
    AmazonSyncProcessor,
    AmazonOrdersHotSyncProcessor,
    AmazonExtendedHistoryBootstrap,
    AmazonOrderLineFeeBackfillBootstrap,
  ],
  exports: [AmazonService, AmazonSpApiClient, AmazonSyncService],
})
export class AmazonModule {}
