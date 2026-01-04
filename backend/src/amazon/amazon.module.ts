import { Module } from '@nestjs/common';
import { AmazonController } from './amazon.controller';
import { AmazonService } from './amazon.service';
import { AmazonSpApiClient } from './sp-api.client';
import { PrismaModule } from '../prisma/prisma.module';
import { ClerkModule } from '../clerk/clerk.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [PrismaModule, ClerkModule, UsersModule],
  controllers: [AmazonController],
  providers: [AmazonService, AmazonSpApiClient],
  exports: [AmazonSpApiClient],
})
export class AmazonModule {}

