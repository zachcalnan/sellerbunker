import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from './email.service';
import { EmailAdminController } from './email-admin.controller';
import { BrevoContactSyncService } from './brevo-contact-sync.service';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [ConfigModule, forwardRef(() => UsersModule)],
  providers: [EmailService, BrevoContactSyncService],
  controllers: [EmailAdminController],
  exports: [EmailService],
})
export class EmailModule {}

