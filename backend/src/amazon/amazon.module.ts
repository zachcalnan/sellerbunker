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
import { GoogleSheetsClient } from './google-sheets.client';
import { PurchaseSheetOrderWriteService } from './purchase-sheet-order-write.service';
import { PurchaseSheetCheckoutAddressService } from './purchase-sheet-checkout-address.service';
import { PurchaseScreenshotExtractService } from './purchase-screenshot-extract.service';
import { ProductFinderService } from './product-finder.service';
import { PrepCenterInboundSheetService } from './prep-center-inbound-sheet.service';
import { PushModule } from '../push/push.module';
import { KeepaClient } from './keepa.client';
import { DealCheckService } from './deal-check.service';

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
    GoogleSheetsClient,
    PurchaseSheetOrderWriteService,
    PurchaseSheetCheckoutAddressService,
    PurchaseScreenshotExtractService,
    ProductFinderService,
    PrepCenterInboundSheetService,
    KeepaClient,
    DealCheckService,
  ],
  exports: [
    AmazonService,
    AmazonSpApiClient,
    AmazonSyncService,
    PurchaseSheetOrderWriteService,
    PurchaseSheetCheckoutAddressService,
    PrepCenterInboundSheetService,
    DealCheckService,
  ],
})
export class AmazonModule {}
