import { Module } from '@nestjs/common';
import { PushService } from './push.service';
import { PushController } from './push.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { ClerkModule } from '../clerk/clerk.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [PrismaModule, RedisModule, ClerkModule, UsersModule],
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
