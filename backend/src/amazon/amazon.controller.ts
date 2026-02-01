import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
  getAccountSummary(@Req() req: { user: { orgId: string; userId: string } }) {
    return this.amazonService.getAccountSummary(req.user.orgId, req.user.userId);
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
    @Req() req: { user: { orgId: string; userId: string } },
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    return this.amazonService.getSalesTimeSeries(
      req.user.orgId,
      { start, end },
      req.user.userId,
    );
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

  /**
   * Dev-only: set totalProfit on an order, then recompute KPIs.
   * Use to test the profit pipeline. Example:
   *   PATCH /api/amazon/dev/orders/123-456/profit
   *   Body: { "totalProfit": 12.50 }
   */
  @UseGuards(ClerkAuthGuard)
  @Patch('dev/orders/:orderId/profit')
  async devSetOrderProfit(
    @Req() req: { user: { userId: string } },
    @Param('orderId') orderId: string,
    @Body() body: { totalProfit: number },
  ) {
    const totalProfit = Number(body?.totalProfit);
    if (Number.isNaN(totalProfit) || totalProfit < 0) {
      throw new BadRequestException(
        'totalProfit must be a non-negative number',
      );
    }
    return this.amazonService.setOrderProfit(
      req.user.userId,
      orderId,
      totalProfit,
    );
  }

  /**
   * Dev-only: backfill OrderItem rows from existing Order rows.
   * This does NOT rely on ordersLastSyncedAt and is safe to run repeatedly.
   */
  @UseGuards(ClerkAuthGuard)
  @Post('dev/backfill-order-items')
  async devBackfillOrderItems(
    @Req() req: { user: { userId: string } },
    @Query('days') days?: string,
  ) {
    const n = Number(days ?? 30);
    const safeDays = Number.isFinite(n) ? Math.max(1, Math.min(365, n)) : 30;
    return this.amazonService.backfillOrderItems(req.user.userId, safeDays);
  }

  /**
   * Dev-only: backfill missing Product.title using Catalog Items API (by ASIN).
   * Example:
   * POST /api/amazon/dev/backfill-product-titles?limit=50
   */
  @UseGuards(ClerkAuthGuard)
  @Post('dev/backfill-product-titles')
  async devBackfillProductTitles(
    @Req() req: { user: { orgId: string; userId: string } },
    @Query('limit') limit?: string,
  ) {
    const n = Number(limit ?? 50);
    const safeLimit = Number.isFinite(n) ? Math.max(1, Math.min(200, n)) : 50;
    return this.amazonService.backfillProductTitles(
      req.user.orgId,
      safeLimit,
      req.user.userId,
    );
  }

  /**
   * Dev-only: same as POST, but allowed as GET for convenience.
   * Example:
   * GET /api/amazon/dev/backfill-product-titles?limit=50
   */
  @UseGuards(ClerkAuthGuard)
  @Get('dev/backfill-product-titles')
  async devBackfillProductTitlesGet(
    @Req() req: { user: { orgId: string; userId: string } },
    @Query('limit') limit?: string,
  ) {
    const n = Number(limit ?? 50);
    const safeLimit = Number.isFinite(n) ? Math.max(1, Math.min(200, n)) : 50;
    return this.amazonService.backfillProductTitles(
      req.user.orgId,
      safeLimit,
      req.user.userId,
    );
  }

  /**
   * Dev-only: return the internal user mapping for the current Clerk token.
   * Useful for debugging "multiple userId values" in data tables.
   */
  @UseGuards(ClerkAuthGuard)
  @Get('dev/whoami')
  async devWhoAmI(@Req() req: { user: { userId: string; email: string } }) {
    return req.user;
  }

  /**
   * Dev-only: inspect raw Catalog Items response for an ASIN.
   * Example:
   * GET /api/amazon/dev/catalog-item?asin=B0B7NSZTHX&marketplaceId=A1F83G8C2ARO7P
   */
  @UseGuards(ClerkAuthGuard)
  @Get('dev/catalog-item')
  async devCatalogItem(
    @Req() req: { user: { orgId: string; userId: string } },
    @Query('asin') asin?: string,
    @Query('marketplaceId') marketplaceId?: string,
  ) {
    if (!asin || !marketplaceId) {
      throw new BadRequestException('asin and marketplaceId are required');
    }
    return this.amazonService.devGetCatalogItem(
      req.user.orgId,
      req.user.userId,
      asin,
      marketplaceId,
    );
  }

  /**
   * Return the most profitable products for the authenticated user over the last 30 days.
   * Uses OrderItem rows for full accuracy (multi-SKU orders included).
   *
   * Example: GET /api/amazon/products/top-profitable?limit=10
   */
  @UseGuards(ClerkAuthGuard)
  @Get('products/top-profitable')
  async topProfitableProducts(
    @Req() req: { user: { orgId: string } },
    @Query('limit') limit?: string,
  ) {
    const n = Number(limit ?? 10);
    const safeLimit = Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 10;
    return this.amazonService.getTopProfitableProducts(
      req.user.orgId,
      safeLimit,
    );
  }

  /**
   * List products (SKUs) for the authenticated user.
   * Used for managing per-SKU Cost of Goods (COGS).
   *
   * Example: GET /api/amazon/products
   */
  @UseGuards(ClerkAuthGuard)
  @Get('products')
  async listProducts(@Req() req: { user: { orgId: string } }) {
    return this.amazonService.listProducts(req.user.orgId);
  }

  /**
   * Update Cost of Goods (per-unit) for a product.
   *
   * Example:
   * PATCH /api/amazon/products/:productId/cost-of-goods
   * Body: { "costOfGoods": 3.25 }  // or null to clear
   */
  @UseGuards(ClerkAuthGuard)
  @Patch('products/:productId/cost-of-goods')
  async updateCostOfGoods(
    @Req() req: { user: { orgId: string } },
    @Param('productId') productId: string,
    @Body() body: { costOfGoods: number | null },
  ) {
    const raw = (body as any)?.costOfGoods;
    const costOfGoods = raw === null || raw === undefined ? null : Number(raw);
    if (costOfGoods != null && (Number.isNaN(costOfGoods) || costOfGoods < 0)) {
      throw new BadRequestException(
        'costOfGoods must be a non-negative number or null',
      );
    }
    return this.amazonService.updateProductCostOfGoods(
      req.user.orgId,
      productId,
      costOfGoods,
    );
  }

  /**
   * Inventory (FBA): list current inventory snapshot for known products.
   *
   * Example: GET /api/amazon/inventory
   */
  @UseGuards(ClerkAuthGuard)
  @Get('inventory')
  async listInventory(@Req() req: { user: { orgId: string } }) {
    return this.amazonService.listInventory(req.user.orgId);
  }

  /**
   * Inventory (FBA): sync inventory summaries now.
   *
   * Example: POST /api/amazon/inventory/sync
   */
  @UseGuards(ClerkAuthGuard)
  @Post('inventory/sync')
  async syncInventory(@Req() req: { user: { orgId: string; userId: string } }) {
    return this.amazonService.syncFbaInventory(req.user.orgId, req.user.userId);
  }

  /**
   * Dev-only: show which Amazon sellerAccount is being used for this org,
   * plus whether SP-API is configured for sandbox.
   *
   * Example: GET /api/amazon/dev/connection
   */
  @UseGuards(ClerkAuthGuard)
  @Get('dev/connection')
  async devAmazonConnection(@Req() req: { user: { orgId: string; userId: string } }) {
    return {
      spapi: (this.amazonService as any).spApiClient.getDebugConfig?.() ?? null,
      amazonAppId: this.configService.get<string>('AMAZON_APP_ID') ?? null,
      amazonRedirectUri: this.configService.get<string>('AMAZON_REDIRECT_URI') ?? null,
      connection: await this.amazonService.getAmazonConnectionDebug(
        req.user.orgId,
        req.user.userId,
      ),
    };
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
