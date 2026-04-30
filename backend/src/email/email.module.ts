import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from './email.service';
import { EmailAdminController } from './email-admin.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [ConfigModule, UsersModule],
  providers: [EmailService],
  controllers: [EmailAdminController],
  exports: [EmailService],
})
export class EmailModule {}

