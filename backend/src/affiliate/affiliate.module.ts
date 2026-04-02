import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { AffiliateService } from './affiliate.service';
import { AffiliateAdminController } from './affiliate-admin.controller';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [AffiliateAdminController],
  providers: [AffiliateService],
  exports: [AffiliateService],
})
export class AffiliateModule {}
