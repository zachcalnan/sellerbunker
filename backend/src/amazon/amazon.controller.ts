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
import { ConfigService } from '@nestjs/config';
import { AmazonService } from './amazon.service';
import { LinkAmazonAccountDto } from './dto/link-amazon-account.dto';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { AmazonSyncService } from './amazon-sync.service';

@Controller('amazon')
export class AmazonController {
  constructor(
    private readonly amazonService: AmazonService,
    private readonly amazonSyncService: AmazonSyncService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Starts the Amazon Seller Central consent flow.
   * Example: GET /api/amazon/connect?region=EU
   */
  @UseGuards(ClerkAuthGuard)
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
    console.log('CALLBACK ROUTE HIT', { code, sellingPartnerId, state });

    try {
      await this.amazonService.handleOauthCallback({
        code,
        sellingPartnerId,
        state,
      });

      // Kick off an initial background sync for this user so their dashboard
      // can start populating without blocking the OAuth callback response.
      try {
        const decoded = Buffer.from(state, 'base64url').toString('utf8');
        const { userId } = JSON.parse(decoded) as { userId?: string };
        if (userId) {
          console.log(
            '[AmazonController] Enqueuing initial full-sync after OAuth',
            { userId },
          );
          await this.amazonSyncService.enqueueFullSync(userId);
        }
      } catch (syncErr) {
        // Non-fatal: logging is enough, the link itself has already succeeded.
        console.error('Failed to enqueue initial Amazon sync', syncErr);
      }

      const frontendUrl =
        this.configService.get<string>('FRONTEND_URL') ||
        'http://localhost:3000';

      return res.redirect(frontendUrl);
    } catch (e) {
      console.error('OAUTH CALLBACK ERROR:', e);
      return res.status(500).send('OAuth callback failed');
    }
  }

  @UseGuards(ClerkAuthGuard)
  @Post('link')
  linkAmazonAccount(
    @Req() req: { user: { userId: string } },
    @Body() dto: LinkAmazonAccountDto,
  ) {
    return this.amazonService.linkAmazonAccount(req.user.userId, dto);
  }

  @UseGuards(ClerkAuthGuard)
  @Get('account/summary')
  getAccountSummary(@Req() req: { user: { userId: string } }) {
    return this.amazonService.getAccountSummary(req.user.userId);
  }

  /**
   * Manually trigger a background Amazon full-sync for the authenticated user.
   * Example: POST /api/amazon/sync
   *
   * Security:
   * - Protected by ClerkAuthGuard so only logged-in users can call it.
   * - Uses the userId from the Clerk session; the client cannot choose
   *   an arbitrary userId to sync.
   */
  @UseGuards(ClerkAuthGuard)
  @Post('sync')
  async syncNow(@Req() req: { user: { userId: string } }) {
    await this.amazonSyncService.enqueueFullSync(req.user.userId);
    return { status: 'queued' };
  }

  @UseGuards(ClerkAuthGuard)
  @Get('sales/timeseries')
  getSalesTimeSeries(
    @Req() req: { user: { userId: string } },
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    return this.amazonService.getSalesTimeSeries(req.user.userId, {
      start,
      end,
    });
  }

  /**
   * Dev-only helper: recompute the last 30 days of daily KPI aggregates
   * for the authenticated user from existing Order rows.
   */
  @UseGuards(ClerkAuthGuard)
  @Post('dev/recompute-kpi')
  async devRecomputeKpi(@Req() req: { user: { userId: string } }) {
    await this.amazonService.recomputeDailyKpiSummary(req.user.userId);
    return { status: 'recomputed' };
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