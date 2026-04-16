import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AmazonService } from './amazon.service';
import { LinkAmazonAccountDto } from './dto/link-amazon-account.dto';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { UpdatePurchaseDto } from './dto/update-purchase.dto';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { AmazonSyncService } from './amazon-sync.service';
import { AmazonSyncProcessor } from './amazon-sync.processor';

@Controller('amazon')
export class AmazonController {
  private readonly logger = new Logger(AmazonController.name);
  constructor(
    private readonly amazonService: AmazonService,
    private readonly amazonSyncService: AmazonSyncService,
    private readonly amazonSyncProcessor: AmazonSyncProcessor,
    private readonly configService: ConfigService,
  ) {}

  @Get('ping')
ping() {
  return { ok: true };
}

  /**
   * Starts the Amazon Seller Central consent flow.
   * Example: GET /api/amazon/connect?region=EU
   */
  @UseGuards(ClerkAuthGuard)
  @Get('connect')
  async connectAmazon(
    @Req() req: { user: { userId: string } },
    @Query('region') region?: string,
    @Query('returnOrigin') returnOrigin?: string,
  ) {
    try {
      const redirectUrl = await this.amazonService.getAmazonConnectUrl(
        req.user.userId,
        region ?? 'EU',
        returnOrigin?.trim() || undefined,
      );
      return { url: redirectUrl };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Amazon connect failed';
      this.logger.warn(`getAmazonConnectUrl failed: ${message}`);
      throw new ServiceUnavailableException(message);
    }
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
    this.logger.log(
      `OAuth callback received (sellingPartnerId=${sellingPartnerId})`,
    );

    try {
      await this.amazonService.handleOauthCallback({
        code,
        sellingPartnerId,
        state,
      });

      const decoded = Buffer.from(state, 'base64url').toString('utf8');
      const stateData = JSON.parse(decoded) as { userId?: string; returnOrigin?: string };

      // Kick off an initial background sync for this user so their dashboard
      // can start populating without blocking the OAuth callback response.
      try {
        if (stateData.userId) {
          this.logger.log(
            `[AmazonController] Enqueuing initial full-sync after OAuth (userId=${stateData.userId}, jobId=full-sync-${stateData.userId})`,
          );
          await this.amazonSyncService.enqueueFullSync(stateData.userId);
        } else {
          this.logger.warn('[AmazonController] OAuth state missing userId – cannot enqueue full-sync');
        }
      } catch (syncErr) {
        // Non-fatal: logging is enough, the link itself has already succeeded.
        const msg = syncErr instanceof Error ? syncErr.message : String(syncErr);
        this.logger.warn(`Failed to enqueue initial Amazon sync: ${msg}. User can trigger sync from dashboard.`);
      }

      const defaultFrontend =
        this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
      const frontendBase = this.amazonService.getRedirectOriginAfterOAuth(
        stateData.returnOrigin,
        defaultFrontend,
      );
      let dashboardUrl =
        frontendBase.replace(/\/$/, '') + '/dashboard?amazon_connected=1';
      // Always pass the API base that ran this callback when we can derive it, so the browser polls
      // the same Redis/queue as the worker (fixes local-vs-prod mismatch and any client that omits returnOrigin).
      const reqForApi = res.req as {
        get?(name: string): string | undefined;
        protocol?: string;
      };
      const publicApiUrl =
        this.configService.get<string>('PUBLIC_API_URL') ||
        (() => {
          const u = this.configService.get<string>('AMAZON_REDIRECT_URI');
          if (u) {
            try {
              const url = new URL(u);
              url.pathname = '';
              url.search = '';
              return url.toString().replace(/\/$/, '');
            } catch {
              /* fall through */
            }
          }
          const host = reqForApi.get?.('host');
          if (host) {
            const proto =
              reqForApi.get?.('x-forwarded-proto') || reqForApi.protocol || 'https';
            return `${proto === 'https' ? 'https' : 'http'}://${host}`.replace(
              /\/$/,
              '',
            );
          }
          return null;
        })();
      if (publicApiUrl) {
        dashboardUrl += `&sync_progress_api=${encodeURIComponent(publicApiUrl)}`;
      } else {
        this.logger.warn(
          '[AmazonController] Could not derive sync_progress_api – sync bar may stay at 0% if the frontend polls a different API. Set PUBLIC_API_URL or AMAZON_REDIRECT_URI.',
        );
      }
      return res.redirect(dashboardUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`OAuth callback failed: ${msg}`);
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

  /**
   * Disconnect Amazon account so the user can reconnect with new permissions.
   * Example: POST /api/amazon/disconnect
   */
  @UseGuards(ClerkAuthGuard)
  @Post('disconnect')
  disconnectAmazon(@Req() req: { user: { userId: string } }) {
    return this.amazonService.disconnectAmazon(req.user.userId);
  }

  @UseGuards(ClerkAuthGuard)
  @Get('account/summary')
  getAccountSummary(
    @Req() req: { user: { orgId: string; userId: string; marketplaceId?: string } },
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    return this.amazonService.getAccountSummary(
      req.user.orgId,
      req.user.userId,
      { start, end },
      req.user.marketplaceId,
    );
  }

  /**
   * Full initial pipeline progress (0–100): mini full-sync maps to ~0–85%, then post-initial + fee-sync to 100%.
   * `done` is true only when core mini-sync is complete and fee-sync is finished (or no fee key for legacy users).
   */
  @UseGuards(ClerkAuthGuard)
  @Get('sync-progress')
  async getSyncProgress(@Req() req: { user: { userId: string } }) {
    this.logger.log(`[sync-progress] GET received userId=${req.user.userId.slice(0, 8)}…`);
    return this.amazonSyncService.getSyncProgress(req.user.userId);
  }

  @UseGuards(ClerkAuthGuard)
  @Get('dashboard/category-breakdown')
  getCategoryBreakdown(
    @Req() req: { user: { orgId: string; marketplaceId?: string } },
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    return this.amazonService.getCategoryBreakdown(req.user.orgId, {
      start,
      end,
    }, req.user.marketplaceId);
  }

  @UseGuards(ClerkAuthGuard)
  @Get('dashboard/cost-breakdown')
  getCostBreakdown(
    @Req() req: { user: { orgId: string; marketplaceId?: string } },
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    return this.amazonService.getCostBreakdown(req.user.orgId, {
      start,
      end,
    }, req.user.marketplaceId);
  }

  @UseGuards(ClerkAuthGuard)
  @Get('dashboard/profit-and-loss')
  getProfitAndLoss(
    @Req() req: { user: { orgId: string; marketplaceId?: string } },
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    return this.amazonService.getProfitAndLoss(req.user.orgId, {
      start,
      end,
    }, req.user.marketplaceId);
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
  async syncNow(
    @Req() req: { user: { userId: string } },
    @Query('days') days?: string,
    @Query('ignoreCursor') ignoreCursor?: string,
    @Query('inline') inline?: string,
  ) {
    const n = Number(days ?? 30);
    const safeDays = Number.isFinite(n) ? Math.max(1, Math.min(365, n)) : 30;
    const direct =
      ignoreCursor === '1' || ignoreCursor === 'true' || ignoreCursor === 'yes';
    const runInline =
      inline === '1' || inline === 'true' || inline === 'yes';

    if (runInline) {
      void this.amazonSyncProcessor.runFullSyncInline(req.user.userId).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(`[sync:inline] Failed for userId=${req.user.userId}: ${msg}`);
      });
      return { status: 'started-inline' };
    }

    if (direct) {
      const sp = await this.amazonSyncService.getSyncProgress(req.user.userId);
      if (!sp.done) {
        this.logger.log(
          `[sync] Rejecting direct full sync – pipeline not finished (${sp.progress}%). User must wait for completion or use queue.`,
        );
        throw new BadRequestException(
          `Initial sync is still in progress (${Math.round(sp.progress)}%). Wait until fully synced before running a full order sync.`,
        );
      }
      await this.amazonService.syncRecentOrdersToDb(req.user.userId, {
        ignoreCursor: true,
        days: safeDays,
      });
      return { status: 'synced', mode: 'direct', days: safeDays };
    }

    await this.amazonSyncService.enqueueFullSync(req.user.userId);
    return { status: 'queued' };
  }

  /**
   * Wipe all synced Amazon data for the current user and restart initial sync.
   * Keeps credentials so no re-auth. Use when testing and initial sync misbehaves.
   */
  @UseGuards(ClerkAuthGuard)
  @Post('wipe-sync-data')
  async wipeSyncData(@Req() req: { user: { userId: string } }) {
    try {
      await this.amazonSyncService.wipeSyncDataAndRestartInitialSync(req.user.userId);
      return { ok: true, message: 'Data wiped; initial sync restarted.' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[wipe-sync-data] failed: ${msg}`);
      throw new BadRequestException(msg || 'Wipe failed');
    }
  }

  /**
   * Dev-friendly alias for POST /api/amazon/sync (allows triggering from browser).
   * Example: GET /api/amazon/sync?ignoreCursor=1&days=30
   */
  @UseGuards(ClerkAuthGuard)
  @Get('sync')
  async syncNowGet(
    @Req() req: { user: { userId: string } },
    @Query('days') days?: string,
    @Query('ignoreCursor') ignoreCursor?: string,
  ) {
    return this.syncNow(req, days, ignoreCursor);
  }

  @UseGuards(ClerkAuthGuard)
  @Get('sales/timeseries')
  getSalesTimeSeries(
    @Req() req: { user: { orgId: string; userId: string; marketplaceId?: string } },
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    return this.amazonService.getSalesTimeSeries(
      req.user.orgId,
      { start, end },
      req.user.userId,
      req.user.marketplaceId,
    );
  }

  @UseGuards(ClerkAuthGuard)
  @Get('orders')
  listOrders(@Req() req: { user: { orgId: string; marketplaceId?: string } }) {
    return this.amazonService.listOrders(req.user.orgId, req.user.marketplaceId);
  }

  /**
   * Merges duplicate `orders` rows (same Amazon order id, different `marketplace` key) and re-homes line items,
   * then kicks off a 30-day orders sync for each org member (background; does not wait for sync to finish).
   */
  @UseGuards(ClerkAuthGuard)
  @Post('orders/repair-duplicates')
  async repairOrderDuplicates(@Req() req: { user: { orgId: string } }) {
    const { ordersRemoved, orgUserIds } =
      await this.amazonService.repairDuplicateAmazonOrdersForOrg(req.user.orgId);
    for (const userId of orgUserIds) {
      void this.amazonService.syncRecentOrdersToDb(userId, { days: 30 }).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(
          `[orders/repair-duplicates] follow-up sync failed (userId=${userId.slice(0, 8)}…): ${msg}`,
        );
      });
    }
    return {
      ordersRemoved,
      syncTriggeredForUsers: orgUserIds.length,
    };
  }

  /**
   * Dev-only: diagnostic counts for orders (org members + order_items) to debug "zero orders".
   * GET /api/amazon/dev/orders-debug
   */
  @UseGuards(ClerkAuthGuard)
  @Get('dev/orders-debug')
  async ordersDebug(@Req() req: { user: { orgId: string } }) {
    return this.amazonService.getOrdersDebug(req.user.orgId);
  }

  /**
   * Dev-only: call SP-API getOrders (no persist), return order count. Verifies API returns data.
   * GET /api/amazon/dev/orders-test-fetch
   */
  @UseGuards(ClerkAuthGuard)
  @Get('dev/orders-test-fetch')
  async ordersTestFetch(@Req() req: { user: { orgId: string; userId: string } }) {
    return this.amazonService.testOrdersApiFetch(req.user.orgId, req.user.userId);
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
   * Call Catalog API for products missing productType/displayGroup and store them on Product.
   * Paginates through all needing backfill (batch size = limit); no nextToken — Catalog API is 1 request per ASIN.
   * Example: POST /api/amazon/catalog/backfill-categories?limit=250
   * Example: GET /api/amazon/catalog/backfill-categories?limit=250
   */
  @UseGuards(ClerkAuthGuard)
  @Post('catalog/backfill-categories')
  async backfillCatalogCategories(
    @Req() req: { user: { orgId: string; userId: string } },
    @Query('limit') limit?: string,
  ) {
    const n = Number(limit ?? 250);
    const safeLimit = Number.isFinite(n) ? Math.max(50, Math.min(500, n)) : 250;
    return this.amazonService.backfillCatalogCategoriesForNewAsins(
      req.user.orgId,
      req.user.userId,
      undefined,
      safeLimit,
    );
  }

  @UseGuards(ClerkAuthGuard)
  @Get('catalog/backfill-categories')
  async backfillCatalogCategoriesGet(
    @Req() req: { user: { orgId: string; userId: string } },
    @Query('limit') limit?: string,
  ) {
    const n = Number(limit ?? 250);
    const safeLimit = Number.isFinite(n) ? Math.max(50, Math.min(500, n)) : 250;
    return this.amazonService.backfillCatalogCategoriesForNewAsins(
      req.user.orgId,
      req.user.userId,
      undefined,
      safeLimit,
    );
  }

  /**
   * Dev-only: Catalog API raw response + parsed productType and displayGroup for debugging.
   * Example: GET /api/amazon/dev/catalog-item-category-debug?asin=B0B7NSZTHX
   */
  @UseGuards(ClerkAuthGuard)
  @Get('dev/catalog-item-category-debug')
  async devCatalogItemCategoryDebug(
    @Req() req: { user: { orgId: string; userId: string } },
    @Query('asin') asin?: string,
  ) {
    const asinTrim = asin?.trim();
    if (!asinTrim) {
      throw new BadRequestException('asin is required');
    }
    return this.amazonService.devGetCatalogItemCategoryDebug(
      req.user.orgId,
      req.user.userId,
      asinTrim,
    );
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
   * Dev-only: inspect raw Product Fees API response (to debug referral vs FBA).
   * Use sku= or asin= (e.g. asin=B09SV93C9H). Add save=1 to write fee-estimate-debug.json to backend root.
   * Example: GET /api/amazon/dev/fees-estimate-raw?asin=B09SV93C9H&save=1
   */
  @UseGuards(ClerkAuthGuard)
  @Get('dev/fees-estimate-raw')
  async devFeesEstimateRaw(
    @Req() req: { user: { orgId: string } },
    @Query('sku') sku?: string,
    @Query('asin') asin?: string,
    @Query('listingPrice') listingPrice?: string,
    @Query('save') save?: string,
  ) {
    const skuTrim = sku?.trim();
    const asinTrim = asin?.trim();
    if (!skuTrim && !asinTrim) {
      throw new BadRequestException('sku or asin is required');
    }
    const price = listingPrice ? Number(listingPrice) : undefined;
    return this.amazonService.devGetFeesEstimateRaw(req.user.orgId, {
      sku: skuTrim || undefined,
      asin: asinTrim || undefined,
      listingPrice: Number.isFinite(price) ? price : undefined,
      save: save === '1' || save === 'true' || save === 'yes',
    });
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
    @Req() req: { user: { orgId: string; marketplaceId?: string } },
    @Query('limit') limit?: string,
    @Query('period') period?: string,
  ) {
    const n = Number(limit ?? 10);
    const safeLimit = Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 10;
    const periodVal = period === 'month' ? 'month' : '30d';
    return this.amazonService.getTopProfitableProducts(
      req.user.orgId,
      safeLimit,
      periodVal,
      req.user.marketplaceId,
    );
  }

  /**
   * Replenish: best-selling products sorted by out-of-stock first, then most sold, then estimated profit.
   * Example: GET /api/amazon/replenish?limit=100
   */
  @UseGuards(ClerkAuthGuard)
  @Get('replenish')
  async getReplenish(
    @Req() req: { user: { orgId: string; marketplaceId?: string } },
    @Query('limit') limit?: string,
  ) {
    const n = Number(limit ?? 5000);
    const safeLimit = Number.isFinite(n) ? Math.max(1, Math.min(10000, n)) : 5000;
    return this.amazonService.getReplenishProducts(req.user.orgId, safeLimit, req.user.marketplaceId);
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
  async listInventory(@Req() req: { user: { orgId: string; marketplaceId?: string } }) {
    return this.amazonService.listInventory(req.user.orgId, req.user.marketplaceId);
  }

  /**
   * Inventory (FBA): sync inventory summaries now.
   *
   * Example: POST /api/amazon/inventory/sync
   */
  @UseGuards(ClerkAuthGuard)
  @Post('inventory/sync')
  async syncInventory(@Req() req: { user: { orgId: string; userId: string } }) {
    this.logger.log(`Manual inventory sync requested (orgId=${req.user.orgId})`);
    return this.amazonService.syncFbaInventory(req.user.orgId, req.user.userId);
  }

  /**
   * FBA Shipments: list inbound shipments from DB.
   * Example: GET /api/amazon/shipments
   */
  @UseGuards(ClerkAuthGuard)
  @Get('shipments')
  async listShipments(@Req() req: { user: { orgId: string; marketplaceId?: string } }) {
    return this.amazonService.listShipments(req.user.orgId, req.user.marketplaceId);
  }

  /**
   * Summary of missing units from FBA shipments (for topbar notification).
   * Example: GET /api/amazon/shipments/missing-summary
   */
  @UseGuards(ClerkAuthGuard)
  @Get('shipments/missing-summary')
  async getShipmentsMissingSummary(@Req() req: { user: { orgId: string } }) {
    return this.amazonService.getShipmentsMissingSummary(req.user.orgId);
  }

  /**
   * FBA Shipments: sync from SP-API (getShipments + items + transport).
   * Example: POST /api/amazon/shipments/sync
   */
  @UseGuards(ClerkAuthGuard)
  @Post('shipments/sync')
  async syncShipments(@Req() req: { user: { orgId: string; userId: string } }) {
    return this.amazonService.syncShipments(req.user.orgId, req.user.userId);
  }

  /**
   * FBA Shipments: set manual check-in date (for historic shipments where API didn't return it).
   * Example: PATCH /api/amazon/shipments/:shipmentId/checked-in
   * Body: { "checkedInDate": "YYYY-MM-DD" }
   */
  @UseGuards(ClerkAuthGuard)
  @Patch('shipments/:shipmentId/checked-in')
  async setShipmentCheckedIn(
    @Req() req: { user: { orgId: string } },
    @Param('shipmentId') shipmentId: string,
    @Body() body: { checkedInDate: string },
  ) {
    const checkedInDate = body?.checkedInDate?.trim();
    if (!checkedInDate) {
      throw new BadRequestException('checkedInDate is required (YYYY-MM-DD)');
    }
    const result = await this.amazonService.setShipmentManualCheckedInDate(
      req.user.orgId,
      shipmentId,
      checkedInDate,
    );
    if (!result.ok) {
      throw new BadRequestException(result.error ?? 'Failed to set check-in date');
    }
    return { ok: true };
  }

  /**
   * Refresh estimated Amazon fees per product (Product Fees API).
   * Runs at most once per 24h per org; returns skipped if already run today.
   *
   * Example: POST /api/amazon/fees-estimate/refresh
   */
  @UseGuards(ClerkAuthGuard)
  @Post('fees-estimate/refresh')
  async refreshFeeEstimates(@Req() req: { user: { orgId: string } }) {
    return this.amazonService.refreshFeeEstimatesForOrg(req.user.orgId);
  }

  /**
   * Cost of Goods: list all SKUs that have inventory (from FBA sync), paginated.
   * Example: GET /api/amazon/cost-of-goods/products?take=10&skip=0
   */
  @UseGuards(ClerkAuthGuard)
  @Get('cost-of-goods/products')
  async listCostOfGoodsProducts(
    @Req() req: { user: { orgId: string; marketplaceId?: string } },
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const takeN = Number(take ?? 10);
    const skipN = Number(skip ?? 0);
    const safeTake = Number.isFinite(takeN) ? Math.max(1, Math.min(500, takeN)) : 10;
    const safeSkip = Number.isFinite(skipN) ? Math.max(0, skipN) : 0;
    // All tab: return every inventory SKU, enriched with latest cost entry (if any) and fallback COGS (if any).
    return this.amazonService.listProductsWithCostInfoFromInventory(req.user.orgId, {
      take: safeTake,
      skip: safeSkip,
    }, req.user.marketplaceId);
  }

  /**
   * Cost of Goods: list inventory SKUs that have at least one cost entry (Complete tab).
   * Example: GET /api/amazon/cost-of-goods/complete?take=10&skip=0
   */
  @UseGuards(ClerkAuthGuard)
  @Get('cost-of-goods/complete')
  async listCostOfGoodsComplete(
    @Req() req: { user: { orgId: string; marketplaceId?: string } },
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const takeN = Number(take ?? 10);
    const skipN = Number(skip ?? 0);
    const safeTake = Number.isFinite(takeN) ? Math.max(1, Math.min(500, takeN)) : 10;
    const safeSkip = Number.isFinite(skipN) ? Math.max(0, skipN) : 0;
    return this.amazonService.listProductsWithCostFromInventory(req.user.orgId, {
      take: safeTake,
      skip: safeSkip,
    }, req.user.marketplaceId);
  }

  /**
   * Cost of Goods (ledger): list inbound cost entries.
   * Example: GET /api/amazon/cost-of-goods/entries?query=...&take=50&skip=0
   */
  @UseGuards(ClerkAuthGuard)
  @Get('cost-of-goods/entries')
  async listCostOfGoodsEntries(
    @Req() req: { user: { orgId: string; marketplaceId?: string } },
    @Query('query') query?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const takeN = Number(take ?? 50);
    const skipN = Number(skip ?? 0);
    const safeTake = Number.isFinite(takeN)
      ? Math.max(1, Math.min(200, takeN))
      : 50;
    const safeSkip = Number.isFinite(skipN) ? Math.max(0, skipN) : 0;
    return this.amazonService.listPurchases(req.user.orgId, {
      query: query ?? '',
      take: safeTake,
      skip: safeSkip,
    }, req.user.marketplaceId);
  }

  /**
   * Cost of Goods (ledger): create inbound cost entry.
   * Example: POST /api/amazon/cost-of-goods/entries
   */
  @UseGuards(ClerkAuthGuard)
  @Post('cost-of-goods/entries')
  async createCostOfGoodsEntry(
    @Req() req: { user: { orgId: string; userId: string } },
    @Body() dto: CreatePurchaseDto,
  ) {
    return this.amazonService.createPurchase(
      req.user.orgId,
      req.user.userId,
      dto,
    );
  }

  /**
   * Cost of Goods (ledger): update inbound cost entry.
   * Example: PATCH /api/amazon/cost-of-goods/entries/:entryId
   */
  @UseGuards(ClerkAuthGuard)
  @Patch('cost-of-goods/entries/:entryId')
  async updateCostOfGoodsEntry(
    @Req() req: { user: { orgId: string; userId: string } },
    @Param('entryId') entryId: string,
    @Body() dto: UpdatePurchaseDto,
  ) {
    return this.amazonService.updatePurchase(
      req.user.orgId,
      req.user.userId,
      entryId,
      dto,
    );
  }

  /**
   * Cost of Goods (ledger): seed entries from existing Product.costOfGoods.
   * This is a convenience for migrating from the old per-SKU COGS editor.
   *
   * Example: POST /api/amazon/cost-of-goods/seed-from-products
   */
  @UseGuards(ClerkAuthGuard)
  @Post('cost-of-goods/seed-from-products')
  async seedCostOfGoodsFromProducts(@Req() req: { user: { orgId: string } }) {
    return this.amazonService.seedCostOfGoodsEntriesFromProducts(
      req.user.orgId,
    );
  }

  /**
   * Bulk COGS upload: body { rows: [{ asin, unitCostIncVat, ... }] } — one ledger entry per row.
   * ASIN must match a product already in the account.
   */
  @UseGuards(ClerkAuthGuard)
  @Post('cost-of-goods/bulk-upload')
  async bulkUploadCostOfGoods(
    @Req() req: { user: { orgId: string; userId: string } },
    @Body() body: { rows?: unknown[] },
  ) {
    const rows = body?.rows;
    if (!Array.isArray(rows)) {
      throw new BadRequestException('JSON body must include a "rows" array');
    }
    return this.amazonService.bulkUploadCostOfGoodsRows(
      req.user.orgId,
      req.user.userId,
      rows,
    );
  }

  /**
   * Cost of Goods: list inventory SKUs that have no cost entries in the DB
   * (no Purchase rows and no/zero Product.costOfGoods). Paginated with take/skip.
   *
   * Example: GET /api/amazon/cost-of-goods/missing?take=10&skip=0
   */
  @UseGuards(ClerkAuthGuard)
  @Get('cost-of-goods/missing')
  async listMissingCostOfGoods(
    @Req() req: { user: { orgId: string; marketplaceId?: string } },
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const takeN = Number(take ?? 10);
    const skipN = Number(skip ?? 0);
    const safeTake = Number.isFinite(takeN) ? Math.max(1, Math.min(500, takeN)) : 10;
    const safeSkip = Number.isFinite(skipN) ? Math.max(0, skipN) : 0;
    return this.amazonService.listMissingCostOfGoods(req.user.orgId, {
      start,
      end,
      take: safeTake,
      skip: safeSkip,
    }, req.user.marketplaceId);
  }

  /**
   * Dev-only: show which Amazon sellerAccount is being used for this org,
   * plus whether SP-API is configured for sandbox.
   *
   * Example: GET /api/amazon/dev/connection
   */
  @UseGuards(ClerkAuthGuard)
  @Get('dev/connection')
  async devAmazonConnection(
    @Req() req: { user: { orgId: string; userId: string } },
  ) {
    return {
      spapi: (this.amazonService as any).spApiClient.getDebugConfig?.() ?? null,
      amazonAppId: this.configService.get<string>('AMAZON_APP_ID') ?? null,
      amazonRedirectUri:
        this.configService.get<string>('AMAZON_REDIRECT_URI') ?? null,
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
