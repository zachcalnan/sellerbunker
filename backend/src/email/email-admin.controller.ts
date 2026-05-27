import {
  Body,
  Controller,
  Headers,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsNotEmpty, IsString } from 'class-validator';
import { EmailService } from './email.service';
import { UsersService } from '../users/users.service';

class SendBlastDto {
  @IsString()
  @IsNotEmpty()
  subject: string;

  @IsString()
  @IsNotEmpty()
  content: string; // HTML
}

@Controller('email/admin')
@UsePipes(
  new ValidationPipe({
    whitelist: false,
    forbidNonWhitelisted: false,
    transform: true,
  }),
)
export class EmailAdminController {
  constructor(
    private readonly emailService: EmailService,
    private readonly usersService: UsersService,
    private readonly config: ConfigService,
  ) {}

  private assertAdminSecret(raw: string | string[] | undefined): void {
    const expected = this.config.get<string>('EMAIL_ADMIN_SECRET')?.trim();
    if (!expected) {
      throw new ServiceUnavailableException('EMAIL_ADMIN_SECRET is not configured');
    }
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (!provided || provided !== expected) {
      throw new UnauthorizedException('Invalid admin secret');
    }
  }

  @Post('send-blast')
  async sendBlast(
    @Headers('x-email-admin-secret') secret: string | undefined,
    @Body() dto: SendBlastDto,
  ) {
    this.assertAdminSecret(secret);

    const emails = await this.usersService.listAllUserEmails();

    await this.emailService.sendBulkEmail(emails, dto.subject, dto.content);
    return { ok: true, sent: emails.length };
  }

  /** Backfill Brevo list (BREVO_SIGNUP_LIST_ID) for users missing brevoSyncedAt. */
  @Post('sync-brevo-contacts')
  async syncBrevoContacts(
    @Headers('x-email-admin-secret') secret: string | undefined,
  ) {
    this.assertAdminSecret(secret);
    const result = await this.usersService.syncPendingBrevoContacts({
      limit: 5000,
    });
    return { ok: true, ...result };
  }
}

