import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AmazonSpApiClient, SpApiCredentials, SpApiRegion } from './sp-api.client';
import { PrismaService } from '../prisma/prisma.service';
import { LinkAmazonAccountDto } from './dto/link-amazon-account.dto';

@Injectable()
export class AmazonService {
  constructor(
    private readonly spApiClient: AmazonSpApiClient,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private async getAmazonCredentialsForUser(
    userId: string,
  ): Promise<SpApiCredentials> {
    const account = await this.prisma.sellerAccount.findUnique({
      where: {
        userId_marketplace: {
          userId,
          marketplace: 'amazon',
        },
      },
    });

    if (!account) {
      throw new NotFoundException(
        'Amazon account not linked. Please link your Amazon account first.',
      );
    }

    const creds = account.credentials as {
      region?: 'na' | 'eu' | 'fe';
      lwaClientId: string;
      lwaClientSecret: string;
      refreshToken: string;
      awsAccessKeyId: string;
      awsSecretAccessKey: string;
      awsRoleArn?: string;
    };

    if (
      !creds ||
      !creds.lwaClientId ||
      !creds.lwaClientSecret ||
      !creds.refreshToken ||
      !creds.awsAccessKeyId ||
      !creds.awsSecretAccessKey
    ) {
      throw new NotFoundException(
        'Amazon credentials are incomplete. Please relink your Amazon account.',
      );
    }

    return {
      region: creds.region ?? 'na',
      lwaClientId: creds.lwaClientId,
      lwaClientSecret: creds.lwaClientSecret,
      refreshToken: creds.refreshToken,
      awsAccessKeyId: creds.awsAccessKeyId,
      awsSecretAccessKey: creds.awsSecretAccessKey,
      awsRoleArn: creds.awsRoleArn,
    };
  }

  async getAccountSummary(userId: string) {
    let credentials: SpApiCredentials;

    // Ensure the user has a linked Amazon account; preserve existing 404 behavior.
    try {
      credentials = await this.getAmazonCredentialsForUser(userId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw error;
    }

    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const startDate = new Date(
      nowSafe.getTime() - 30 * 24 * 60 * 60 * 1000,
    );

    const rows = await (this.prisma as any).aggDailyKpiSummary.findMany({
      where: {
        userId,
        marketplace: 'amazon',
        date: {
          gte: startDate,
          lte: nowSafe,
        },
      },
    });

    if (!rows.length) {
      // No aggregates yet for this user; return a zeroed summary rather than demo data.
      const currency = credentials.region === 'eu' ? 'GBP' : 'USD';
      return {
        marketplace: 'amazon',
        sellerId: 'LIVE-SELLER',
        currency,
        period: 'last_30_days',
        revenue: 0,
        profitMargin: 0,
        unitsSold: 0,
        adSpend: 0,
        totalOrders: 0,
        activeSkus: 0,
        unitsInFba: 0,
        openShipments: 0,
        generatedAt: new Date().toISOString(),
      };
    }

    const revenue = rows.reduce(
      (sum: number, row: any) => sum + Number(row.revenue),
      0,
    );
    const unitsSold = rows.reduce(
      (sum: number, row: any) => sum + row.unitsSold,
      0,
    );
    const totalOrders = rows.reduce(
      (sum: number, row: any) => sum + row.ordersCount,
      0,
    );

    const currency = credentials.region === 'eu' ? 'GBP' : 'USD';
    const activeSkus = totalOrders; // simple placeholder until per-SKU aggregates exist
    const unitsInFba = unitsSold * 3; // same placeholder logic as before
    const openShipments = Math.max(1, Math.round(totalOrders / 2));

    return {
      marketplace: 'amazon',
      sellerId: 'LIVE-SELLER',
      currency,
      period: 'last_30_days',
      revenue,
      profitMargin: 0.28,
      unitsSold,
      adSpend: revenue * 0.25,
      totalOrders,
      activeSkus,
      unitsInFba,
      openShipments,
      generatedAt: new Date().toISOString(),
    };
  }

  async getSalesTimeSeries(
    userId: string,
    range?: { start?: string; end?: string },
  ) {
    let credentials: SpApiCredentials;

    try {
      credentials = await this.getAmazonCredentialsForUser(userId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw error;
    }

    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const defaultStart = new Date(
      nowSafe.getTime() - 30 * 24 * 60 * 60 * 1000,
    );

    const startDate = range?.start ? new Date(range.start) : defaultStart;
    const endDate = range?.end ? new Date(range.end) : nowSafe;

    const ordersFromDb = await this.prisma.order.findMany({
      where: {
        userId,
        marketplace: 'amazon',
        orderDate: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        orderDate: true,
        itemPrice: true,
        quantity: true,
      },
    });

    const byDate = new Map<
      string,
      { revenue: number; orders: number }
    >();

    for (const order of ordersFromDb) {
      const d = order.orderDate;
      const key = d.toISOString().slice(0, 10); // YYYY-MM-DD

      const itemPriceNum = Number(order.itemPrice);
      const quantityNum = order.quantity;
      const revenueForOrder = itemPriceNum * quantityNum;

      const existing = byDate.get(key) ?? { revenue: 0, orders: 0 };
      existing.revenue += revenueForOrder;
      existing.orders += 1;
      byDate.set(key, existing);
    }

    const currency = credentials.region === 'eu' ? 'GBP' : 'USD';

    let points = Array.from(byDate.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, value]) => ({
        date,
        revenue: value.revenue,
        orders: value.orders,
      }));

    // If no explicit range is provided, pad to a full 30-day window so charts
    // always have consistent length.
    if (!range?.start && !range?.end) {
      const dayMs = 24 * 60 * 60 * 1000;
      const padded: { date: string; revenue: number; orders: number }[] = [];
      for (let i = 0; i < 30; i += 1) {
        const d = new Date(defaultStart.getTime() + i * dayMs);
        const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
        const existing = byDate.get(key) ?? { revenue: 0, orders: 0 };
        padded.push({
          date: key,
          revenue: existing.revenue,
          orders: existing.orders,
        });
      }
      points = padded;
    }

    return {
      currency,
      points,
    };
  }

  /**
   * Background sync: fetch recent Amazon orders for this user and persist them
   * into the generic Order/Product tables via Prisma.
   *
   * For now we:
   * - pull roughly the last 30 days of orders (similar window to the summary)
   * - map them into a single aggregate "AMAZON_GENERIC" product per user
   * - upsert one Order row per AmazonOrderId
   */
  async syncRecentOrdersToDb(userId: string): Promise<void> {
    const credentials = await this.getAmazonCredentialsForUser(userId);

    const account = await this.prisma.sellerAccount.findUnique({
      where: {
        userId_marketplace: {
          userId,
          marketplace: 'amazon',
        },
      },
    });

    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const defaultStart = new Date(
      nowSafe.getTime() - 30 * 24 * 60 * 60 * 1000,
    );

    // Use incremental sync cursor when available; fall back to the last 30 days.
    const startDate =
      account && (account as any).ordersLastSyncedAt
        ? ((account as any).ordersLastSyncedAt as Date)
        : defaultStart;

    const createdAfterIso = startDate.toISOString().split('.')[0] + 'Z';
    const createdBeforeIso = nowSafe.toISOString().split('.')[0] + 'Z';

    const marketplaceIds =
      credentials.region === 'eu'
        ? [
            'A1F83G8C2ARO7P', // UK
            'A1PA6795UKMFR9', // DE
            'A13V1IB3VIYZZH', // FR
            'APJ6JRA9NG5V4', // IT
            'A1RKKUPIHCS9HS', // ES
          ]
        : [
            'ATVPDKIKX0DER', // US
            'A2EUQ1WTGCTBG2', // CA
            'A1AM78C64UM0Y8', // MX
          ];

    type SpApiOrder = {
      AmazonOrderId?: string;
      PurchaseDate?: string;
      LatestShipDate?: string;
      EarliestShipDate?: string;
      OrderTotal?: { Amount?: string; CurrencyCode?: string };
      NumberOfItemsShipped?: number;
      NumberOfItemsUnshipped?: number;
    };

    const data = (await this.spApiClient.getOrders(credentials, {
      createdAfter: createdAfterIso,
      createdBefore: createdBeforeIso,
      marketplaceIds,
      orderStatuses: ['Shipped', 'Unshipped', 'PartiallyShipped', 'Canceled'],
    })) as {
      payload?: {
        Orders?: SpApiOrder[];
      };
    };

    const orders = data.payload?.Orders ?? [];

    console.log(
      '[AmazonService.syncRecentOrdersToDb] fetched orders:',
      orders.length,
      { userId },
    );

    if (orders.length === 0) {
      // Still advance the cursor so we don't keep re-querying the same window.
      if (account) {
        await this.prisma.sellerAccount.update({
          where: {
            userId_marketplace: {
              userId,
              marketplace: 'amazon',
            },
          },
          // Cast to any until Prisma types are regenerated with ordersLastSyncedAt.
          data: {
            ordersLastSyncedAt: nowSafe,
          } as any,
        });
      }
      // No new data -> skip recomputing aggregates to avoid unnecessary work.
      return;
    }

    // For now, attach all synced orders to a single aggregate product per user.
    const aggregateSku = 'AMAZON_GENERIC';
    const aggregateProduct = await this.prisma.product.upsert({
      where: {
        userId_sku: {
          userId,
          sku: aggregateSku,
        },
      },
      update: {},
      create: {
        userId,
        sku: aggregateSku,
        title: 'Amazon Sales (Aggregate)',
      },
    });

    for (const order of orders) {
      const amazonOrderId = order.AmazonOrderId;
      if (!amazonOrderId) {
        // Skip orders without a stable ID.
        // eslint-disable-next-line no-continue
        continue;
      }

      const rawTotal = parseFloat(order.OrderTotal?.Amount ?? '0');
      const totalAmount = Number.isNaN(rawTotal) ? 0 : rawTotal;

      const quantityRaw =
        (order.NumberOfItemsShipped ?? 0) +
        (order.NumberOfItemsUnshipped ?? 0);
      const quantity = quantityRaw > 0 ? quantityRaw : 1;

      const itemPrice =
        quantity > 0 ? Number((totalAmount / quantity).toFixed(2)) : totalAmount;

      const orderDateStr =
        order.PurchaseDate ??
        order.LatestShipDate ??
        order.EarliestShipDate ??
        nowSafe.toISOString();
      const orderDate = new Date(orderDateStr);
      if (Number.isNaN(orderDate.getTime())) {
        // eslint-disable-next-line no-continue
        continue;
      }

      await this.prisma.order.upsert({
        where: {
          orderId_marketplace: {
            orderId: amazonOrderId,
            marketplace: 'amazon',
          },
        },
        update: {
          userId,
          productId: aggregateProduct.id,
          sku: aggregateSku,
          quantity,
          itemPrice,
          fees: {},
          totalProfit: null,
          rawResponse: order,
          orderDate,
        },
        create: {
          userId,
          productId: aggregateProduct.id,
          orderId: amazonOrderId,
          marketplace: 'amazon',
          sku: aggregateSku,
          asin: null,
          quantity,
          itemPrice,
          fees: {},
          totalProfit: null,
          rawResponse: order,
          orderDate,
        },
      });
    }

    // Update sync cursor for this seller.
    await this.prisma.sellerAccount.update({
      where: {
        userId_marketplace: {
          userId,
          marketplace: 'amazon',
        },
      },
      // Cast to any until Prisma types are regenerated with ordersLastSyncedAt.
      data: {
        ordersLastSyncedAt: nowSafe,
      } as any,
    });

    // Recompute daily KPI aggregates for this user based on the latest orders.
    try {
      await this.recomputeDailyKpiSummary(userId);
    } catch (err) {
      // Non-fatal: log and continue; raw orders are still persisted.
      console.error(
        '[AmazonService.syncRecentOrdersToDb] failed to recompute daily KPI summary',
        { userId, err },
      );
    }
  }

  /**
   * Batch background sync: run recent-order sync for all active Amazon sellers.
   * Intended to be triggered periodically by a BullMQ repeatable job.
   */
  async syncRecentOrdersForAllSellers(): Promise<void> {
    const accounts = await this.prisma.sellerAccount.findMany({
      where: {
        marketplace: 'amazon',
        isActive: true,
      },
      select: {
        userId: true,
      },
    });

    for (const { userId } of accounts) {
      try {
        console.log(
          '[AmazonService.syncRecentOrdersForAllSellers] syncing user',
          { userId },
        );
        await this.syncRecentOrdersToDb(userId);
      } catch (err) {
        console.error(
          '[AmazonService.syncRecentOrdersForAllSellers] failed for user',
          { userId, err },
        );
      }
    }
  }

  /**
   * Recompute daily KPI aggregates for a user from the raw Order table.
   * For now we populate only the core metrics needed for the dashboard and
   * leave the cost/fee fields as zero until those sources are wired.
   */
  async recomputeDailyKpiSummary(userId: string): Promise<void> {
    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const startDate = new Date(
      nowSafe.getTime() - 30 * 24 * 60 * 60 * 1000,
    );

    const orders = await this.prisma.order.findMany({
      where: {
        userId,
        marketplace: 'amazon',
        orderDate: {
          gte: startDate,
          lte: nowSafe,
        },
      },
    });

    const byKey = new Map<
      string,
      {
        date: string;
        marketplace: string;
        fulfilmentChannel: string;
        revenue: number;
        unitsSold: number;
        ordersCount: number;
      }
    >();

    for (const order of orders) {
      const d = order.orderDate;
      const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
      const marketplace = order.marketplace;
      const fulfilmentChannel = 'UNKNOWN';
      const key = `${dateStr}|${marketplace}|${fulfilmentChannel}`;

      const existing =
        byKey.get(key) ??
        {
          date: dateStr,
          marketplace,
          fulfilmentChannel,
          revenue: 0,
          unitsSold: 0,
          ordersCount: 0,
        };

      const itemPriceNum = Number(order.itemPrice);
      const quantityNum = order.quantity;

      existing.revenue += itemPriceNum * quantityNum;
      existing.unitsSold += quantityNum;
      existing.ordersCount += 1;

      byKey.set(key, existing);
    }

    for (const value of byKey.values()) {
      const date = new Date(value.date);

      await (this.prisma as any).aggDailyKpiSummary.upsert({
        where: {
          userId_marketplace_fulfilmentChannel_date: {
            userId,
            marketplace: value.marketplace,
            fulfilmentChannel: value.fulfilmentChannel,
            date,
          },
        },
        update: {
          revenue: value.revenue,
          unitsSold: value.unitsSold,
          ordersCount: value.ordersCount,
          amazonFeesTotal: 0,
          refundsTotal: 0,
          cogsTotal: 0,
          prepFeesTotal: 0,
          shippingCostsTotal: 0,
          advertisingTotal: 0,
          vatOnAmazonFeesTotal: 0,
          vatEstimateTotal: 0,
          softwareSubsTotal: 0,
          otherSubsTotal: 0,
          vatTotal: 0,
          otherCostsTotal: 0,
          profit: 0,
          roiPct: 0,
          marginPct: 0,
        },
        create: {
          userId,
          marketplace: value.marketplace,
          fulfilmentChannel: value.fulfilmentChannel,
          date,
          revenue: value.revenue,
          unitsSold: value.unitsSold,
          ordersCount: value.ordersCount,
          amazonFeesTotal: 0,
          refundsTotal: 0,
          cogsTotal: 0,
          prepFeesTotal: 0,
          shippingCostsTotal: 0,
          advertisingTotal: 0,
          vatOnAmazonFeesTotal: 0,
          vatEstimateTotal: 0,
          softwareSubsTotal: 0,
          otherSubsTotal: 0,
          vatTotal: 0,
          otherCostsTotal: 0,
          profit: 0,
          roiPct: 0,
          marginPct: 0,
        },
      });
    }
  }

  /**
   * Example method that calls the SP-API client (sandbox for now).
   * This uses the Sellers API "getMarketplaceParticipations" shape.
   */
  async getSandboxMarketplaceParticipations(userId: string) {
    const credentials = await this.getAmazonCredentialsForUser(userId);
    return this.spApiClient.getMarketplaceParticipations(credentials);
  }

  /**
   * Example method that calls the real SP-API Orders getOrders operation.
   * This will use the sandbox or production endpoints depending on the
   * client configuration (currently use_sandbox: true in the client).
   */
  async getRecentOrders() {
    // For now: last 30 days, US marketplace.
    // NOTE: This method is no longer user-specific and still uses the
    // credentials from the linked account fetched in getAccountSummary
    // or getSandboxMarketplaceParticipations if needed later.
    // You can extend it to accept a userId when you want.
    throw new NotFoundException(
      'getRecentOrders is not wired for per-user credentials yet.',
    );
  }

  async linkAmazonAccount(userId: string, dto: LinkAmazonAccountDto) {
    const {
      region,
      sellerId,
      lwaClientId,
      lwaClientSecret,
      refreshToken,
      awsAccessKeyId,
      awsSecretAccessKey,
      awsRoleArn,
    } = dto;

    const credentials = {
      region,
      lwaClientId,
      lwaClientSecret,
      refreshToken,
      awsAccessKeyId,
      awsSecretAccessKey,
      awsRoleArn,
    };

    const account = await this.prisma.sellerAccount.upsert({
      where: {
        userId_marketplace: {
          userId,
          marketplace: 'amazon',
        },
      },
      update: {
        sellerId,
        credentials,
        isActive: true,
      },
      create: {
        userId,
        marketplace: 'amazon',
        sellerId,
        credentials,
      },
    });

    return {
      id: account.id,
      userId: account.userId,
      marketplace: account.marketplace,
      sellerId: account.sellerId,
      isActive: account.isActive,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  /**
   * Builds the Amazon Seller Central consent URL for a given user and region.
   * The user is encoded into the state payload so we can resolve them on callback.
   */
  async getAmazonConnectUrl(userId: string, regionCode: string): Promise<string> {
    const applicationId = this.configService.get<string>('AMAZON_APP_ID');
    const redirectUri = this.configService.get<string>('AMAZON_REDIRECT_URI');

    if (!applicationId || !redirectUri) {
      throw new Error('AMAZON_APP_ID and AMAZON_REDIRECT_URI must be configured');
    }

    const baseUrl = this.getSellerCentralBaseUrl(regionCode);

    const statePayload = {
      userId,
      region: regionCode,
    };
    const state = Buffer.from(JSON.stringify(statePayload)).toString('base64url');

    const url = new URL('/apps/authorize/consent', baseUrl);
    url.searchParams.set('application_id', applicationId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('version', 'beta');

    return url.toString();
  }

  /**
   * Handles the OAuth callback from Amazon, exchanges the auth code for a refresh token,
   * and persists the SellerAccount row tied to the original user.
   */
  async handleOauthCallback(params: {
    code: string;
    sellingPartnerId: string;
    state: string;
  }): Promise<void> {
    const { code, sellingPartnerId, state } = params;

    const decodedStateJson = Buffer.from(state, 'base64url').toString('utf8');
    const { userId, region } = JSON.parse(decodedStateJson) as {
      userId: string;
      region: string;
    };

    const redirectUri = this.configService.get<string>('AMAZON_REDIRECT_URI');
    const lwaClientId = this.configService.get<string>('LWA_CLIENT_ID');
    const lwaClientSecret = this.configService.get<string>('LWA_CLIENT_SECRET');
    const awsAccessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID') ?? '';
    const awsSecretAccessKey =
      this.configService.get<string>('AWS_SECRET_ACCESS_KEY') ?? '';
    const awsRoleArn = this.configService.get<string>('AWS_ROLE_ARN') ?? undefined;

    if (!redirectUri || !lwaClientId || !lwaClientSecret) {
      throw new Error('LWA_CLIENT_ID, LWA_CLIENT_SECRET and AMAZON_REDIRECT_URI must be configured');
    }

    // Exchange the auth code for a refresh token
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: lwaClientId,
      client_secret: lwaClientSecret,
      redirect_uri: redirectUri,
    }).toString();

    const response = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': body.length.toString(),
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to exchange SP-API auth code: ${response.status} ${text}`,
      );
    }

    const tokenJson = (await response.json()) as {
      refresh_token?: string;
    };

    if (!tokenJson.refresh_token) {
      throw new Error('No refresh_token returned from Amazon');
    }

    const spRegion = this.mapRegionCodeToSpApiRegion(region);

    await this.linkAmazonAccount(userId, {
      region: spRegion,
      sellerId: sellingPartnerId,
      lwaClientId,
      lwaClientSecret,
      refreshToken: tokenJson.refresh_token,
      awsAccessKeyId,
      awsSecretAccessKey,
      awsRoleArn,
    });
  }

  private getSellerCentralBaseUrl(regionCode: string): string {
    switch (regionCode.toUpperCase()) {
      case 'EU':
        return 'https://sellercentral-europe.amazon.com';
      case 'US':
      case 'NA':
        return 'https://sellercentral.amazon.com';
      case 'CA':
        return 'https://sellercentral.amazon.ca';
      case 'MX':
        return 'https://sellercentral.amazon.com.mx';
      case 'AU':
        return 'https://sellercentral.amazon.com.au';
      default:
        return 'https://sellercentral-europe.amazon.com';
    }
  }

  private mapRegionCodeToSpApiRegion(regionCode: string): SpApiRegion {
    switch (regionCode.toUpperCase()) {
      case 'EU':
        return 'eu';
      case 'US':
      case 'NA':
      case 'CA':
      case 'MX':
        return 'na';
      case 'AU':
      default:
        return 'na';
    }
  }
}
