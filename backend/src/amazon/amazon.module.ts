import { Module } from '@nestjs/common';
import { AmazonController } from './amazon.controller';
import { AmazonService } from './amazon.service';
import { AmazonSpApiClient } from './sp-api.client';

@Module({
  controllers: [AmazonController],
  providers: [AmazonService, AmazonSpApiClient],
  exports: [AmazonSpApiClient],
})
export class AmazonModule {}




