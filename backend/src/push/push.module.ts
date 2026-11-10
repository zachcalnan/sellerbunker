import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PushService } from './push.service';
import { PushController } from './push.controller';
import { PushAlertService, PUSH_ALERTS_QUEUE } from './push-alert.service';
import { PushAlertProcessor } from './push-alert.processor';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { ClerkModule } from '../clerk/clerk.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    ClerkModule,
    UsersModule,
    BullModule.registerQueue({ name: PUSH_ALERTS_QUEUE }),
  ],
  controllers: [PushController],
  providers: [PushService, PushAlertService, PushAlertProcessor],
  exports: [PushService, PushAlertService],
})
export class PushModule {}
