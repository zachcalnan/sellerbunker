import { Injectable, NotFoundException } from '@nestjs/common';
import { AmazonSpApiClient, SpApiCredentials } from './sp-api.client';
import { PrismaService } from '../prisma/prisma.service';
import { LinkAmazonAccountDto } from './dto/link-amazon-account.dto';

@Injectable()
export class AmazonService {
  constructor(
    private readonly spApiClient: AmazonSpApiClient,
    private readonly prisma: PrismaService,
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
    try {
      const credentials = await this.getAmazonCredentialsForUser(userId);
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
      // Fallback to static demo values if SP-API call fails.
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
}
