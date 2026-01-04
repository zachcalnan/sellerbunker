import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AmazonService } from './amazon.service';
import { LinkAmazonAccountDto } from './dto/link-amazon-account.dto';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';

@UseGuards(ClerkAuthGuard)
@Controller('amazon')
export class AmazonController {
  constructor(private readonly amazonService: AmazonService) {}

  /**
   * Starts the Amazon Seller Central consent flow.
   * Example: GET /api/amazon/connect?region=EU
   */
  @Get('connect')
  async connectAmazon(
    @Req() req: { user: { userId: string } },
    @Query('region') region?: string,
  ) {
    const redirectUrl = await this.amazonService.getAmazonConnectUrl(
      req.user.userId,
      region ?? 'EU',
    );
    return { url: redirectUrl };
  }

  /**
   * OAuth callback from Amazon after the seller grants consent.
   * Amazon will redirect to this URL with spapi_oauth_code, selling_partner_id, and state.
   * This route is intentionally NOT guarded with ClerkAuthGuard; identity comes from the encoded state.
   */
  @Get('oauth/callback')
  async oauthCallback(
    @Query('spapi_oauth_code') code: string,
    @Query('selling_partner_id') sellingPartnerId: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    await this.amazonService.handleOauthCallback({
      code,
      sellingPartnerId,
      state,
    });

    return res.send(
      'Your Amazon account is now linked. You can close this tab and return to the dashboard.',
    );
  }

  @Post('link')
  linkAmazonAccount(
    @Req() req: { user: { userId: string } },
    @Body() dto: LinkAmazonAccountDto,
  ) {
    return this.amazonService.linkAmazonAccount(req.user.userId, dto);
  }

  @Get('account/summary')
  getAccountSummary(@Req() req: { user: { userId: string } }) {
    return this.amazonService.getAccountSummary(req.user.userId);
  }

  @Get('sandbox/marketplaces')
  async getSandboxMarketplaces(@Req() req: { user: { userId: string } }) {
    // Example endpoint that proxies the SP-API Sellers "getMarketplaceParticipations"
    // call (currently returns a static payload from AmazonSpApiClient).
    return this.amazonService.getSandboxMarketplaceParticipations(
      req.user.userId,
    );
  }

  // NOTE: sandbox/orders is temporarily disabled until wired for
  // per-user credentials. You can re-enable it later if needed.
}