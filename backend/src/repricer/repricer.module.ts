import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AmazonModule } from '../amazon/amazon.module';
import { ClerkModule } from '../clerk/clerk.module';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { RepricerController } from './repricer.controller';
import { RepricerService } from './repricer.service';
import { RepricerPasswordGuard } from './repricer-password.guard';
import { RepricerProcessor } from './repricer.processor';
import { RepricerSyncService } from './repricer-sync.service';

@Module({
  imports: [
    PrismaModule,
    UsersModule,
    ClerkModule,
    forwardRef(() => AmazonModule),
    BullModule.registerQueue({ name: 'repricer' }),
  ],
  controllers: [RepricerController],
  providers: [RepricerService, RepricerPasswordGuard, RepricerSyncService, RepricerProcessor],
  exports: [RepricerService],
})
export class RepricerModule {}

