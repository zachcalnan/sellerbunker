import { Module, forwardRef } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ClerkModule } from '../clerk/clerk.module';
import { AffiliateModule } from '../affiliate/affiliate.module';

@Module({
  imports: [PrismaModule, forwardRef(() => ClerkModule), AffiliateModule],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
