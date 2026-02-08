import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  AmazonSpApiClient,
  SpApiCredentials,
  SpApiRegion,
} from './sp-api.client';
import { PrismaService } from '../prisma/prisma.service';
import { LinkAmazonAccountDto } from './dto/link-amazon-account.dto';
import { UsersService } from '../users/users.service';

@Injectable()
export class AmazonService {
  constructor(
    private readonly spApiClient: AmazonSpApiClient,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  private async getOrgMemberUserIds(orgId: string): Promise<string[]> {
    return this.usersService.getOrgMemberUserIds(orgId);
  }

  private async getAmazonCredentialsForOrg(
    orgId: string,
    preferredUserId?: string,
  ): Promise<SpApiCredentials> {
    const userIds = await this.getOrgMemberUserIds(orgId);

    // Prefer the currently-authenticated user's connection if present.
    // This avoids "findFirst picks a different org member's stale creds" issues.
    const preferred =
      preferredUserId && userIds.includes(preferredUserId)
        ? await this.prisma.sellerAccount.findUnique({
            where: {
              userId_marketplace: {
                userId: preferredUserId,
                marketplace: 'amazon',
              },
            },
          })
        : null;

    const account =
      preferred ??
      (await this.prisma.sellerAccount.findFirst({
        where: { userId: { in: userIds }, marketplace: 'amazon' },
        orderBy: { updatedAt: 'desc' },
      }));
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

  async getAmazonConnectionDebug(orgId: string, preferredUserId: string) {
    const userIds = await this.getOrgMemberUserIds(orgId);

    const preferredAccount = userIds.includes(preferredUserId)
      ? await this.prisma.sellerAccount.findUnique({
          where: {
            userId_marketplace: {
              userId: preferredUserId,
              marketplace: 'amazon',
            },
          },
          select: {
            id: true,
            userId: true,
            marketplace: true,
            sellerId: true,
            isActive: true,
            credentials: true,
            updatedAt: true,
            createdAt: true,
          },
        })
      : null;

    const fallbackAccount = await this.prisma.sellerAccount.findFirst({
      where: { userId: { in: userIds }, marketplace: 'amazon' },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        userId: true,
        marketplace: true,
        sellerId: true,
        isActive: true,
        credentials: true,
        updatedAt: true,
        createdAt: true,
      },
    });

    const pick = preferredAccount ?? fallbackAccount;
    const region =
      (pick?.credentials as any)?.region ??
      (pick?.credentials as any)?.Region ??
      null;

    return {
      orgId,
      preferredUserId,
      orgUserIds: userIds,
      selectedUserId: pick?.userId ?? null,
      selectedSellerAccountId: pick?.id ?? null,
      selectedSellerId: pick?.sellerId ?? null,
      selectedRegion: region,
      preferredAccount: preferredAccount
        ? {
            id: preferredAccount.id,
            userId: preferredAccount.userId,
            sellerId: preferredAccount.sellerId,
            isActive: preferredAccount.isActive,
            region:
              (preferredAccount.credentials as any)?.region ??
              (preferredAccount.credentials as any)?.Region ??
              null,
            updatedAt: preferredAccount.updatedAt,
            createdAt: preferredAccount.createdAt,
          }
        : null,
      fallbackAccount: fallbackAccount
        ? {
            id: fallbackAccount.id,
            userId: fallbackAccount.userId,
            sellerId: fallbackAccount.sellerId,
            isActive: fallbackAccount.isActive,
            region:
              (fallbackAccount.credentials as any)?.region ??
              (fallbackAccount.credentials as any)?.Region ??
              null,
            updatedAt: fallbackAccount.updatedAt,
            createdAt: fallbackAccount.createdAt,
          }
        : null,
    };
  }

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

  async getAccountSummary(
    orgId: string,
    preferredUserId?: string,
    range?: { start?: string; end?: string },
  ) {
    let credentials: SpApiCredentials;

    // Ensure the user has a linked Amazon account; preserve existing 404 behavior.
    try {
      credentials = await this.getAmazonCredentialsForOrg(
        orgId,
        preferredUserId,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw error;
    }

    const isDateOnly = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
    const parseDate = (s?: string) => {
      if (!s) return null;
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const endDate = (() => {
      const d = parseDate(range?.end);
      if (!d) return nowSafe;
      if (isDateOnly(range?.end)) {
        return new Date(`${range?.end}T23:59:59.999Z`);
      }
      return d;
    })();
    const startDate = (() => {
      const d = parseDate(range?.start);
      if (d) {
        if (isDateOnly(range?.start)) {
          return new Date(`${range?.start}T00:00:00.000Z`);
        }
        return d;
      }
      return new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    })();

    const safeStart = startDate <= endDate ? startDate : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const safeEnd = endDate;

    const userIds = await this.getOrgMemberUserIds(orgId);
    // Source of truth for Sales/Units/Orders is the raw Orders table.
    // aggDailyKpiSummary can drift (historical sync bugs / overwrites), so we avoid using it here.
    const orders = await this.prisma.order.findMany({
      where: {
        userId: { in: userIds },
        marketplace: 'amazon',
        orderDate: { gte: safeStart, lte: safeEnd },
      },
      select: {
        id: true,
        orderId: true,
        orderDate: true,
        itemPrice: true,
        quantity: true,
      },
    });

    if (!orders.length) {
      const currency = credentials.region === 'eu' ? 'GBP' : 'USD';
      return {
        marketplace: 'amazon',
        sellerId: 'LIVE-SELLER',
        currency,
        period:
          range?.start || range?.end ? 'custom' : 'last_30_days',
        revenue: 0,
        profitMargin: 0,
        unitsSold: 0,
        adSpend: 0,
        totalOrders: 0,
        activeSkus: 0,
        unitsInFba: 0,
        openShipments: 0,
        hasCostData: false,
        orderItemsOrdersCount: 0,
        orderItemsCoveragePct: 1,
        generatedAt: new Date().toISOString(),
      };
    }

    // Deduplicate by marketplace order id in case historical duplicates exist.
    const byOrderId = new Map<
      string,
      { id: string; itemPrice: number; quantity: number }
    >();
    for (const o of orders) {
      const key = o.orderId;
      if (!key) continue;
      if (byOrderId.has(key)) continue;
      byOrderId.set(key, {
        id: o.id,
        itemPrice: Number(o.itemPrice),
        quantity: Number(o.quantity ?? 0),
      });
    }

    const uniqueOrderIds = Array.from(byOrderId.keys());
    const uniqueOrderDbIds = Array.from(byOrderId.values()).map((v) => v.id);
    const totalOrders = uniqueOrderIds.length;
    const revenue = uniqueOrderIds.reduce((sum, id) => {
      const o = byOrderId.get(id);
      if (!o) return sum;
      const itemPrice = Number.isFinite(o.itemPrice) ? o.itemPrice : 0;
      const qty = Number.isFinite(o.quantity) ? o.quantity : 0;
      return sum + itemPrice * qty;
    }, 0);
    const unitsSold = uniqueOrderIds.reduce((sum, id) => {
      const o = byOrderId.get(id);
      if (!o) return sum;
      const qty = Number.isFinite(o.quantity) ? o.quantity : 0;
      return sum + qty;
    }, 0);

    const adSpend = 0;

    const toNumber = (value: unknown): number => {
      if (value == null) return 0;
      if (typeof value === 'number') return value;
      if (typeof value === 'string') return Number(value);
      if (typeof value === 'bigint') return Number(value);
      if (typeof value === 'object') {
        const anyVal = value as any;
        if (typeof anyVal.toNumber === 'function') {
          return anyVal.toNumber();
        }
        if (typeof anyVal.toString === 'function') {
          return Number(anyVal.toString());
        }
      }
      return Number(value as any);
    };

    // Compute profit from OrderItem + COGS (immediate, even if COGS was added after the last order sync).
    // This also supports multi-SKU orders because it's line-item based.
    const orderItems = await (this.prisma as any).orderItem.findMany({
      where: {
        userId: { in: userIds },
        marketplace: 'amazon',
        orderDbId: { in: uniqueOrderDbIds },
      },
      select: {
        profit: true,
        revenueTotal: true,
        taxChargedTotal: true,
        amazonFeesTotal: true,
        quantity: true,
        orderId: true,
        orderDbId: true,
        product: {
          select: {
            costOfGoods: true,
          },
        },
      },
    });

    const distinctOrderDbIds = new Set(
      orderItems.map((it: any) => String(it.orderDbId ?? '')).filter(Boolean),
    );
    const orderItemsOrdersCount = distinctOrderDbIds.size;
    const orderItemsCoveragePct =
      totalOrders > 0 ? orderItemsOrdersCount / totalOrders : 1;

    let totalProfit = 0;
    let hasProfitData = false;
    for (const it of orderItems) {
      const existingProfit = it.profit == null ? null : toNumber(it.profit);
      if (existingProfit != null && !Number.isNaN(existingProfit)) {
        totalProfit += existingProfit;
        hasProfitData = true;
        continue;
      }

      const cogsPerUnit =
        it.product?.costOfGoods == null
          ? null
          : toNumber(it.product.costOfGoods);
      if (cogsPerUnit == null || Number.isNaN(cogsPerUnit)) {
        continue;
      }

      const revenueTotal = toNumber(it.revenueTotal ?? 0);
      const taxChargedTotal = toNumber(it.taxChargedTotal ?? 0);
      const amazonFeesTotal = toNumber(it.amazonFeesTotal ?? 0);
      const qty = toNumber(it.quantity ?? 0);
      const cogsTotal =
        cogsPerUnit * (Number.isFinite(qty) && qty > 0 ? qty : 1);

      const computed =
        revenueTotal - taxChargedTotal - cogsTotal + amazonFeesTotal;
      if (!Number.isNaN(computed)) {
        totalProfit += computed;
        hasProfitData = true;
      }
    }

    const currency = credentials.region === 'eu' ? 'GBP' : 'USD';
    // "hasCostData" means we can calculate profit (we found at least one line item with COGS).
    // Note: profit can legitimately sum to 0, so we must not use "totalProfit !== 0" here.
    const hasCostData = hasProfitData || adSpend !== 0;
    const profitMargin = hasCostData && revenue > 0 ? totalProfit / revenue : 0;

    return {
      marketplace: 'amazon',
      sellerId: 'LIVE-SELLER',
      currency,
      period: 'last_30_days',
      revenue,
      profitMargin,
      unitsSold,
      adSpend,
      totalOrders,
      orderItemsOrdersCount,
      orderItemsCoveragePct,
      activeSkus: 0,
      unitsInFba: 0,
      openShipments: 0,
      hasCostData,
      generatedAt: new Date().toISOString(),
    };
  }

  async getSalesTimeSeries(
    orgId: string,
    range?: { start?: string; end?: string },
    preferredUserId?: string,
  ) {
    let credentials: SpApiCredentials;

    try {
      credentials = await this.getAmazonCredentialsForOrg(
        orgId,
        preferredUserId,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw error;
    }

    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const defaultStart = new Date(nowSafe.getTime() - 30 * 24 * 60 * 60 * 1000);

    const startDate = range?.start ? new Date(range.start) : defaultStart;
    const endDate = range?.end ? new Date(range.end) : nowSafe;

    const userIds = await this.getOrgMemberUserIds(orgId);
    const ordersFromDb = await this.prisma.order.findMany({
      where: {
        userId: { in: userIds },
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

    const byDate = new Map<string, { revenue: number; orders: number }>();

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
  async syncRecentOrdersToDb(
    userId: string,
    opts?: { ignoreCursor?: boolean; days?: number },
  ): Promise<void> {
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
    const days = Math.max(1, Math.min(365, Number(opts?.days ?? 30) || 30));
    const defaultStart = new Date(
      nowSafe.getTime() - days * 24 * 60 * 60 * 1000,
    );

    // Use incremental sync cursor when available, but always overlap a bit.
    // This makes the sync "self-healing" when SP-API calls transiently fail (e.g. getOrderItems),
    // because we'll see the same recent orders again next run.
    const overlapMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    const cursor =
      account && (account as any).ordersLastSyncedAt
        ? ((account as any).ordersLastSyncedAt as Date)
        : null;

    const startDate =
      opts?.ignoreCursor === true
        ? defaultStart
        : new Date(
            Math.max(
              defaultStart.getTime(),
              (cursor?.getTime() ?? defaultStart.getTime()) - overlapMs,
            ),
          );

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

    // Best-effort product mapping:
    // - If the order contains exactly one SellerSKU, attach the Order to that Product.
    // - If multiple SKUs, attach to a synthetic "AMAZON_MULTI" Product.
    // - If we can't determine SKUs, attach to a synthetic "AMAZON_GENERIC" Product.
    const genericSku = 'AMAZON_GENERIC';
    const genericProduct = await this.prisma.product.upsert({
      where: {
        userId_sku: {
          userId,
          sku: genericSku,
        },
      },
      update: {},
      create: {
        userId,
        sku: genericSku,
        title: 'Amazon Sales (Generic)',
      },
    });

    const multiSku = 'AMAZON_MULTI';
    const multiProduct = await this.prisma.product.upsert({
      where: {
        userId_sku: {
          userId,
          sku: multiSku,
        },
      },
      update: {},
      create: {
        userId,
        sku: multiSku,
        title: 'Amazon Sales (Multi-SKU)',
      },
    });

    // Helper: recursively sum CurrencyAmount values under a given key name (e.g. FeeAmount).
    const sumCurrencyAmountsByKey = (
      input: unknown,
      keyName: string,
    ): number => {
      if (input == null) return 0;
      if (Array.isArray(input)) {
        return input.reduce(
          (sum, item) => sum + sumCurrencyAmountsByKey(item, keyName),
          0,
        );
      }
      if (typeof input !== 'object') return 0;

      let total = 0;
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (k === keyName && v && typeof v === 'object') {
          const amt = (v as any).CurrencyAmount;
          const n = Number(amt ?? 0);
          if (!Number.isNaN(n)) total += n;
        } else {
          total += sumCurrencyAmountsByKey(v, keyName);
        }
      }
      return total;
    };

    // Avoid re-calling order-items/finances for orders we already have line items for.
    const existingOrderItemOrderIds = new Set<string>(
      (
        await (this.prisma as any).orderItem.findMany({
          where: {
            userId,
            marketplace: 'amazon',
            orderDate: { gte: startDate, lte: nowSafe },
          },
          select: { orderId: true },
        })
      )
        .map((r: any) => String(r.orderId ?? ''))
        .filter(Boolean),
    );

    let orderItemsThrottled = false;
    let financesUnauthorized = false;

    for (const order of orders) {
      const amazonOrderId = order.AmazonOrderId;
      if (!amazonOrderId) {
        // Skip orders without a stable ID.

        continue;
      }

      const rawTotal = parseFloat(order.OrderTotal?.Amount ?? '0');
      const totalAmount = Number.isNaN(rawTotal) ? 0 : rawTotal;

      const quantityRaw =
        (order.NumberOfItemsShipped ?? 0) + (order.NumberOfItemsUnshipped ?? 0);
      let quantity = quantityRaw > 0 ? quantityRaw : 1;

      const itemPrice =
        quantity > 0
          ? Number((totalAmount / quantity).toFixed(2))
          : totalAmount;

      const orderDateStr =
        order.PurchaseDate ??
        order.LatestShipDate ??
        order.EarliestShipDate ??
        nowSafe.toISOString();
      const orderDate = new Date(orderDateStr);
      if (Number.isNaN(orderDate.getTime())) {
        continue;
      }

      const shouldFetchLineItems =
        !orderItemsThrottled && !existingOrderItemOrderIds.has(amazonOrderId);

      // Best-effort enrichment: order-items (tax/shipping charged) + finances (fees).
      // If calls fail (missing role, sandbox limitations, etc.), we keep totals at zero.
      let taxChargedTotal = 0;
      let shippingChargedTotal = 0;
      let amazonFeesTotal = 0;
      let orderItems: any[] = [];

      if (shouldFetchLineItems) {
        try {
          const itemsRes = (await this.spApiClient.getOrderItems(
            credentials,
            amazonOrderId,
          )) as any;
          orderItems = itemsRes?.payload?.OrderItems ?? [];
          // Sum ItemTax and ShippingPrice where present
          for (const item of orderItems) {
            const itemTaxAmt = Number(item?.ItemTax?.Amount ?? 0);
            if (!Number.isNaN(itemTaxAmt)) taxChargedTotal += itemTaxAmt;
            const shipAmt = Number(item?.ShippingPrice?.Amount ?? 0);
            if (!Number.isNaN(shipAmt)) shippingChargedTotal += shipAmt;
          }

          // Prefer item-level quantity when available.
          const qtyFromItems = orderItems.reduce(
            (sum: number, item: any) =>
              sum + Number(item?.QuantityOrdered ?? 0),
            0,
          );
          if (qtyFromItems > 0) {
            quantity = qtyFromItems;
          }
        } catch (err: any) {
          // If we hit 429 once, stop calling orderItems for the remainder of this run.
          const status = err?.statusCode ?? err?.status ?? null;
          const body = typeof err?.message === 'string' ? err.message : '';
          if (
            status === 429 ||
            body.includes('(429)') ||
            body.includes('QuotaExceeded')
          ) {
            orderItemsThrottled = true;
          }

          // Non-fatal; leave zeros.
          console.warn(
            '[AmazonService.syncRecentOrdersToDb] getOrderItems failed',
            {
              userId,
              amazonOrderId,
              err,
              throttled: orderItemsThrottled,
            },
          );
        }
      }

      // Parse fees from Finances API into per-item allocations when possible.
      const feeByOrderItemId = new Map<string, number>();
      const feeBySku = new Map<string, number>();

      const addFee = (
        map: Map<string, number>,
        key: string,
        amount: number,
      ) => {
        if (!key) return;
        const prev = map.get(key) ?? 0;
        map.set(key, prev + amount);
      };

      const sumFeeComponentList = (list: any[] | undefined): number => {
        if (!Array.isArray(list)) return 0;
        return list.reduce((sum, fc) => {
          const n = Number(fc?.FeeAmount?.CurrencyAmount ?? 0);
          return Number.isNaN(n) ? sum : sum + n;
        }, 0);
      };

      if (!financesUnauthorized && shouldFetchLineItems) {
        try {
          const finRes = (await this.spApiClient.listFinancialEventsByOrderId(
            credentials,
            amazonOrderId,
            { maxResultsPerPage: 100 },
          )) as any;
          // Sum all FeeAmount CurrencyAmount occurrences (usually negative for fees).
          amazonFeesTotal = sumCurrencyAmountsByKey(finRes, 'FeeAmount');

          const events = finRes?.payload?.FinancialEvents ?? {};
          const shipmentLists = [
            ...(events?.ShipmentEventList ?? []),
            ...(events?.RefundEventList ?? []),
            ...(events?.ChargebackEventList ?? []),
            ...(events?.GuaranteeClaimEventList ?? []),
          ];

          for (const ev of shipmentLists) {
            const items = ev?.ShipmentItemList ?? [];
            for (const si of items) {
              const fee =
                sumFeeComponentList(si?.ItemFeeList) +
                sumFeeComponentList(si?.ItemFeeAdjustmentList);
              const orderItemId = si?.OrderItemId as string | undefined;
              const sku = si?.SellerSKU as string | undefined;
              if (fee !== 0) {
                if (orderItemId) addFee(feeByOrderItemId, orderItemId, fee);
                if (sku) addFee(feeBySku, sku, fee);
              }
            }
          }
        } catch (err: any) {
          const status = err?.statusCode ?? err?.status ?? null;
          const msg = typeof err?.message === 'string' ? err.message : '';
          if (
            status === 403 ||
            msg.includes('(403)') ||
            msg.includes('"code": "Unauthorized"') ||
            msg.includes('Access to requested resource is denied')
          ) {
            financesUnauthorized = true;
          }

          // Non-fatal; leave zeros.
          console.warn(
            '[AmazonService.syncRecentOrdersToDb] listFinancialEventsByOrderId failed',
            { userId, amazonOrderId, err, financesUnauthorized },
          );
        }
      }

      // Determine the product/SKU to associate with this order (order-level; line-items handled below).
      let selectedSku = genericSku;
      let selectedAsin: string | null = null;
      let selectedProduct = genericProduct;

      const skus = orderItems
        .map((item: any) => item?.SellerSKU)
        .filter(Boolean) as string[];
      const uniqueSkus = Array.from(new Set(skus));
      if (uniqueSkus.length === 1) {
        selectedSku = uniqueSkus[0];
        const asinFromItem =
          (orderItems[0]?.ASIN as string | undefined) ??
          (orderItems[0]?.Asin as string | undefined);
        selectedAsin = asinFromItem ?? null;
        const titleFromItemRaw = orderItems[0]?.Title;
        const titleFromItem =
          typeof titleFromItemRaw === 'string' && titleFromItemRaw.trim()
            ? titleFromItemRaw.trim()
            : null;

        selectedProduct = await this.prisma.product.upsert({
          where: {
            userId_sku: {
              userId,
              sku: selectedSku,
            },
          },
          update: {
            asin: selectedAsin ?? undefined,
            title: titleFromItem ?? undefined,
          },
          create: {
            userId,
            sku: selectedSku,
            asin: selectedAsin,
            title: titleFromItem,
          },
        });
      } else if (uniqueSkus.length > 1) {
        selectedSku = multiSku;
        selectedProduct = multiProduct;
      }

      // Compute profit only when we have COGS. We subtract taxes charged (VAT) if available,
      // and include Amazon fees when available. Shipping charged is tracked but not treated
      // as cost here (we don't have actual shipping cost yet).
      const cogsPerUnit = selectedProduct.costOfGoods
        ? Number(selectedProduct.costOfGoods)
        : null;
      const cogsTotal = cogsPerUnit != null ? cogsPerUnit * quantity : null;
      const computedTotalProfit =
        cogsTotal != null
          ? totalAmount - taxChargedTotal - cogsTotal + amazonFeesTotal
          : null;

      const feesJson = {
        source: 'spapi',
        taxChargedTotal,
        shippingChargedTotal,
        amazonFeesTotal,
        itemSkus: uniqueSkus,
        // Keep rawResponse separate; avoid storing large payloads here.
        computedAt: new Date().toISOString(),
      };

      const updateData: any = {
        userId,
        productId: selectedProduct.id,
        sku: selectedSku,
        quantity,
        itemPrice,
        fees: feesJson,
        rawResponse: order,
        orderDate,
        asin: selectedAsin,
      };
      if (computedTotalProfit != null) {
        updateData.totalProfit = Number(computedTotalProfit.toFixed(2));
      }

      const createData: any = {
        userId,
        productId: selectedProduct.id,
        orderId: amazonOrderId,
        marketplace: 'amazon',
        sku: selectedSku,
        asin: selectedAsin,
        quantity,
        itemPrice,
        fees: feesJson,
        rawResponse: order,
        orderDate,
        totalProfit:
          computedTotalProfit != null
            ? Number(computedTotalProfit.toFixed(2))
            : null,
      };

      const persistedOrder = await (this.prisma as any).order.upsert({
        where: {
          userId_orderId_marketplace: {
            userId,
            orderId: amazonOrderId,
            marketplace: 'amazon',
          },
        } as any,
        update: updateData,
        create: createData,
      });

      // Persist accurate line items for per-product profitability.
      // If we don't have orderItems (e.g. call failed), we skip creating OrderItem rows.
      if (orderItems.length > 0) {
        // Compute total item revenue for proportional allocations when needed.
        const itemRevenues = orderItems.map((it: any) => {
          const revenue = Number(it?.ItemPrice?.Amount ?? 0);
          return Number.isNaN(revenue) ? 0 : revenue;
        });
        const totalItemRevenue = itemRevenues.reduce((a, b) => a + b, 0);

        for (let idx = 0; idx < orderItems.length; idx++) {
          const it = orderItems[idx];
          const orderItemId = String(it?.OrderItemId ?? '');
          const sku = String(it?.SellerSKU ?? '');
          const asin = (it?.ASIN as string | undefined) ?? null;
          const titleRaw = it?.Title;
          const itemTitle =
            typeof titleRaw === 'string' && titleRaw.trim()
              ? titleRaw.trim()
              : null;

          const qty = Number(it?.QuantityOrdered ?? 0);
          const quantityOrdered = qty > 0 ? qty : 1;

          const revenueTotal = itemRevenues[idx] ?? 0;
          const shippingCharged = Number(it?.ShippingPrice?.Amount ?? 0);
          const taxCharged = Number(it?.ItemTax?.Amount ?? 0);

          // Per-item fee allocation:
          // - Prefer Finances item-level fees by OrderItemId.
          // - Fall back to SKU mapping.
          // - Otherwise allocate proportionally by revenue.
          let itemFees = 0;
          if (orderItemId && feeByOrderItemId.has(orderItemId)) {
            itemFees = feeByOrderItemId.get(orderItemId) ?? 0;
          } else if (sku && feeBySku.has(sku)) {
            itemFees = feeBySku.get(sku) ?? 0;
          } else if (totalItemRevenue > 0 && amazonFeesTotal !== 0) {
            itemFees = (revenueTotal / totalItemRevenue) * amazonFeesTotal;
          }

          // Attach to a real product for this SKU.
          const itemProduct = sku
            ? await this.prisma.product.upsert({
                where: { userId_sku: { userId, sku } },
                update: {
                  asin: asin ?? undefined,
                  title: itemTitle ?? undefined,
                },
                create: { userId, sku, asin, title: itemTitle },
              })
            : genericProduct;

          const cogsPerUnit = itemProduct.costOfGoods
            ? Number(itemProduct.costOfGoods)
            : null;
          const cogsTotal =
            cogsPerUnit != null ? cogsPerUnit * quantityOrdered : null;
          const profit =
            cogsTotal != null
              ? revenueTotal - taxCharged - cogsTotal + itemFees
              : null;

          await (this.prisma as any).orderItem.upsert({
            where: {
              orderDbId_orderItemId: {
                orderDbId: persistedOrder.id,
                orderItemId,
              },
            },
            update: {
              userId,
              productId: itemProduct.id,
              marketplace: 'amazon',
              orderId: amazonOrderId,
              sku: sku || genericSku,
              asin,
              quantity: quantityOrdered,
              revenueTotal,
              shippingChargedTotal: Number.isNaN(shippingCharged)
                ? 0
                : shippingCharged,
              taxChargedTotal: Number.isNaN(taxCharged) ? 0 : taxCharged,
              amazonFeesTotal: Number.isNaN(itemFees)
                ? 0
                : Number(itemFees.toFixed(2)),
              cogsTotal,
              profit: profit != null ? Number(profit.toFixed(2)) : null,
              rawResponse: it,
              orderDate,
            },
            create: {
              userId,
              orderDbId: persistedOrder.id,
              productId: itemProduct.id,
              marketplace: 'amazon',
              orderId: amazonOrderId,
              orderItemId,
              sku: sku || genericSku,
              asin,
              quantity: quantityOrdered,
              revenueTotal,
              shippingChargedTotal: Number.isNaN(shippingCharged)
                ? 0
                : shippingCharged,
              taxChargedTotal: Number.isNaN(taxCharged) ? 0 : taxCharged,
              amazonFeesTotal: Number.isNaN(itemFees)
                ? 0
                : Number(itemFees.toFixed(2)),
              cogsTotal,
              profit: profit != null ? Number(profit.toFixed(2)) : null,
              rawResponse: it,
              orderDate,
            },
          });
        }
      }
    }

    // Backfill any missing line items for orders in the window.
    // This is important because:
    // - getOrders is incremental (cursor-based) and may not keep returning older orders
    // - getOrderItems can be rate-limited (429), so some orders won't get items on the first pass
    //
    // We retry a small number per run to stay under quotas.
    try {
      const missingOrders = await this.prisma.order.findMany({
        where: {
          userId,
          marketplace: 'amazon',
          orderDate: { gte: defaultStart, lte: nowSafe },
          orderItems: { none: {} },
        },
        select: {
          id: true,
          orderId: true,
          orderDate: true,
        },
        orderBy: { orderDate: 'desc' },
        take: 5,
      });

      for (const ord of missingOrders) {
        if (!ord.orderId) continue;
        try {
          const itemsRes = (await this.spApiClient.getOrderItems(
            credentials,
            ord.orderId,
          )) as any;
          const items = itemsRes?.payload?.OrderItems ?? [];
          if (!Array.isArray(items) || items.length === 0) continue;

          for (const it of items) {
            const orderItemId = String(it?.OrderItemId ?? '');
            const sku = String(it?.SellerSKU ?? '');
            const asin = (it?.ASIN as string | undefined) ?? null;
            const qty = Number(it?.QuantityOrdered ?? 0);
            const quantityOrdered = qty > 0 ? qty : 1;
            const revenue = Number(it?.ItemPrice?.Amount ?? 0);
            const revenueTotal = Number.isNaN(revenue) ? 0 : revenue;
            const shippingCharged = Number(it?.ShippingPrice?.Amount ?? 0);
            const taxCharged = Number(it?.ItemTax?.Amount ?? 0);

            const itemProduct = sku
              ? await this.prisma.product.upsert({
                  where: { userId_sku: { userId, sku } },
                  update: {
                    asin: asin ?? undefined,
                    title:
                      typeof it?.Title === 'string' && it.Title.trim()
                        ? it.Title.trim()
                        : undefined,
                  },
                  create: {
                    userId,
                    sku,
                    asin,
                    title:
                      typeof it?.Title === 'string' && it.Title.trim()
                        ? it.Title.trim()
                        : null,
                  },
                })
              : genericProduct;

            await (this.prisma as any).orderItem.upsert({
              where: {
                orderDbId_orderItemId: {
                  orderDbId: ord.id,
                  orderItemId,
                },
              },
              update: {
                userId,
                productId: itemProduct.id,
                marketplace: 'amazon',
                orderId: ord.orderId,
                orderItemId,
                sku: sku || genericSku,
                asin,
                quantity: quantityOrdered,
                revenueTotal,
                shippingChargedTotal: Number.isNaN(shippingCharged)
                  ? 0
                  : shippingCharged,
                taxChargedTotal: Number.isNaN(taxCharged) ? 0 : taxCharged,
                amazonFeesTotal: 0,
                cogsTotal: null,
                profit: null,
                rawResponse: it,
                orderDate: ord.orderDate,
              },
              create: {
                userId,
                orderDbId: ord.id,
                productId: itemProduct.id,
                marketplace: 'amazon',
                orderId: ord.orderId,
                orderItemId,
                sku: sku || genericSku,
                asin,
                quantity: quantityOrdered,
                revenueTotal,
                shippingChargedTotal: Number.isNaN(shippingCharged)
                  ? 0
                  : shippingCharged,
                taxChargedTotal: Number.isNaN(taxCharged) ? 0 : taxCharged,
                amazonFeesTotal: 0,
                cogsTotal: null,
                profit: null,
                rawResponse: it,
                orderDate: ord.orderDate,
              },
            });
          }
        } catch (err: any) {
          const status = err?.statusCode ?? err?.status ?? null;
          const msg = typeof err?.message === 'string' ? err.message : '';
          if (
            status === 429 ||
            msg.includes('(429)') ||
            msg.includes('QuotaExceeded')
          ) {
            break; // stop retrying more orders this run
          }
          // ignore other errors; we'll retry next run
        }
      }
    } catch {
      // non-fatal
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
   * Revenue, units, orders: from itemPrice × quantity. Profit: summed from
   * Order.totalProfit when present; cost/fee fields stay zero until wired.
   */
  async recomputeDailyKpiSummary(userId: string): Promise<void> {
    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const startDate = new Date(nowSafe.getTime() - 30 * 24 * 60 * 60 * 1000);

    const orders = await this.prisma.order.findMany({
      where: {
        userId,
        marketplace: 'amazon',
        orderDate: {
          gte: startDate,
          lte: nowSafe,
        },
      },
      select: {
        orderDate: true,
        marketplace: true,
        itemPrice: true,
        quantity: true,
        totalProfit: true,
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
        profit: number;
      }
    >();

    for (const order of orders) {
      const d = order.orderDate;
      const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
      const marketplace = order.marketplace;
      const fulfilmentChannel = 'UNKNOWN';
      const key = `${dateStr}|${marketplace}|${fulfilmentChannel}`;

      const existing = byKey.get(key) ?? {
        date: dateStr,
        marketplace,
        fulfilmentChannel,
        revenue: 0,
        unitsSold: 0,
        ordersCount: 0,
        profit: 0,
      };

      const itemPriceNum = Number(order.itemPrice);
      const quantityNum = order.quantity;

      existing.revenue += itemPriceNum * quantityNum;
      existing.unitsSold += quantityNum;
      existing.ordersCount += 1;
      existing.profit += Number(order.totalProfit ?? 0);

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
          profit: value.profit,
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
          profit: value.profit,
          roiPct: 0,
          marginPct: 0,
        },
      });
    }
  }

  /**
   * Dev-only: set totalProfit on an order belonging to the user, then recompute
   * daily KPIs. Use this to test the profit pipeline (e.g. seed a few orders
   * with profit, then refresh the dashboard).
   */
  async setOrderProfit(
    userId: string,
    orderId: string,
    totalProfit: number,
  ): Promise<{ updated: number }> {
    const result = await this.prisma.order.updateMany({
      where: {
        userId,
        orderId,
        marketplace: 'amazon',
      },
      data: { totalProfit },
    });
    if (result.count === 0) {
      throw new NotFoundException(
        `Order ${orderId} not found or not owned by user`,
      );
    }
    await this.recomputeDailyKpiSummary(userId);
    return { updated: result.count };
  }

  async getTopProfitableProducts(orgId: string, limit = 10) {
    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const startDate = new Date(nowSafe.getTime() - 30 * 24 * 60 * 60 * 1000);
    const userIds = await this.getOrgMemberUserIds(orgId);

    // Use OrderItem rows for accurate per-product totals.
    const rows = await (this.prisma as any).orderItem.groupBy({
      by: ['productId'],
      where: {
        userId: { in: userIds },
        marketplace: 'amazon',
        orderDate: { gte: startDate, lte: nowSafe },
        // Only rank by profit where we actually have profit computed
        profit: { not: null },
      },
      _sum: {
        revenueTotal: true,
        profit: true,
        quantity: true,
      },
      _count: {
        _all: true,
      },
      orderBy: {
        _sum: { profit: 'desc' },
      },
      take: limit,
    });

    const productIds = rows.map((r: any) => r.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, sku: true, asin: true, title: true, imageUrl: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    return rows.map((r: any) => {
      const p = byId.get(r.productId);
      return {
        productId: r.productId,
        sku: p?.sku ?? null,
        asin: p?.asin ?? null,
        title: p?.title ?? null,
        imageUrl: p?.imageUrl ?? null,
        units: Number(r._sum?.quantity ?? 0),
        revenue: Number(r._sum?.revenueTotal ?? 0),
        profit: Number(r._sum?.profit ?? 0),
        // Profit margin for this product over the window
        marginPct:
          Number(r._sum?.revenueTotal ?? 0) > 0
            ? Number(r._sum?.profit ?? 0) / Number(r._sum?.revenueTotal ?? 0)
            : 0,
        lineItemsCount: r._count?._all ?? 0,
      };
    });
  }

  async listProducts(orgId: string) {
    const userIds = await this.getOrgMemberUserIds(orgId);
    const products = await this.prisma.product.findMany({
      where: { userId: { in: userIds } },
      orderBy: [{ updatedAt: 'desc' }],
      select: {
        id: true,
        sku: true,
        asin: true,
        title: true,
        imageUrl: true,
        costOfGoods: true,
        updatedAt: true,
      },
    });
    return products.map((p) => ({
      ...p,
      costOfGoods: p.costOfGoods == null ? null : Number(p.costOfGoods),
    }));
  }

  async updateProductCostOfGoods(
    orgId: string,
    productId: string,
    costOfGoods: number | null,
  ) {
    const userIds = await this.getOrgMemberUserIds(orgId);
    const result = await this.prisma.product.updateMany({
      where: { id: productId, userId: { in: userIds } },
      data: { costOfGoods },
    });
    if (result.count === 0) {
      throw new NotFoundException('Product not found in org');
    }
    const updated = await this.prisma.product.findFirst({
      where: { id: productId, userId: { in: userIds } },
      select: {
        id: true,
        userId: true,
        sku: true,
        asin: true,
        title: true,
        imageUrl: true,
        costOfGoods: true,
        updatedAt: true,
      },
    });
    if (!updated) {
      throw new NotFoundException('Product not found in org');
    }

    // Profit freshness:
    // If COGS changes, recompute profit for existing OrderItem rows for this product.
    // This ensures dashboards and "top profitable products" update immediately without
    // requiring a re-sync of Amazon orders.
    try {
      const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
      const startDate = new Date(nowSafe.getTime() - 365 * 24 * 60 * 60 * 1000);

      const cogsPerUnit =
        updated.costOfGoods == null ? null : Number(updated.costOfGoods);

      const orderItems = await (this.prisma as any).orderItem.findMany({
        where: {
          userId: updated.userId,
          productId: updated.id,
          marketplace: 'amazon',
          orderDate: { gte: startDate, lte: nowSafe },
        },
        select: {
          id: true,
          orderDbId: true,
          quantity: true,
          revenueTotal: true,
          taxChargedTotal: true,
          amazonFeesTotal: true,
        },
      });

      const orderDbIds = new Set<string>();

      for (const it of orderItems) {
        orderDbIds.add(it.orderDbId);

        const qty = Number(it.quantity ?? 0);
        const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 1;

        const revenueTotal = Number(it.revenueTotal ?? 0);
        const taxChargedTotal = Number(it.taxChargedTotal ?? 0);
        const amazonFeesTotal = Number(it.amazonFeesTotal ?? 0);

        const cogsTotal =
          cogsPerUnit == null || Number.isNaN(cogsPerUnit)
            ? null
            : cogsPerUnit * safeQty;

        const profit =
          cogsTotal == null
            ? null
            : revenueTotal - taxChargedTotal - cogsTotal + amazonFeesTotal;

        await (this.prisma as any).orderItem.update({
          where: { id: it.id },
          data: {
            cogsTotal: cogsTotal == null ? null : Number(cogsTotal.toFixed(2)),
            profit: profit == null ? null : Number(profit.toFixed(2)),
          },
        });
      }

      // Update Order.totalProfit for affected orders:
      // set to sum(profit) only when *all* items in the order have profit computed; otherwise null.
      for (const orderDbId of orderDbIds) {
        const items = await (this.prisma as any).orderItem.findMany({
          where: { orderDbId },
          select: { profit: true },
        });
        const profits = items.map((x: any) =>
          x.profit == null ? null : Number(x.profit),
        );
        const allKnown = profits.length > 0 && profits.every((p) => p != null);
        const total = allKnown
          ? profits.reduce((sum, p) => sum + Number(p ?? 0), 0)
          : null;

        await this.prisma.order.update({
          where: { id: orderDbId },
          data: {
            totalProfit: total == null ? null : Number(total.toFixed(2)),
          },
        });
      }

      // Refresh daily aggregates for this user so any KPI-based screens stay in sync.
      await this.recomputeDailyKpiSummary(updated.userId);
    } catch (err) {
      // Non-fatal: COGS update succeeded; profit recompute can be retried later.
      console.warn(
        '[AmazonService.updateProductCostOfGoods] profit recompute failed',
        {
          productId: updated.id,
          err,
        },
      );
    }

    return {
      ...updated,
      costOfGoods:
        updated.costOfGoods == null ? null : Number(updated.costOfGoods),
    };
  }

  async listInventory(orgId: string) {
    const userIds = await this.getOrgMemberUserIds(orgId);
    const rows = await this.prisma.product.findMany({
      where: { userId: { in: userIds } },
      orderBy: [{ updatedAt: 'desc' }],
      select: {
        id: true,
        sku: true,
        asin: true,
        title: true,
        imageUrl: true,
        updatedAt: true,
        inventory: {
          select: {
            currentQty: true,
            updatedAt: true,
          },
        },
      },
    });

    return rows.map((p) => ({
      productId: p.id,
      sku: p.sku,
      asin: p.asin,
      title: p.title,
      imageUrl: p.imageUrl,
      productUpdatedAt: p.updatedAt,
      fbaFulfillableQty: p.inventory?.currentQty ?? null,
      inventoryUpdatedAt: p.inventory?.updatedAt ?? null,
    }));
  }

  /**
   * Fetch FBA inventory summaries from SP-API and upsert Inventory rows
   * for products we already know about in this org (matched by SKU).
   */
  async syncFbaInventory(orgId: string, preferredUserId?: string) {
    const credentials = await this.getAmazonCredentialsForOrg(
      orgId,
      preferredUserId,
    );
    const userIds = await this.getOrgMemberUserIds(orgId);

    const products = await this.prisma.product.findMany({
      where: { userId: { in: userIds } },
      select: { id: true, userId: true, sku: true },
    });
    const bySku = new Map<string, { id: string; userId: string }>();
    for (const p of products) {
      if (!bySku.has(p.sku)) bySku.set(p.sku, { id: p.id, userId: p.userId });
    }

    let marketplaceIds =
      credentials.region === 'eu'
        ? [
            'A1F83G8C2ARO7P', // UK
            'A1PA6795UKMFR9', // DE
            'A13V1IB3VIYZZH', // FR
            'APJ6JRA9NG5V4', // IT
            'A1RKKUPIHCS9HS', // ES
          ]
        : ['ATVPDKIKX0DER']; // US

    // Attempt to fetch actual participations (best-effort).
    try {
      const res = (await this.spApiClient.getMarketplaceParticipations(
        credentials,
      )) as any;
      const payload = res?.payload ?? res?.Payload ?? res ?? {};
      const list: any[] = payload?.payload ?? payload?.Payload ?? payload ?? [];
      const ids = Array.isArray(list)
        ? list
            .map((p) => p?.marketplace?.id ?? p?.Marketplace?.Id ?? null)
            .filter((v): v is string => typeof v === 'string' && v.length > 0)
        : [];
      if (ids.length) {
        marketplaceIds = Array.from(new Set(ids));
      }
    } catch {
      // ignore; fall back to region defaults
    }

    let marketplacesProcessed = 0;
    let inventorySummariesSeen = 0;
    let matchedSkus = 0;
    let upsertedInventoryRows = 0;
    let skippedUnknownSku = 0;
    const marketplaceErrors: Array<{ marketplaceId: string; error: string }> =
      [];
    let marketplacesWithSuccessfulResponse = 0;

    try {
      for (const marketplaceId of marketplaceIds) {
        marketplacesProcessed += 1;
        let nextToken: string | undefined = undefined;

        // Paginate until exhausted
        while (true) {
          let res: any;
          try {
            res = (await this.spApiClient.getFbaInventorySummaries(
              credentials,
              {
                marketplaceId,
                details: true,
                nextToken,
              },
            )) as any;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // If a single marketplace is denied, skip it and continue trying others.
            if (
              msg.includes('/fba/inventory/v1/summaries') &&
              msg.includes('(403)') &&
              msg
                .toLowerCase()
                .includes('access to requested resource is denied')
            ) {
              marketplaceErrors.push({ marketplaceId, error: msg });
              break;
            }
            throw e;
          }

          // If we got here, this marketplace returned a 2xx response at least once.
          if (nextToken === undefined) {
            marketplacesWithSuccessfulResponse += 1;
          }

          const payload = res?.payload ?? res?.Payload ?? res ?? {};
          const summaries: any[] =
            payload?.inventorySummaries ??
            payload?.InventorySummaries ??
            payload?.summaries ??
            [];

          inventorySummariesSeen += summaries.length;

          for (const s of summaries) {
            const sku: string | undefined =
              s?.sellerSku ?? s?.SellerSku ?? s?.sellerSKU ?? s?.SellerSKU;
            if (!sku) continue;

            const match = bySku.get(sku);
            if (!match) {
              skippedUnknownSku += 1;
              continue;
            }

            matchedSkus += 1;

            const qtyRaw =
              s?.inventoryDetails?.fulfillableQuantity ??
              s?.inventoryDetails?.fulfillable ??
              s?.inventoryDetails?.afnFulfillableQuantity ??
              s?.totalQuantity ??
              s?.TotalQuantity ??
              0;
            const qty = Math.max(0, Number(qtyRaw) || 0);

            await this.prisma.inventory.upsert({
              where: { productId: match.id },
              update: {
                userId: match.userId,
                currentQty: qty,
              },
              create: {
                userId: match.userId,
                productId: match.id,
                currentQty: qty,
              },
            });
            upsertedInventoryRows += 1;
          }

          const token: string | undefined =
            payload?.nextToken ??
            payload?.NextToken ??
            payload?.next_token ??
            undefined;

          if (!token) break;
          nextToken = token;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes('/fba/inventory/v1/summaries') &&
        msg.includes('(403)') &&
        msg.toLowerCase().includes('access to requested resource is denied')
      ) {
        throw new ForbiddenException(
          'Amazon denied access to FBA Inventory. Enable the SP-API role "Product Listing" or "Amazon Fulfillment" for your app, then re-authorize your seller account and try again.',
        );
      }
      throw e;
    }

    // If every marketplace was denied, raise the friendly forbidden error.
    if (
      marketplacesWithSuccessfulResponse === 0 &&
      marketplaceErrors.length > 0
    ) {
      throw new ForbiddenException(
        'Amazon denied access to FBA Inventory. Enable the SP-API role "Product Listing" or "Amazon Fulfillment" for your app, then re-authorize your seller account and try again.',
      );
    }

    // Ensure all known products have an Inventory row after a successful sync.
    // This prevents "—" for SKUs that simply weren't returned in the summaries.
    if (marketplacesWithSuccessfulResponse > 0) {
      for (const p of products) {
        await this.prisma.inventory.upsert({
          where: { productId: p.id },
          update: { userId: p.userId, currentQty: 0 },
          create: { userId: p.userId, productId: p.id, currentQty: 0 },
        });
      }
    }

    return {
      region: credentials.region,
      marketplacesProcessed,
      marketplacesWithSuccessfulResponse,
      inventorySummariesSeen,
      matchedSkus,
      upsertedInventoryRows,
      skippedUnknownSku,
      marketplaceErrorsCount: marketplaceErrors.length,
    };
  }

  /**
   * Dev-only: populate OrderItem rows for existing Orders (last 30 days).
   * Useful when Orders were already synced before OrderItem existed, or when
   * a sync run fetches 0 new orders (cursor advanced) and therefore doesn't
   * call getOrderItems/Finances again.
   */
  async backfillOrderItems(userId: string, days = 30) {
    const credentials = await this.getAmazonCredentialsForUser(userId);

    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const startDate = new Date(nowSafe.getTime() - days * 24 * 60 * 60 * 1000);

    const orders = await this.prisma.order.findMany({
      where: {
        userId,
        marketplace: 'amazon',
        orderDate: { gte: startDate, lte: nowSafe },
      },
      select: {
        id: true, // DB id
        orderId: true, // marketplace order id
        orderDate: true,
      },
      orderBy: { orderDate: 'desc' },
    });

    let processedOrders = 0;
    let upsertedItems = 0;
    let skippedNoItems = 0;

    for (const ord of orders) {
      const amazonOrderId = ord.orderId;
      let orderItems: any[] = [];

      try {
        const itemsRes = (await this.spApiClient.getOrderItems(
          credentials,
          amazonOrderId,
        )) as any;
        orderItems = itemsRes?.payload?.OrderItems ?? [];
      } catch (err) {
        console.warn(
          '[AmazonService.backfillOrderItems] getOrderItems failed',
          {
            userId,
            amazonOrderId,
            err,
          },
        );
        orderItems = [];
      }

      if (orderItems.length === 0) {
        skippedNoItems += 1;
        continue;
      }

      // Best-effort fees from Finances; fall back to 0 / proportional allocation.
      let amazonFeesTotal = 0;
      const feeByOrderItemId = new Map<string, number>();
      const feeBySku = new Map<string, number>();
      const addFee = (
        map: Map<string, number>,
        key: string,
        amount: number,
      ) => {
        if (!key) return;
        map.set(key, (map.get(key) ?? 0) + amount);
      };
      const sumFeeComponentList = (list: any[] | undefined): number => {
        if (!Array.isArray(list)) return 0;
        return list.reduce((sum, fc) => {
          const n = Number(fc?.FeeAmount?.CurrencyAmount ?? 0);
          return Number.isNaN(n) ? sum : sum + n;
        }, 0);
      };

      try {
        const finRes = (await this.spApiClient.listFinancialEventsByOrderId(
          credentials,
          amazonOrderId,
          { maxResultsPerPage: 100 },
        )) as any;

        const sumCurrencyAmountsByKey = (
          input: unknown,
          keyName: string,
        ): number => {
          if (input == null) return 0;
          if (Array.isArray(input)) {
            return input.reduce(
              (sum, item) => sum + sumCurrencyAmountsByKey(item, keyName),
              0,
            );
          }
          if (typeof input !== 'object') return 0;
          let total = 0;
          for (const [k, v] of Object.entries(
            input as Record<string, unknown>,
          )) {
            if (k === keyName && v && typeof v === 'object') {
              const amt = (v as any).CurrencyAmount;
              const n = Number(amt ?? 0);
              if (!Number.isNaN(n)) total += n;
            } else {
              total += sumCurrencyAmountsByKey(v, keyName);
            }
          }
          return total;
        };

        amazonFeesTotal = sumCurrencyAmountsByKey(finRes, 'FeeAmount');

        const events = finRes?.payload?.FinancialEvents ?? {};
        const shipmentLists = [
          ...(events?.ShipmentEventList ?? []),
          ...(events?.RefundEventList ?? []),
          ...(events?.ChargebackEventList ?? []),
          ...(events?.GuaranteeClaimEventList ?? []),
        ];
        for (const ev of shipmentLists) {
          const items = ev?.ShipmentItemList ?? [];
          for (const si of items) {
            const fee =
              sumFeeComponentList(si?.ItemFeeList) +
              sumFeeComponentList(si?.ItemFeeAdjustmentList);
            const orderItemId = si?.OrderItemId as string | undefined;
            const sku = si?.SellerSKU as string | undefined;
            if (fee !== 0) {
              if (orderItemId) addFee(feeByOrderItemId, orderItemId, fee);
              if (sku) addFee(feeBySku, sku, fee);
            }
          }
        }
      } catch (err) {
        console.warn(
          '[AmazonService.backfillOrderItems] listFinancialEventsByOrderId failed',
          { userId, amazonOrderId, err },
        );
      }

      const itemRevenues = orderItems.map((it: any) => {
        const revenue = Number(it?.ItemPrice?.Amount ?? 0);
        return Number.isNaN(revenue) ? 0 : revenue;
      });
      const totalItemRevenue = itemRevenues.reduce((a, b) => a + b, 0);

      for (let idx = 0; idx < orderItems.length; idx++) {
        const it = orderItems[idx];
        const orderItemId = String(it?.OrderItemId ?? '');
        const sku = String(it?.SellerSKU ?? '');
        const asin = (it?.ASIN as string | undefined) ?? null;
        const titleRaw = it?.Title;
        const itemTitle =
          typeof titleRaw === 'string' && titleRaw.trim()
            ? titleRaw.trim()
            : null;

        const qty = Number(it?.QuantityOrdered ?? 0);
        const quantityOrdered = qty > 0 ? qty : 1;

        const revenueTotal = itemRevenues[idx] ?? 0;
        const shippingCharged = Number(it?.ShippingPrice?.Amount ?? 0);
        const taxCharged = Number(it?.ItemTax?.Amount ?? 0);

        let itemFees = 0;
        if (orderItemId && feeByOrderItemId.has(orderItemId)) {
          itemFees = feeByOrderItemId.get(orderItemId) ?? 0;
        } else if (sku && feeBySku.has(sku)) {
          itemFees = feeBySku.get(sku) ?? 0;
        } else if (totalItemRevenue > 0 && amazonFeesTotal !== 0) {
          itemFees = (revenueTotal / totalItemRevenue) * amazonFeesTotal;
        }

        const itemProduct = sku
          ? await this.prisma.product.upsert({
              where: { userId_sku: { userId, sku } },
              update: {
                asin: asin ?? undefined,
                title: itemTitle ?? undefined,
              },
              create: { userId, sku, asin, title: itemTitle },
            })
          : await this.prisma.product.upsert({
              where: { userId_sku: { userId, sku: 'AMAZON_GENERIC' } },
              update: {},
              create: {
                userId,
                sku: 'AMAZON_GENERIC',
                title: 'Amazon Sales (Generic)',
              },
            });

        const cogsPerUnit = itemProduct.costOfGoods
          ? Number(itemProduct.costOfGoods)
          : null;
        const cogsTotal =
          cogsPerUnit != null ? cogsPerUnit * quantityOrdered : null;
        const profit =
          cogsTotal != null
            ? revenueTotal - taxCharged - cogsTotal + itemFees
            : null;

        await (this.prisma as any).orderItem.upsert({
          where: {
            orderDbId_orderItemId: {
              orderDbId: ord.id,
              orderItemId,
            },
          },
          update: {
            userId,
            productId: itemProduct.id,
            marketplace: 'amazon',
            orderId: amazonOrderId,
            sku: sku || 'AMAZON_GENERIC',
            asin,
            quantity: quantityOrdered,
            revenueTotal,
            shippingChargedTotal: Number.isNaN(shippingCharged)
              ? 0
              : shippingCharged,
            taxChargedTotal: Number.isNaN(taxCharged) ? 0 : taxCharged,
            amazonFeesTotal: Number.isNaN(itemFees)
              ? 0
              : Number(itemFees.toFixed(2)),
            cogsTotal,
            profit: profit != null ? Number(profit.toFixed(2)) : null,
            rawResponse: it,
            orderDate: ord.orderDate,
          },
          create: {
            userId,
            orderDbId: ord.id,
            productId: itemProduct.id,
            marketplace: 'amazon',
            orderId: amazonOrderId,
            orderItemId,
            sku: sku || 'AMAZON_GENERIC',
            asin,
            quantity: quantityOrdered,
            revenueTotal,
            shippingChargedTotal: Number.isNaN(shippingCharged)
              ? 0
              : shippingCharged,
            taxChargedTotal: Number.isNaN(taxCharged) ? 0 : taxCharged,
            amazonFeesTotal: Number.isNaN(itemFees)
              ? 0
              : Number(itemFees.toFixed(2)),
            cogsTotal,
            profit: profit != null ? Number(profit.toFixed(2)) : null,
            rawResponse: it,
            orderDate: ord.orderDate,
          },
        });
        upsertedItems += 1;
      }

      processedOrders += 1;
    }

    return {
      days,
      startDate: startDate.toISOString(),
      endDate: nowSafe.toISOString(),
      processedOrders,
      upsertedItems,
      skippedNoItems,
      totalOrders: orders.length,
    };
  }

  async backfillProductTitles(
    orgId: string,
    limit = 50,
    preferredUserId?: string,
  ) {
    const credentials = await this.getAmazonCredentialsForOrg(
      orgId,
      preferredUserId,
    );

    const unwrapPayload = (input: any): any => {
      // Some SP-API client libs wrap responses as { payload: {...} } or even { payload: { payload: {...} } }.
      // Normalize that so our parsing logic is robust.
      let cur = input;
      for (let i = 0; i < 5; i += 1) {
        if (cur && typeof cur === 'object') {
          if (cur.payload != null) {
            cur = cur.payload;
            continue;
          }
          if (cur.Payload != null) {
            cur = cur.Payload;
            continue;
          }
        }
        break;
      }
      return cur ?? {};
    };

    // Prefer the seller's actual marketplace participations; titles are marketplace-scoped.
    // If we query the wrong marketplace ID, Catalog Items often returns 200 with empty summaries.
    let marketplaceIds =
      credentials.region === 'eu'
        ? [
            'A1F83G8C2ARO7P', // UK
            'A1PA6795UKMFR9', // DE
            'A13V1IB3VIYZZH', // FR
            'APJ6JRA9NG5V4', // IT
            'A1RKKUPIHCS9HS', // ES
          ]
        : ['ATVPDKIKX0DER']; // US

    try {
      const res = (await this.spApiClient.getMarketplaceParticipations(
        credentials,
      )) as any;
      const wrapper = res?.payload ?? res?.Payload ?? res ?? null;
      const list = Array.isArray(wrapper)
        ? wrapper
        : (wrapper?.payload ?? wrapper?.Payload ?? null);
      const ids = Array.isArray(list)
        ? list
            .map((p: any) => p?.marketplace?.id ?? p?.Marketplace?.Id ?? null)
            .filter((v: any) => typeof v === 'string' && v.length > 0)
        : [];
      if (ids.length) {
        marketplaceIds = Array.from(new Set(ids));
      }
    } catch {
      // ignore; fall back to region defaults
    }

    // Titles are marketplace-scoped, and the returned list order can be arbitrary.
    // Prefer the seller's primary marketplace(s) first to avoid filling titles
    // with (valid) but unexpected languages from other marketplaces.
    const preferredOrder =
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
    const preferredIndex = new Map(preferredOrder.map((id, idx) => [id, idx]));
    marketplaceIds = [...marketplaceIds].sort((a, b) => {
      const ai = preferredIndex.get(a) ?? Number.MAX_SAFE_INTEGER;
      const bi = preferredIndex.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.localeCompare(b);
    });

    const userIds = await this.getOrgMemberUserIds(orgId);

    const products = await this.prisma.product.findMany({
      where: {
        userId: { in: userIds },
        asin: { not: null },
        OR: [{ title: null }, { imageUrl: null }],
      },
      take: limit,
      orderBy: { updatedAt: 'desc' },
      select: { id: true, asin: true, title: true, imageUrl: true },
    });

    let updated = 0;
    let skipped = 0;
    const errors: { asin: string; error: string }[] = [];
    const skippedSamples: Array<{
      asin: string;
      marketplacesTried: number;
      sawSummaries: boolean;
      sawAttributes: boolean;
    }> = [];

    for (const p of products) {
      const asin = p.asin ?? '';
      if (!asin) {
        skipped += 1;
        continue;
      }
      try {
        const pickString = (v: unknown): string | null =>
          typeof v === 'string' && v.trim() ? v.trim() : null;

        const pickAttrTitle = (v: unknown): string | null => {
          if (typeof v === 'string' && v.trim()) return v.trim();
          if (Array.isArray(v)) {
            for (const item of v) {
              if (typeof item === 'string' && item.trim()) return item.trim();
              const maybeValue = item?.value ?? item?.Value;
              if (typeof maybeValue === 'string' && maybeValue.trim()) {
                return maybeValue.trim();
              }
            }
          }
          const maybeValue = (v as any)?.value ?? (v as any)?.Value;
          if (typeof maybeValue === 'string' && maybeValue.trim())
            return maybeValue.trim();
          return null;
        };

        const titleFromSummaries = (
          summaries: unknown,
          marketplaceId: string,
        ): string | null => {
          if (!Array.isArray(summaries) || summaries.length === 0) return null;

          // Prefer a summary matching the marketplaceId, otherwise fall back to the first summary.
          const matching =
            summaries.find((s: any) => s?.marketplaceId === marketplaceId) ??
            summaries.find((s: any) => s?.MarketplaceId === marketplaceId) ??
            summaries[0];

          return (
            pickString(matching?.itemName) ??
            pickString(matching?.item_name) ??
            pickString(matching?.itemTitle) ??
            pickString(matching?.item_title) ??
            pickString(matching?.title) ??
            null
          );
        };

        const titleFromAttributes = (
          attributes: unknown,
          marketplaceId: string,
        ): string | null => {
          if (!attributes || typeof attributes !== 'object') return null;

          const attr = attributes as any;
          const candidates =
            attr.item_name ??
            attr.itemName ??
            attr.item_title ??
            attr.itemTitle ??
            attr.product_title ??
            attr.productTitle ??
            attr.title ??
            null;

          // Many attributes are arrays of objects including marketplace_id + value.
          if (Array.isArray(candidates)) {
            const matching =
              candidates.find(
                (x: any) => x?.marketplace_id === marketplaceId,
              ) ??
              candidates.find((x: any) => x?.marketplaceId === marketplaceId) ??
              candidates[0];
            return pickAttrTitle(matching);
          }

          return pickAttrTitle(candidates);
        };

        const imageFromPayload = (
          payload: any,
          marketplaceId: string,
        ): string | null => {
          const images = payload?.images ?? payload?.Images ?? null;
          if (!Array.isArray(images) || images.length === 0) return null;

          const matching =
            images.find((x: any) => x?.marketplaceId === marketplaceId) ??
            images.find((x: any) => x?.marketplace_id === marketplaceId) ??
            images[0];

          const list: any[] =
            matching?.images ??
            matching?.Images ??
            matching?.imageSet ??
            matching?.ImageSet ??
            [];
          if (!Array.isArray(list) || list.length === 0) return null;

          const pick =
            list.find(
              (img: any) => String(img?.variant ?? '').toUpperCase() === 'MAIN',
            ) ??
            list.find(
              (img: any) => String(img?.Variant ?? '').toUpperCase() === 'MAIN',
            ) ??
            list[0];

          const url =
            pick?.link ??
            pick?.Link ??
            pick?.url ??
            pick?.URL ??
            pick?.uri ??
            pick?.URI ??
            null;
          return typeof url === 'string' && url.trim() ? url.trim() : null;
        };

        let title: string | null = null;
        let imageUrl: string | null = null;
        let sawSummaries = false;
        let sawAttributes = false;
        for (const marketplaceId of marketplaceIds) {
          let res: any;
          try {
            res = (await this.spApiClient.getCatalogItem(credentials, asin, [
              marketplaceId,
            ])) as any;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Catalog Items frequently returns a per-marketplace NOT_FOUND even when the ASIN exists
            // in another marketplace. Treat that as a normal miss and continue trying.
            if (
              msg.includes('/catalog/2022-04-01/items/') &&
              msg.includes('(404)') &&
              msg.toLowerCase().includes('not found in marketplace')
            ) {
              continue;
            }
            throw e;
          }
          const payload = unwrapPayload(res);

          const summaries = payload?.summaries ?? payload?.Summaries ?? null;
          const summaryCandidates: unknown[] = Array.isArray(summaries)
            ? summaries
            : [];
          if (summaryCandidates.length) sawSummaries = true;

          const attrs = payload?.attributes ?? payload?.Attributes ?? null;
          if (attrs && typeof attrs === 'object') sawAttributes = true;

          if (!title) {
            title =
              titleFromSummaries(summaryCandidates, marketplaceId) ??
              titleFromAttributes(attrs, marketplaceId);
          }
          if (!imageUrl) {
            imageUrl = imageFromPayload(payload, marketplaceId);
          }

          if (title && imageUrl) break;
        }

        // If we couldn't find either title or image, there's nothing to update.
        if (!title && !imageUrl) {
          skipped += 1;
          if (skippedSamples.length < 5) {
            skippedSamples.push({
              asin,
              marketplacesTried: marketplaceIds.length,
              sawSummaries,
              sawAttributes,
            });
          }
          continue;
        }

        const data: any = {};
        if (p.title == null && title) data.title = title;
        if (p.imageUrl == null && imageUrl) data.imageUrl = imageUrl;

        if (Object.keys(data).length === 0) {
          skipped += 1;
          continue;
        }

        await this.prisma.product.update({ where: { id: p.id }, data });
        updated += 1;
      } catch (e) {
        errors.push({
          asin,
          error: e instanceof Error ? e.message : 'error',
        });
      }
    }

    return {
      requested: products.length,
      updated,
      skipped,
      errorsCount: errors.length,
      errors: errors.slice(0, 10),
      skippedSamples,
    };
  }

  async devGetCatalogItem(
    orgId: string,
    preferredUserId: string,
    asin: string,
    marketplaceId: string,
  ) {
    const credentials = await this.getAmazonCredentialsForOrg(
      orgId,
      preferredUserId,
    );
    return this.spApiClient.getCatalogItem(credentials, asin, [marketplaceId]);
  }

  /**
   * Example method that calls the SP-API client (sandbox for now).
   * This uses the Sellers API "getMarketplaceParticipations" shape.
   */
  async getSandboxMarketplaceParticipations(userId: string) {
    const credentials = await this.getAmazonCredentialsForUser(userId);
    return this.spApiClient.getMarketplaceParticipations(credentials);
  }

  // ----------------------------
  // Purchases / inbound costs
  // ----------------------------

  async listPurchases(
    orgId: string,
    opts?: { query?: string; take?: number; skip?: number },
  ) {
    const userIds = await this.getOrgMemberUserIds(orgId);
    const q = (opts?.query ?? '').trim().toLowerCase();
    const take = opts?.take ?? 50;
    const skip = opts?.skip ?? 0;

    const where: any = {
      userId: { in: userIds },
    };

    if (q) {
      where.OR = [
        { shipmentId: { contains: q, mode: 'insensitive' } },
        { supplier: { contains: q, mode: 'insensitive' } },
        { supplierLink: { contains: q, mode: 'insensitive' } },
        { orderNumber: { contains: q, mode: 'insensitive' } },
        {
          product: {
            OR: [
              { sku: { contains: q, mode: 'insensitive' } },
              { asin: { contains: q, mode: 'insensitive' } },
              { title: { contains: q, mode: 'insensitive' } },
            ],
          },
        },
      ];
    }

    const [total, rows] = await Promise.all([
      (this.prisma as any).purchase.count({ where }),
      (this.prisma as any).purchase.findMany({
        where,
        orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }],
        take,
        skip,
        select: {
          id: true,
          fulfilment: true,
          supplier: true,
          supplierLink: true,
          bundleSize: true,
          purchaseDate: true,
          orderNumber: true,
          shipmentId: true,
          qtyPurchased: true,
          qtyDelivered: true,
          currency: true,
          vatRatePct: true,
          unitCostIncVat: true,
          deliveryCostIncVat: true,
          prepCostIncVat: true,
          totalCostIncVat: true,
          createdAt: true,
          updatedAt: true,
          product: {
            select: {
              id: true,
              sku: true,
              asin: true,
              title: true,
              imageUrl: true,
            },
          },
        },
      }),
    ]);

    const items = rows.map((r: any) => ({
      id: r.id,
      fulfilment: r.fulfilment,
      supplier: r.supplier,
      supplierLink: r.supplierLink,
      bundleSize: Number(r.bundleSize ?? 1),
      purchaseDate: r.purchaseDate,
      orderNumber: r.orderNumber,
      shipmentId: r.shipmentId,
      qtyPurchased: r.qtyPurchased,
      qtyDelivered: r.qtyDelivered,
      currency: r.currency,
      vatRatePct: Number(r.vatRatePct ?? 0),
      unitCostIncVat: Number(r.unitCostIncVat ?? 0),
      deliveryCostIncVat: Number(r.deliveryCostIncVat ?? 0),
      prepCostIncVat: Number(r.prepCostIncVat ?? 0),
      totalCostIncVat: Number(r.totalCostIncVat ?? 0),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      product: r.product,
    }));

    return {
      total: Number(total ?? items.length),
      take,
      skip,
      items,
    };
  }

  async createPurchase(
    orgId: string,
    userId: string,
    dto: {
      productId: string;
      fulfilment?: string;
      supplier?: string;
      supplierLink?: string;
      bundleSize?: number;
      purchaseDate: string;
      orderNumber?: string;
      shipmentId?: string;
      qtyPurchased: number;
      qtyDelivered: number;
      currency?: string;
      vatRatePct: number;
      unitCostIncVat: number;
      deliveryCostIncVat: number;
      prepCostIncVat: number;
    },
  ) {
    const userIds = await this.getOrgMemberUserIds(orgId);

    const product = await this.prisma.product.findFirst({
      where: { id: dto.productId, userId: { in: userIds } },
      select: { id: true },
    });
    if (!product) {
      throw new NotFoundException('Product not found in org');
    }

    const purchaseDate = new Date(dto.purchaseDate);
    if (Number.isNaN(purchaseDate.getTime())) {
      throw new BadRequestException('Invalid purchaseDate');
    }

    const fulfilment = (dto.fulfilment ?? 'Amazon').trim() || 'Amazon';
    const currency = (dto.currency ?? 'GBP').trim() || 'GBP';
    const bundleSize = Math.max(1, Number(dto.bundleSize ?? 1) || 1);

    const vatRatePct = Number(dto.vatRatePct ?? 0);
    const unitCostIncVat = Number(dto.unitCostIncVat ?? 0);
    const deliveryCostIncVat = Number(dto.deliveryCostIncVat ?? 0);
    const prepCostIncVat = Number(dto.prepCostIncVat ?? 0);

    const totalCostIncVat =
      unitCostIncVat + deliveryCostIncVat + prepCostIncVat;

    const created = await (this.prisma as any).purchase.create({
      data: {
        userId,
        productId: dto.productId,
        fulfilment,
        supplier: dto.supplier?.trim() || null,
        supplierLink: dto.supplierLink?.trim() || null,
        bundleSize,
        purchaseDate,
        orderNumber: dto.orderNumber?.trim() || null,
        shipmentId: dto.shipmentId?.trim() || null,
        qtyPurchased: Math.max(0, Number(dto.qtyPurchased ?? 0) || 0),
        qtyDelivered: Math.max(0, Number(dto.qtyDelivered ?? 0) || 0),
        currency,
        vatRatePct,
        unitCostIncVat,
        deliveryCostIncVat,
        prepCostIncVat,
        totalCostIncVat,
      },
      select: {
        id: true,
        fulfilment: true,
        supplier: true,
        supplierLink: true,
        bundleSize: true,
        purchaseDate: true,
        orderNumber: true,
        shipmentId: true,
        qtyPurchased: true,
        qtyDelivered: true,
        currency: true,
        vatRatePct: true,
        unitCostIncVat: true,
        deliveryCostIncVat: true,
        prepCostIncVat: true,
        totalCostIncVat: true,
        createdAt: true,
        updatedAt: true,
        product: {
          select: {
            id: true,
            sku: true,
            asin: true,
            title: true,
            imageUrl: true,
          },
        },
      },
    });

    // Derive per-unit COGS for profit calculations:
    // Use per-unit total (unit + delivery + prep), convert to ex-VAT when vatRatePct > 0.
    // This keeps dashboard profit working while COGS is managed via the ledger.
    try {
      const vatFactor = 1 + (vatRatePct > 0 ? vatRatePct / 100 : 0);
      const derivedCogs =
        vatFactor > 0 ? totalCostIncVat / vatFactor : totalCostIncVat;
      const rounded = Number.isFinite(derivedCogs)
        ? Number(derivedCogs.toFixed(2))
        : null;
      await this.updateProductCostOfGoods(orgId, dto.productId, rounded);
    } catch (e) {
      // Non-fatal; purchase entry is still saved.
      console.warn('[AmazonService.createPurchase] failed to derive COGS', {
        err: e,
      });
    }

    return {
      ...created,
      bundleSize: Number(created.bundleSize ?? 1),
      vatRatePct: Number(created.vatRatePct ?? 0),
      unitCostIncVat: Number(created.unitCostIncVat ?? 0),
      deliveryCostIncVat: Number(created.deliveryCostIncVat ?? 0),
      prepCostIncVat: Number(created.prepCostIncVat ?? 0),
      totalCostIncVat: Number(created.totalCostIncVat ?? 0),
    };
  }

  async updatePurchase(
    orgId: string,
    userId: string,
    purchaseId: string,
    dto: {
      fulfilment?: string;
      supplier?: string;
      supplierLink?: string;
      bundleSize?: number;
      purchaseDate?: string;
      orderNumber?: string;
      shipmentId?: string;
      qtyPurchased?: number;
      qtyDelivered?: number;
      currency?: string;
      vatRatePct?: number;
      unitCostIncVat?: number;
      deliveryCostIncVat?: number;
      prepCostIncVat?: number;
    },
  ) {
    const userIds = await this.getOrgMemberUserIds(orgId);

    const existing = await (this.prisma as any).purchase.findFirst({
      where: { id: purchaseId, userId: { in: userIds } },
      select: {
        id: true,
        userId: true,
        unitCostIncVat: true,
        deliveryCostIncVat: true,
        prepCostIncVat: true,
      },
    });
    if (!existing) {
      throw new NotFoundException('Purchase not found in org');
    }

    // Only allow updates for purchases owned by org members.
    // Keep ownership stable unless you intentionally add more tenancy logic later.
    const data: any = {};
    if (dto.fulfilment !== undefined)
      data.fulfilment = dto.fulfilment.trim() || 'Amazon';
    if (dto.supplier !== undefined)
      data.supplier = dto.supplier?.trim() || null;
    if (dto.supplierLink !== undefined)
      data.supplierLink = dto.supplierLink?.trim() || null;
    if (dto.bundleSize !== undefined)
      data.bundleSize = Math.max(1, Number(dto.bundleSize ?? 1) || 1);
    if (dto.orderNumber !== undefined)
      data.orderNumber = dto.orderNumber?.trim() || null;
    if (dto.shipmentId !== undefined)
      data.shipmentId = dto.shipmentId?.trim() || null;
    if (dto.currency !== undefined)
      data.currency = dto.currency.trim() || 'GBP';
    if (dto.vatRatePct !== undefined)
      data.vatRatePct = Number(dto.vatRatePct ?? 0);
    if (dto.qtyPurchased !== undefined)
      data.qtyPurchased = Math.max(0, Number(dto.qtyPurchased ?? 0) || 0);
    if (dto.qtyDelivered !== undefined)
      data.qtyDelivered = Math.max(0, Number(dto.qtyDelivered ?? 0) || 0);
    if (dto.purchaseDate !== undefined) {
      const d = new Date(dto.purchaseDate);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequestException('Invalid purchaseDate');
      }
      data.purchaseDate = d;
    }
    if (dto.unitCostIncVat !== undefined)
      data.unitCostIncVat = Number(dto.unitCostIncVat ?? 0);
    if (dto.deliveryCostIncVat !== undefined)
      data.deliveryCostIncVat = Number(dto.deliveryCostIncVat ?? 0);
    if (dto.prepCostIncVat !== undefined)
      data.prepCostIncVat = Number(dto.prepCostIncVat ?? 0);

    const nextUnit = Number(
      data.unitCostIncVat ?? existing.unitCostIncVat ?? 0,
    );
    const nextDelivery = Number(
      data.deliveryCostIncVat ?? existing.deliveryCostIncVat ?? 0,
    );
    const nextPrep = Number(
      data.prepCostIncVat ?? existing.prepCostIncVat ?? 0,
    );
    data.totalCostIncVat = nextUnit + nextDelivery + nextPrep;

    const updated = await (this.prisma as any).purchase.update({
      where: { id: purchaseId },
      data,
      select: {
        id: true,
        fulfilment: true,
        supplier: true,
        supplierLink: true,
        bundleSize: true,
        purchaseDate: true,
        orderNumber: true,
        shipmentId: true,
        qtyPurchased: true,
        qtyDelivered: true,
        currency: true,
        vatRatePct: true,
        unitCostIncVat: true,
        deliveryCostIncVat: true,
        prepCostIncVat: true,
        totalCostIncVat: true,
        createdAt: true,
        updatedAt: true,
        product: {
          select: {
            id: true,
            sku: true,
            asin: true,
            title: true,
            imageUrl: true,
          },
        },
      },
    });

    // Update derived per-unit COGS for this product based on the latest entry.
    try {
      const latest = await (this.prisma as any).purchase.findFirst({
        where: { productId: updated.product.id },
        orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }],
        select: { vatRatePct: true, totalCostIncVat: true },
      });
      const vatRatePct = Number(latest?.vatRatePct ?? 0);
      const totalCostIncVat = Number(latest?.totalCostIncVat ?? 0);
      const vatFactor = 1 + (vatRatePct > 0 ? vatRatePct / 100 : 0);
      const derivedCogs =
        vatFactor > 0 ? totalCostIncVat / vatFactor : totalCostIncVat;
      const rounded = Number.isFinite(derivedCogs)
        ? Number(derivedCogs.toFixed(2))
        : null;
      await this.updateProductCostOfGoods(orgId, updated.product.id, rounded);
    } catch (e) {
      console.warn('[AmazonService.updatePurchase] failed to derive COGS', {
        err: e,
      });
    }

    return {
      ...updated,
      bundleSize: Number(updated.bundleSize ?? 1),
      vatRatePct: Number(updated.vatRatePct ?? 0),
      unitCostIncVat: Number(updated.unitCostIncVat ?? 0),
      deliveryCostIncVat: Number(updated.deliveryCostIncVat ?? 0),
      prepCostIncVat: Number(updated.prepCostIncVat ?? 0),
      totalCostIncVat: Number(updated.totalCostIncVat ?? 0),
    };
  }

  async seedCostOfGoodsEntriesFromProducts(orgId: string) {
    const userIds = await this.getOrgMemberUserIds(orgId);

    const products = await this.prisma.product.findMany({
      where: {
        userId: { in: userIds },
        costOfGoods: { not: null },
      },
      select: {
        id: true,
        userId: true,
        costOfGoods: true,
      },
    });

    if (products.length === 0) {
      return { seeded: 0, skippedExisting: 0, considered: 0 };
    }

    const productIds = products.map((p) => p.id);
    const existing = await (this.prisma as any).purchase.findMany({
      where: { productId: { in: productIds } },
      select: { productId: true },
    });
    const hasEntry = new Set<string>(existing.map((e: any) => e.productId));

    const now = new Date();
    const toCreate = products
      .filter((p) => !hasEntry.has(p.id))
      .map((p) => {
        const unit = Number(p.costOfGoods ?? 0);
        const unitCostIncVat = Number.isFinite(unit) ? unit : 0;
        const totalCostIncVat = unitCostIncVat;
        return {
          id: crypto.randomUUID(),
          userId: p.userId,
          productId: p.id,
          fulfilment: 'Amazon',
          supplier: null,
          purchaseDate: now,
          orderNumber: null,
          shipmentId: null,
          qtyPurchased: 0,
          qtyDelivered: 0,
          currency: 'GBP',
          vatRatePct: 0,
          unitCostIncVat,
          deliveryCostIncVat: 0,
          prepCostIncVat: 0,
          totalCostIncVat,
          createdAt: now,
          updatedAt: now,
        };
      });

    if (toCreate.length === 0) {
      return {
        seeded: 0,
        skippedExisting: products.length,
        considered: products.length,
      };
    }

    const result = await (this.prisma as any).purchase.createMany({
      data: toCreate,
      skipDuplicates: true,
    });

    return {
      seeded: result?.count ?? toCreate.length,
      skippedExisting: products.length - toCreate.length,
      considered: products.length,
    };
  }

  async listMissingCostOfGoods(
    orgId: string,
    opts?: { start?: string; end?: string; limit?: number },
  ) {
    const userIds = await this.getOrgMemberUserIds(orgId);

    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const defaultStart = new Date(nowSafe.getTime() - 30 * 24 * 60 * 60 * 1000);

    const startDate = opts?.start ? new Date(opts.start) : defaultStart;
    const endDate = opts?.end ? new Date(opts.end) : nowSafe;

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new BadRequestException('Invalid start/end date');
    }

    // First determine which products were actually sold in this period.
    const soldDistinct = await (this.prisma as any).orderItem.groupBy({
      by: ['productId'],
      where: {
        userId: { in: userIds },
        marketplace: 'amazon',
        orderDate: { gte: startDate, lte: endDate },
      },
    });
    const soldIds = Array.isArray(soldDistinct)
      ? soldDistinct.map((r: any) => r.productId).filter(Boolean)
      : [];

    if (soldIds.length === 0) {
      return {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        missingSkusCount: 0,
        items: [],
      };
    }

    const soldProducts = await this.prisma.product.findMany({
      where: {
        userId: { in: userIds },
        id: { in: soldIds },
      },
      select: {
        id: true,
        sku: true,
        asin: true,
        title: true,
        imageUrl: true,
        costOfGoods: true,
      },
    });

    const purchasedDistinct = await (this.prisma as any).purchase.groupBy({
      by: ['productId'],
      where: {
        userId: { in: userIds },
        productId: { in: soldIds },
      },
    });
    const withLedgerEntry = new Set(
      Array.isArray(purchasedDistinct)
        ? purchasedDistinct.map((r: any) => r.productId).filter(Boolean)
        : [],
    );

    const toNum = (value: unknown): number => {
      if (value == null) return 0;
      if (typeof value === 'number') return value;
      if (typeof value === 'string') return Number(value);
      if (typeof value === 'bigint') return Number(value);
      if (typeof value === 'object') {
        const anyVal = value as any;
        if (typeof anyVal.toNumber === 'function') return anyVal.toNumber();
        if (typeof anyVal.toString === 'function')
          return Number(anyVal.toString());
      }
      return Number(value as any);
    };

    // A sold SKU is "missing COGS" if:
    // - it has no ledger entries yet, OR
    // - its derived costOfGoods is null/0 (or negative) (common placeholder).
    const missingProducts = soldProducts
      .filter((p) => {
        const cost = p.costOfGoods == null ? null : toNum(p.costOfGoods);
        const missingCost = cost == null || Number.isNaN(cost) || cost <= 0;
        const missingLedger = !withLedgerEntry.has(p.id);
        return missingCost || missingLedger;
      })
      .map((p) => ({
        id: p.id,
        sku: p.sku,
        asin: p.asin,
        title: p.title,
        imageUrl: p.imageUrl,
      }));
    if (missingProducts.length === 0) {
      return {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        missingSkusCount: 0,
        items: [],
      };
    }

    const missingIds = missingProducts.map((p) => p.id);

    const where = {
      userId: { in: userIds },
      marketplace: 'amazon',
      productId: { in: missingIds },
      orderDate: { gte: startDate, lte: endDate },
    };

    const missingSkusCount = missingProducts.length;

    const rows = await (this.prisma as any).orderItem.groupBy({
      by: ['productId'],
      where,
      _sum: {
        revenueTotal: true,
        quantity: true,
      },
      _count: { _all: true },
      orderBy: { _sum: { revenueTotal: 'desc' } },
      take: opts?.limit ?? 25,
    });

    const byId = new Map(missingProducts.map((p) => [p.id, p]));

    const items = rows
      .map((r: any) => {
        const p = byId.get(r.productId);
        if (!p) return null;
        return {
          productId: p.id,
          sku: p.sku,
          asin: p.asin,
          title: p.title,
          imageUrl: p.imageUrl,
          revenue: Number(r._sum?.revenueTotal ?? 0),
          units: Number(r._sum?.quantity ?? 0),
          lineItems: r._count?._all ?? 0,
        };
      })
      .filter(Boolean);

    return {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      missingSkusCount,
      items,
    };
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
  async getAmazonConnectUrl(
    userId: string,
    regionCode: string,
  ): Promise<string> {
    const applicationId = this.configService.get<string>('AMAZON_APP_ID');
    const redirectUri = this.configService.get<string>('AMAZON_REDIRECT_URI');

    if (!applicationId || !redirectUri) {
      throw new Error(
        'AMAZON_APP_ID and AMAZON_REDIRECT_URI must be configured',
      );
    }

    const baseUrl = this.getSellerCentralBaseUrl(regionCode);

    const statePayload = {
      userId,
      region: regionCode,
    };
    const state = Buffer.from(JSON.stringify(statePayload)).toString(
      'base64url',
    );

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
    const awsAccessKeyId =
      this.configService.get<string>('AWS_ACCESS_KEY_ID') ?? '';
    const awsSecretAccessKey =
      this.configService.get<string>('AWS_SECRET_ACCESS_KEY') ?? '';
    const awsRoleArn =
      this.configService.get<string>('AWS_ROLE_ARN') ?? undefined;

    if (!redirectUri || !lwaClientId || !lwaClientSecret) {
      throw new Error(
        'LWA_CLIENT_ID, LWA_CLIENT_SECRET and AMAZON_REDIRECT_URI must be configured',
      );
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
