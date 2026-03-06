import { Module } from '@nestjs/common';
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

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    ClerkModule,
    UsersModule,
    BullModule.registerQueue({
      name: 'amazon-sync',
    }),
  ],
  controllers: [AmazonController],
  providers: [
    AmazonService,
    AmazonSpApiClient,
    AmazonSyncService,
    AmazonSyncProcessor,
  ],
  exports: [AmazonSpApiClient, AmazonSyncService],
})
export class AmazonModule {}
