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

    // If the user has not linked an Amazon account yet, surface a 404 back to the client.
    try {
      credentials = await this.getAmazonCredentialsForUser(userId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        // "Amazon account not linked" or "credentials incomplete" should not fall back to demo data
        throw error;
      }
      // For any other unexpected error getting credentials, also bubble up.
      throw error;
    }

    try {
      const data = (await this.spApiClient.getOrders(credentials)) as {
        payload?: {
          Orders?: Array<{
            OrderTotal?: { Amount?: string; CurrencyCode?: string };
            NumberOfItemsShipped?: number;
            NumberOfItemsUnshipped?: number;
            MarketplaceId?: string;
          }>;
        };
      };

      const orders = data.payload?.Orders ?? [];

      const totalOrders = orders.length;
      const revenue = orders.reduce((sum, order) => {
        const amount = parseFloat(order.OrderTotal?.Amount ?? '0');
        return sum + (isNaN(amount) ? 0 : amount);
      }, 0);

      const unitsSold = orders.reduce((sum, order) => {
        const shipped = order.NumberOfItemsShipped ?? 0;
        const unshipped = order.NumberOfItemsUnshipped ?? 0;
        return sum + shipped + unshipped;
      }, 0);

      const currency =
        orders[0]?.OrderTotal?.CurrencyCode ??
        (orders.length > 0 ? 'USD' : 'USD');

      // For sandbox we don't have real values for these, so keep simple placeholders.
      const activeSkus = totalOrders;
      const unitsInFba = unitsSold * 3;
      const openShipments = Math.max(1, Math.round(totalOrders / 2));

      return {
        marketplace: 'amazon',
        sellerId: 'SANDBOX-SELLER',
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
    } catch {
      // Fallback to static demo values only if the SP-API call itself fails.
      return {
        marketplace: 'amazon',
        sellerId: 'DEMO-SELLER-123',
        currency: 'USD',
        period: 'last_30_days',
        revenue: 24300,
        profitMargin: 0.28,
        unitsSold: 3240,
        adSpend: 6100,
        totalOrders: 4812,
        activeSkus: 186,
        unitsInFba: 9430,
        openShipments: 17,
        generatedAt: new Date().toISOString(),
      };
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
