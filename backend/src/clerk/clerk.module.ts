import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClerkService } from './clerk.service';

@Module({
  imports: [ConfigModule],
  providers: [ClerkService],
  exports: [ClerkService],
})
export class ClerkModule {}
