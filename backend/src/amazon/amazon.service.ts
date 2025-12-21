import { Injectable } from '@nestjs/common';
import { AmazonSpApiClient } from './sp-api.client';

@Injectable()
export class AmazonService {
  // TODO: Inject PrismaService and use real seller data + SP-API later

  constructor(private readonly spApiClient: AmazonSpApiClient) {}

  async getAccountSummary() {
    try {
      const data = (await this.spApiClient.getOrders()) as {
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
  async getSandboxMarketplaceParticipations() {
    return this.spApiClient.getMarketplaceParticipations();
  }

  /**
   * Example method that calls the real SP-API Orders getOrders operation.
   * This will use the sandbox or production endpoints depending on the
   * client configuration (currently use_sandbox: true in the client).
   */
  async getRecentOrders() {
    // For now: last 30 days, US marketplace.
    return this.spApiClient.getOrders();
  }
}




