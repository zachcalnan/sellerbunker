import { Module } from '@nestjs/common';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AmazonModule } from '../amazon/amazon.module';
import { ClerkModule } from '../clerk/clerk.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [PrismaModule, AmazonModule, ClerkModule, UsersModule],
  controllers: [MarketplaceController],
  providers: [MarketplaceService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
