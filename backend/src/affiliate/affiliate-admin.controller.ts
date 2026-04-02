import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  ServiceUnavailableException,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AffiliateService } from './affiliate.service';
import type { AffiliateCommissionStatus } from '@prisma/client';

@Controller('affiliates/admin')
@UsePipes(
  new ValidationPipe({
    whitelist: false,
    forbidNonWhitelisted: false,
    transform: true,
  }),
)
export class AffiliateAdminController {
  constructor(
    private readonly affiliateService: AffiliateService,
    private readonly config: ConfigService,
  ) {}

  private assertAdminSecret(raw: string | string[] | undefined): void {
    const expected = this.config.get<string>('AFFILIATE_ADMIN_SECRET')?.trim();
    if (!expected) {
      throw new ServiceUnavailableException(
        'AFFILIATE_ADMIN_SECRET is not configured',
      );
    }
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (!provided || provided !== expected) {
      throw new UnauthorizedException('Invalid admin secret');
    }
  }

  @Post('affiliates')
  async createAffiliate(
    @Headers('x-affiliate-admin-secret') secret: string | undefined,
    @Body()
    body: {
      referralCode: string;
      name?: string;
      email?: string;
      commissionRate?: number;
      active?: boolean;
    },
  ) {
    this.assertAdminSecret(secret);
    return this.affiliateService.createAffiliate(body);
  }

  @Get('affiliates')
  async listAffiliates(@Headers('x-affiliate-admin-secret') secret: string | undefined) {
    this.assertAdminSecret(secret);
    return this.affiliateService.listAffiliates();
  }

  @Get('commissions')
  async listCommissions(
    @Headers('x-affiliate-admin-secret') secret: string | undefined,
    @Query('affiliateId') affiliateId?: string,
    @Query('status') status?: AffiliateCommissionStatus,
  ) {
    this.assertAdminSecret(secret);
    return this.affiliateService.listCommissions({
      affiliateId: affiliateId?.trim() || undefined,
      status: status === 'pending' || status === 'paid' ? status : undefined,
    });
  }

  @Patch('commissions/:id/mark-paid')
  async markPaid(
    @Headers('x-affiliate-admin-secret') secret: string | undefined,
    @Param('id') id: string,
  ) {
    this.assertAdminSecret(secret);
    await this.affiliateService.markCommissionPaid(id);
    return { ok: true };
  }
}
