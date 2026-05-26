import { Module, forwardRef } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ClerkModule } from '../clerk/clerk.module';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => ClerkModule),
    AffiliateModule,
    forwardRef(() => EmailModule),
  ],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
