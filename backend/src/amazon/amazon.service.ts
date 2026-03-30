import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
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
import {
  amountExVatFromIncl,
  vatAmountFromIncl,
  vatAmountFromEx,
} from '../common/vat.util';
import { Prisma } from '@prisma/client';
import { MARKETPLACE_MAP } from '../marketplace/marketplace.constants';

/** When we have no settled fees and no product fee estimate, use this share of revenue as fee so profit/ROI are not overstated. */
const DEFAULT_AMAZON_FEE_RATE_WHEN_UNKNOWN = 0.35;

/**
 * Stored on Order / OrderItem. Do not use SP-API `Order.MarketplaceId` here — that ID is not the same
 * as the literal `"amazon"` used across queries/backfill, so mixing them breaks
 * @@unique([userId, orderId, marketplace]) and creates duplicate order rows for one Amazon order.
 */
const ORDER_MARKETPLACE_CANONICAL = 'amazon';

@Injectable()
export class AmazonService {
  private readonly logger = new Logger(AmazonService.name);
  constructor(
    private readonly spApiClient: AmazonSpApiClient,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  private async getOrgMemberUserIds(orgId: string): Promise<string[]> {
    return this.usersService.getOrgMemberUserIds(orgId);
  }

  private resolveCurrencyFromMarketplace(
    defaultCurrency: string,
    marketplaceId?: string,
  ): string {
    if (!marketplaceId) return defaultCurrency;
    return MARKETPLACE_MAP.get(marketplaceId)?.currencyCode ?? defaultCurrency;
  }

  private resolveMarketplaceFilter(marketplaceId?: string) {
    return marketplaceId ? { in: [marketplaceId, 'amazon'] } : 'amazon';
  }

  /**
   * When duplicate `order_items` exist for the same Amazon order line (e.g. duplicate parent `orders` rows),
   * keep one row: prefer settled finances, then newest updatedAt.
   */
  private dedupeOrderItemsByOrderLine<
    T extends {
      id: string;
      orderId: string;
      orderItemId?: string | null;
      feesSource?: string | null;
      updatedAt?: Date | string;
    },
  >(items: T[]): T[] {
    const rank = (it: T) => {
      const fs = String(it.feesSource ?? '');
      const fin = fs === 'finances' ? 1e15 : 0;
      const u =
        it.updatedAt instanceof Date
          ? it.updatedAt.getTime()
          : typeof it.updatedAt === 'string'
            ? new Date(it.updatedAt).getTime()
            : 0;
      return fin + u;
    };
    const sorted = [...items].sort((a, b) => rank(b) - rank(a));
    const seen = new Set<string>();
    return sorted.filter((it) => {
      const oiid = String(it.orderItemId ?? '').trim();
      const key = oiid
        ? `${String(it.orderId)}\0${oiid}`
        : `${String(it.orderId)}\0${String(it.id)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Same numeric coercion as `listOrders` / `safeNum` for money fields on order lines.
   */
  private safeNumOrderMoney(v: unknown): number {
    if (v == null) return 0;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const o = v as { toNumber?: () => number; toString?: () => string };
    if (o?.toNumber && typeof o.toNumber === 'function') return o.toNumber();
    if (o?.toString && typeof o.toString === 'function') return Number(o.toString()) || 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Per-SKU unit price from lines that already have revenue (used when `revenueTotal` is still 0 on a sibling line).
   * Matches `listOrders` fallback order.
   */
  private buildSkuUnitPriceFallbackFromOrderItems(
    items: Array<{ revenueTotal?: unknown; quantity?: unknown; sku?: unknown }>,
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const it of items) {
      const sku = String(it.sku ?? '').trim();
      if (!sku || map.has(sku)) continue;
      const rev = this.safeNumOrderMoney(it.revenueTotal);
      const qty = this.safeNumOrderMoney(it.quantity);
      if (rev > 0 && qty > 0) map.set(sku, rev / qty);
    }
    return map;
  }

  private async loadOrderParentPricesByDbId(
    orderDbIds: string[],
  ): Promise<Map<string, { itemPrice: number; quantity: number }>> {
    const map = new Map<string, { itemPrice: number; quantity: number }>();
    const ids = [...new Set(orderDbIds.map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) return map;
    try {
      const rows = await this.prisma.order.findMany({
        where: { id: { in: ids } },
        select: { id: true, itemPrice: true, quantity: true },
      });
      for (const row of rows) {
        map.set(String(row.id), {
          itemPrice: this.safeNumOrderMoney(row.itemPrice),
          quantity: this.safeNumOrderMoney(row.quantity),
        });
      }
    } catch {
      // non-fatal: fall back to raw revenueTotal only
    }
    return map;
  }

  /**
   * Effective line revenue: `revenueTotal` when set; else parent order `itemPrice × line qty` (listOrders parity);
   * else SKU average from other lines in the batch. Avoids under-counting sales in aggregates when ItemPrice was late.
   */
  private resolveOrderLineRevenueTotal(
    it: {
      revenueTotal?: unknown;
      quantity?: unknown;
      orderDbId?: unknown;
      sku?: unknown;
    },
    orderPriceByDbId: Map<string, { itemPrice: number; quantity: number }>,
    skuUnitPriceFallback: Map<string, number>,
  ): number {
    const rawRevenueTotal = this.safeNumOrderMoney(it.revenueTotal);
    const qty = this.safeNumOrderMoney(it.quantity) || 1;
    const orderDbId = it.orderDbId != null ? String(it.orderDbId) : '';
    const orderFallback = orderDbId ? orderPriceByDbId.get(orderDbId) : undefined;
    const skuKey = String(it.sku ?? '').trim();
    if (rawRevenueTotal > 0) return rawRevenueTotal;
    if (
      orderFallback != null &&
      orderFallback.itemPrice > 0 &&
      orderFallback.quantity > 0
    ) {
      return orderFallback.itemPrice * qty;
    }
    if (skuKey && skuUnitPriceFallback.has(skuKey)) {
      return (skuUnitPriceFallback.get(skuKey) as number) * qty;
    }
    return rawRevenueTotal;
  }

  /** Load parent order prices for a deduped order-item list (for revenue fallbacks). */
  private async buildRevenueFallbackMapsForOrderItems(
    orderItems: Array<{ orderDbId?: unknown; revenueTotal?: unknown; quantity?: unknown; sku?: unknown }>,
  ): Promise<{
    orderPriceByDbId: Map<string, { itemPrice: number; quantity: number }>;
    skuUnitPriceFallback: Map<string, number>;
  }> {
    const orderDbIds = [
      ...new Set(
        orderItems
          .map((i) => (i.orderDbId != null ? String(i.orderDbId) : ''))
          .filter(Boolean),
      ),
    ];
    const orderPriceByDbId = await this.loadOrderParentPricesByDbId(orderDbIds);
    const skuUnitPriceFallback = this.buildSkuUnitPriceFallbackFromOrderItems(orderItems);
    return { orderPriceByDbId, skuUnitPriceFallback };
  }

  /** Load org VAT settings for a user (uses user's active org). Returns null if no org or no VAT settings. */
  private async getVatSettingsForUser(userId: string): Promise<{
    vatRegistrationType: string;
    vatEffectiveDate: Date | null;
    vatRatePct: number;
    vatFlatRatePct: number;
    vatCostsIncludeVat: boolean;
  } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { activeOrgId: true },
    });
    const orgId = user?.activeOrgId;
    if (!orgId) return null;
    const org = await (this.prisma as any).organization.findUnique({
      where: { id: orgId },
      select: {
        vatRegistrationType: true,
        vatEffectiveDate: true,
        vatFlatRatePct: true,
        vatRatePct: true,
        vatCostsIncludeVat: true,
      },
    });
    if (!org) return null;
    const effectiveDate = org.vatEffectiveDate ? (org.vatEffectiveDate as Date) : null;
    return {
      vatRegistrationType: org.vatRegistrationType ?? 'NON_VAT_REGISTERED',
      vatEffectiveDate: effectiveDate,
      vatRatePct: org.vatRatePct != null ? Number(org.vatRatePct) : 20,
      vatFlatRatePct: org.vatFlatRatePct != null ? Number(org.vatFlatRatePct) : 0,
      vatCostsIncludeVat: org.vatCostsIncludeVat !== false,
    };
  }

  /**
   * SP-API order line: `ItemPrice` is often missing until shipped; `Amount` may be a string;
   * some payloads expose only `CurrencyAmount`.
   */
  private parseOrderItemItemPriceAmount(it: any): number {
    const ip = it?.ItemPrice ?? it?.itemPrice;
    if (ip == null) return 0;
    const raw =
      ip?.Amount ?? ip?.amount ?? ip?.CurrencyAmount ?? ip?.currencyAmount;
    if (raw == null || raw === '') return 0;
    const n = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
    return Number.isNaN(n) ? 0 : n;
  }

  /** `OrderTotal` from getOrders payload (stored on Order.rawResponse). */
  private parseOrderTotalAmountFromOrderJson(orderLike: any): number {
    const ot = orderLike?.OrderTotal ?? orderLike?.orderTotal;
    const raw = ot?.Amount ?? ot?.amount;
    if (raw == null || raw === '') return 0;
    const n = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
    return Number.isNaN(n) ? 0 : n;
  }

  /**
   * Per-line revenue from ItemPrice; when missing or zero, split order OrderTotal by line quantity.
   * If OrderTotal is also 0 (pending invoice, etc.), lines stay 0 — there is no reliable total to split.
   */
  private computeLineRevenueTotals(orderItems: any[], orderTotalAmount: number): number[] {
    const itemRevenues = orderItems.map((it) => this.parseOrderItemItemPriceAmount(it));
    const totalQtyFromItems = orderItems.reduce((sum, it) => {
      const q = Number(it?.QuantityOrdered ?? 0);
      return sum + (Number.isFinite(q) && q > 0 ? q : 0);
    }, 0);
    return orderItems.map((it, idx) => {
      let revenueTotal = itemRevenues[idx] ?? 0;
      const q = Number(it?.QuantityOrdered ?? 0);
      const quantityOrdered = q > 0 ? q : 1;
      if (
        (!Number.isFinite(revenueTotal) || revenueTotal <= 0) &&
        orderTotalAmount > 0 &&
        totalQtyFromItems > 0 &&
        quantityOrdered > 0
      ) {
        revenueTotal = Number(
          ((orderTotalAmount * quantityOrdered) / totalQtyFromItems).toFixed(2),
        );
      }
      return revenueTotal;
    });
  }

  /**
   * Compute profit and VAT breakdown for an order item based on org VAT settings and order date.
   * Returns profit (ex-VAT for VAT reg, gross for non-VAT). Always computes and returns inc/excl
   * VAT figures (and fee VAT) so we can persist them even when not VAT registered; when the user
   * turns on VAT we can quickly compute VAT balance from stored figures.
   */
  private computeOrderItemVatAndProfit(
    revenueTotal: number,
    cogsTotal: number | null,
    quantity: number,
    orderDate: Date,
    itemFees: number,
    taxCharged: number,
    vatSettings: {
      vatRegistrationType: string;
      vatEffectiveDate: Date | null;
      vatRatePct: number;
      vatFlatRatePct: number;
      vatCostsIncludeVat: boolean;
    } | null,
  ): {
    profit: number | null;
    salePriceIncVat: number | null;
    salePriceExVat: number | null;
    saleVatAmount: number | null;
    unitCostIncVat: number | null;
    unitCostExVat: number | null;
    unitVatAmount: number | null;
    deliveryIncVat: number | null;
    deliveryExVat: number | null;
    deliveryVatAmount: number | null;
    prepIncVat: number | null;
    prepExVat: number | null;
    prepVatAmount: number | null;
    amazonFeesExVat: number | null;
    amazonFeesIncVat: number | null;
    amazonFeesVatAmount: number | null;
  } {
    const rate = vatSettings?.vatRatePct ?? 20;
    const safeQty = quantity > 0 ? quantity : 1;
    const costPerUnit = cogsTotal != null ? cogsTotal / safeQty : null;

    // Fee VAT: Amazon fees are typically reported ex VAT; always compute for storage
    const amazonFeesExVat = Math.round(itemFees * 100) / 100;
    const amazonFeesVatAmount = itemFees > 0 ? vatAmountFromEx(itemFees, rate) : 0;
    const amazonFeesIncVat = Math.round((amazonFeesExVat + amazonFeesVatAmount) * 100) / 100;
    const feeVat = {
      amazonFeesExVat,
      amazonFeesIncVat,
      amazonFeesVatAmount,
    };

    const nil = {
      profit: null as number | null,
      salePriceIncVat: null,
      salePriceExVat: null,
      saleVatAmount: null,
      unitCostIncVat: null,
      unitCostExVat: null,
      unitVatAmount: null,
      deliveryIncVat: null,
      deliveryExVat: null,
      deliveryVatAmount: null,
      prepIncVat: null,
      prepExVat: null,
      prepVatAmount: null,
      ...feeVat,
    };

    const notVatRegisteredOrBeforeEffective =
      !vatSettings ||
      vatSettings.vatRegistrationType === 'NON_VAT_REGISTERED' ||
      (vatSettings.vatEffectiveDate != null && orderDate < vatSettings.vatEffectiveDate);

    if (notVatRegisteredOrBeforeEffective) {
      const profit =
        cogsTotal != null
          ? Math.round((revenueTotal - taxCharged - cogsTotal + itemFees) * 100) / 100
          : null;
      // Still compute and store inc/excl VAT using org rate (or default 20%) for when user turns on VAT
      const salePriceIncVat = Math.round(revenueTotal * 100) / 100;
      const salePriceExVat = amountExVatFromIncl(revenueTotal, rate);
      const saleVatAmount = vatAmountFromIncl(revenueTotal, rate);
      let unitCostIncVat = 0;
      let unitCostExVat = 0;
      let unitVatAmount = 0;
      if (costPerUnit != null && costPerUnit > 0 && vatSettings?.vatCostsIncludeVat !== false) {
        unitCostIncVat = Math.round(costPerUnit * 100) / 100;
        unitCostExVat = amountExVatFromIncl(costPerUnit, rate);
        unitVatAmount = vatAmountFromIncl(costPerUnit, rate);
      } else if (costPerUnit != null && costPerUnit > 0) {
        unitCostExVat = Math.round(costPerUnit * 100) / 100;
        unitVatAmount = vatAmountFromEx(costPerUnit, rate);
        unitCostIncVat = Math.round((costPerUnit + unitVatAmount) * 100) / 100;
      }
      return {
        profit,
        salePriceIncVat,
        salePriceExVat,
        saleVatAmount,
        unitCostIncVat,
        unitCostExVat,
        unitVatAmount,
        deliveryIncVat: 0,
        deliveryExVat: 0,
        deliveryVatAmount: 0,
        prepIncVat: 0,
        prepExVat: 0,
        prepVatAmount: 0,
        ...feeVat,
      };
    }

    if (vatSettings.vatRegistrationType === 'VAT_STANDARD') {
      const r = vatSettings.vatRatePct;
      const salePriceIncVat = Math.round(revenueTotal * 100) / 100;
      const salePriceExVat = amountExVatFromIncl(revenueTotal, r);
      const saleVatAmount = vatAmountFromIncl(revenueTotal, r);

      let unitCostIncVat: number;
      let unitCostExVat: number;
      let unitVatAmount: number;
      if (costPerUnit != null && costPerUnit > 0) {
        if (vatSettings.vatCostsIncludeVat) {
          unitCostIncVat = Math.round(costPerUnit * 100) / 100;
          unitCostExVat = amountExVatFromIncl(costPerUnit, r);
          unitVatAmount = vatAmountFromIncl(costPerUnit, r);
        } else {
          unitCostExVat = Math.round(costPerUnit * 100) / 100;
          unitVatAmount = vatAmountFromEx(costPerUnit, r);
          unitCostIncVat = Math.round((costPerUnit + unitVatAmount) * 100) / 100;
        }
      } else {
        unitCostIncVat = 0;
        unitCostExVat = 0;
        unitVatAmount = 0;
      }
      const costExVatTotal = (unitCostExVat ?? 0) * safeQty;
      const profit =
        cogsTotal != null
          ? Math.round((salePriceExVat - costExVatTotal + itemFees) * 100) / 100
          : null;
      return {
        profit,
        salePriceIncVat,
        salePriceExVat,
        saleVatAmount,
        unitCostIncVat,
        unitCostExVat,
        unitVatAmount,
        deliveryIncVat: 0,
        deliveryExVat: 0,
        deliveryVatAmount: 0,
        prepIncVat: 0,
        prepExVat: 0,
        prepVatAmount: 0,
        ...feeVat,
      };
    }

    if (vatSettings.vatRegistrationType === 'VAT_FLAT_RATE') {
      const flatPct = vatSettings.vatFlatRatePct;
      const salePriceIncVat = Math.round(revenueTotal * 100) / 100;
      const saleVatAmount = Math.round(revenueTotal * (flatPct / 100) * 100) / 100;
      const salePriceExVat = Math.round((revenueTotal - saleVatAmount) * 100) / 100;
      const unitCostIncVat = costPerUnit != null ? Math.round(costPerUnit * 100) / 100 : 0;
      const unitCostExVat = unitCostIncVat;
      const unitVatAmount = 0;
      const profit =
        cogsTotal != null
          ? Math.round((salePriceExVat - cogsTotal + itemFees) * 100) / 100
          : null;
      return {
        profit,
        salePriceIncVat,
        salePriceExVat,
        saleVatAmount,
        unitCostIncVat,
        unitCostExVat,
        unitVatAmount,
        deliveryIncVat: 0,
        deliveryExVat: 0,
        deliveryVatAmount: 0,
        prepIncVat: 0,
        prepExVat: 0,
        prepVatAmount: 0,
        ...feeVat,
      };
    }

    const profit =
      cogsTotal != null
        ? Math.round((revenueTotal - taxCharged - cogsTotal + itemFees) * 100) / 100
        : null;
    const salePriceIncVat = Math.round(revenueTotal * 100) / 100;
    const salePriceExVat = amountExVatFromIncl(revenueTotal, rate);
    const saleVatAmount = vatAmountFromIncl(revenueTotal, rate);
    let unitCostIncVat = 0;
    let unitCostExVat = 0;
    let unitVatAmount = 0;
    if (costPerUnit != null && costPerUnit > 0) {
      unitCostExVat = Math.round(costPerUnit * 100) / 100;
      unitVatAmount = vatAmountFromEx(costPerUnit, rate);
      unitCostIncVat = Math.round((costPerUnit + unitVatAmount) * 100) / 100;
    }
    return {
      profit,
      salePriceIncVat,
      salePriceExVat,
      saleVatAmount,
      unitCostIncVat,
      unitCostExVat,
      unitVatAmount,
      deliveryIncVat: 0,
      deliveryExVat: 0,
      deliveryVatAmount: 0,
      prepIncVat: 0,
      prepExVat: 0,
      prepVatAmount: 0,
      ...feeVat,
    };
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
      region:
        creds.region === 'na' || creds.region === 'eu' || creds.region === 'fe'
          ? creds.region
          : 'eu',
      lwaClientId: creds.lwaClientId,
      lwaClientSecret: creds.lwaClientSecret,
      refreshToken: creds.refreshToken,
      awsAccessKeyId: creds.awsAccessKeyId,
      awsSecretAccessKey: creds.awsSecretAccessKey,
      awsRoleArn: process.env.AWS_ROLE_ARN,
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
      region: creds.region ?? 'eu',
      lwaClientId: creds.lwaClientId,
      lwaClientSecret: creds.lwaClientSecret,
      refreshToken: creds.refreshToken,
      awsAccessKeyId: creds.awsAccessKeyId,
      awsSecretAccessKey: creds.awsSecretAccessKey,
      awsRoleArn: process.env.AWS_ROLE_ARN,
    };
  }

  async getAccountSummary(
    orgId: string,
    preferredUserId?: string,
    range?: { start?: string; end?: string },
    marketplaceId?: string,
  ) {
    const marketplaceFilter = this.resolveMarketplaceFilter(marketplaceId);
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

    // Sales / units / order count must match the Orders tab: sum `order_items` in the range (same as salePrice×qty per line).
    // Using the parent `orders` row (itemPrice×quantity) was wrong when duplicate `orders` existed (first row kept could be
    // stale) or when the aggregate order row did not match line totals; line revenue is the source of truth.
    const rawOrderItems = await (this.prisma as any).orderItem.findMany({
      where: {
        userId: { in: userIds },
        marketplace: marketplaceFilter,
        orderDate: { gte: safeStart, lte: safeEnd },
      },
      select: {
        id: true,
        orderId: true,
        orderItemId: true,
        orderDbId: true,
        sku: true,
        updatedAt: true,
        profit: true,
        revenueTotal: true,
        taxChargedTotal: true,
        amazonFeesTotal: true,
        feesSource: true,
        settledReferralFeeTotal: true,
        settledFbaFeeTotal: true,
        settledDigitalServiceFeeTotal: true,
        cogsTotal: true,
        quantity: true,
        product: {
          select: {
            costOfGoods: true,
            estimatedAmazonFeePerUnit: true,
            estimatedReferralFeePerUnit: true,
            estimatedFbaFeePerUnit: true,
            estimatedDigitalServiceFeePerUnit: true,
          },
        },
      },
    });

    if (!rawOrderItems.length) {
      const currency = this.resolveCurrencyFromMarketplace(
        credentials.region === 'eu' ? 'GBP' : 'USD',
        marketplaceId,
      );
      return {
        marketplace: 'amazon',
        sellerId: 'LIVE-SELLER',
        currency,
        period:
          range?.start || range?.end ? 'custom' : 'last_30_days',
        revenue: 0,
        profitMargin: 0,
        unitsSold: 0,
        totalOrders: 0,
        activeSkus: 0,
        unitsInFba: 0,
        openShipments: 0,
        hasCostData: false,
        totalProfit: 0,
        totalCostOfGoods: 0,
        roiPct: null as number | null,
        orderItemsOrdersCount: 0,
        orderItemsCoveragePct: 1,
        generatedAt: new Date().toISOString(),
      };
    }

    const orderItems = this.dedupeOrderItemsByOrderLine(
      rawOrderItems,
    ) as typeof rawOrderItems;

    const { orderPriceByDbId, skuUnitPriceFallback } =
      await this.buildRevenueFallbackMapsForOrderItems(orderItems);

    const revenue = orderItems.reduce(
      (sum, it) =>
        sum +
        this.resolveOrderLineRevenueTotal(
          it as {
            revenueTotal?: unknown;
            quantity?: unknown;
            orderDbId?: unknown;
            sku?: unknown;
          },
          orderPriceByDbId,
          skuUnitPriceFallback,
        ),
      0,
    );
    const unitsSold = orderItems.reduce(
      (sum, it) => sum + toNumber((it as { quantity?: unknown }).quantity ?? 0),
      0,
    );
    const totalOrders = new Set(
      orderItems
        .map((it) => String((it as { orderId?: string }).orderId ?? ''))
        .filter(Boolean),
    ).size;

    const distinctOrderDbIds = new Set(
      orderItems.map((it: any) => String(it.orderDbId ?? '')).filter(Boolean),
    );
    const orderItemsOrdersCount = distinctOrderDbIds.size;
    const orderItemsCoveragePct = 1;

    // Profit = sale price (revenueTotal) - selling fees (amazonFeesTotal, stored negative) - tax - COGS. ROI = profit / cost of goods.
    let totalProfit = 0;
    let totalCostOfGoods = 0;
    let hasProfitData = false;
    for (const it of orderItems) {
      const revenueTotal = this.resolveOrderLineRevenueTotal(
        it as {
          revenueTotal?: unknown;
          quantity?: unknown;
          orderDbId?: unknown;
          sku?: unknown;
        },
        orderPriceByDbId,
        skuUnitPriceFallback,
      );
      const taxChargedTotal = toNumber(it.taxChargedTotal ?? 0);
      const amazonFeesTotal = toNumber(it.amazonFeesTotal ?? 0);
      const qty = toNumber(it.quantity ?? 0);
      const storedCogsTotal = it.cogsTotal != null ? toNumber(it.cogsTotal) : null;
      const cogsPerUnit =
        it.product?.costOfGoods == null
          ? null
          : toNumber(it.product.costOfGoods);
      const cogsTotal =
        storedCogsTotal != null && !Number.isNaN(storedCogsTotal)
          ? storedCogsTotal
          : cogsPerUnit != null && !Number.isNaN(cogsPerUnit) && Number.isFinite(qty) && qty > 0
            ? cogsPerUnit * qty
            : 0;

      // Only include items that have COGS (so profit = sale price - fees - COGS is well-defined).
      if (cogsTotal <= 0 && (it.profit == null || it.profit === undefined)) continue;

      // Replicate listOrders fee logic exactly so summary circles match Recent Orders / orders sheet.
      const toNumOpt = (v: unknown): number | null => {
        if (v == null) return null;
        const n = toNumber(v);
        return Number.isFinite(n) ? n : null;
      };
      // Use order item's stored fees when present (settled or previously saved estimate); otherwise use product's saved estimate so we always pick up fee data from DB.
      const settledFees = amazonFeesTotal;
      const estPerUnit =
        it.product?.estimatedAmazonFeePerUnit != null
          ? toNumOpt(it.product.estimatedAmazonFeePerUnit)
          : null;
      const estReferral =
        it.product?.estimatedReferralFeePerUnit != null
          ? toNumOpt(it.product.estimatedReferralFeePerUnit)
          : null;
      const estFba =
        it.product?.estimatedFbaFeePerUnit != null
          ? toNumOpt(it.product.estimatedFbaFeePerUnit)
          : null;
      const estDigital =
        it.product?.estimatedDigitalServiceFeePerUnit != null
          ? toNumOpt(it.product.estimatedDigitalServiceFeePerUnit)
          : null;
      const feesForDisplay =
        settledFees !== 0
          ? settledFees
          : estPerUnit != null && qty > 0
            ? -Math.abs(estPerUnit * qty)
            : revenueTotal > 0
              ? -Math.abs(revenueTotal * DEFAULT_AMAZON_FEE_RATE_WHEN_UNKNOWN)
              : 0;
      const feesSource = (it as any).feesSource ?? null;
      let referralFeeTotal: number | null = null;
      let fbaFeeTotal: number | null = null;
      let digitalServiceFeeTotal: number | null = null;
      const settledReferral = toNumOpt((it as any).settledReferralFeeTotal);
      const settledFba = toNumOpt((it as any).settledFbaFeeTotal);
      const settledDigital = toNumOpt((it as any).settledDigitalServiceFeeTotal);
      const hasSettledBreakdown =
        feesSource === 'finances' &&
        (settledReferral != null || settledFba != null || settledDigital != null);
      if (hasSettledBreakdown) {
        referralFeeTotal = settledReferral;
        fbaFeeTotal = settledFba;
        digitalServiceFeeTotal = settledDigital;
      }
      if (!hasSettledBreakdown && feesSource !== 'finances') {
        if (estReferral != null) {
          referralFeeTotal = Math.round(-Math.abs(estReferral * qty) * 100) / 100;
        }
        if (estFba != null) {
          fbaFeeTotal = Math.round(-Math.abs(estFba * qty) * 100) / 100;
        }
        if (estDigital != null) {
          digitalServiceFeeTotal = Math.round(-Math.abs(estDigital * qty) * 100) / 100;
        }
        if (
          Number.isFinite(feesForDisplay) &&
          feesForDisplay !== 0 &&
          referralFeeTotal == null &&
          fbaFeeTotal == null &&
          digitalServiceFeeTotal == null
        ) {
          referralFeeTotal = Math.round((feesForDisplay / 2) * 100) / 100;
          fbaFeeTotal = Math.round((feesForDisplay - referralFeeTotal) * 100) / 100;
        }
        if (
          digitalServiceFeeTotal == null &&
          (referralFeeTotal != null || fbaFeeTotal != null)
        ) {
          const sum = Math.abs(referralFeeTotal ?? 0) + Math.abs(fbaFeeTotal ?? 0);
          if (sum > 0) {
            digitalServiceFeeTotal = Math.round(-sum * 0.02 * 100) / 100;
          }
        }
      }
      const totalFromBreakdown =
        (referralFeeTotal ?? 0) + (fbaFeeTotal ?? 0) + (digitalServiceFeeTotal ?? 0);
      const finalFeesForDisplay =
        (referralFeeTotal != null || fbaFeeTotal != null || digitalServiceFeeTotal != null) &&
        totalFromBreakdown !== 0
          ? Math.round(totalFromBreakdown * 100) / 100
          : feesForDisplay;

      // Same formula as listOrders: revenue - tax - COGS + fees (fees negative) so circles match orders sheet.
      const itemProfit =
        revenueTotal - taxChargedTotal - cogsTotal + finalFeesForDisplay;

      if (!Number.isNaN(itemProfit)) {
        totalProfit += itemProfit;
        totalCostOfGoods += cogsTotal;
        hasProfitData = true;
      }
    }

    const currency = this.resolveCurrencyFromMarketplace(
      credentials.region === 'eu' ? 'GBP' : 'USD',
      marketplaceId,
    );
    const hasCostData = hasProfitData;
    const profitMargin = hasCostData && revenue > 0 ? totalProfit / revenue : 0;
    const roiPct =
      totalCostOfGoods > 0 ? (totalProfit / totalCostOfGoods) * 100 : null;

    return {
      marketplace: 'amazon',
      sellerId: 'LIVE-SELLER',
      currency,
      period: 'last_30_days',
      revenue,
      profitMargin,
      unitsSold,
      totalOrders,
      orderItemsOrdersCount,
      orderItemsCoveragePct,
      activeSkus: 0,
      unitsInFba: 0,
      openShipments: 0,
      hasCostData,
      totalProfit,
      totalCostOfGoods,
      roiPct,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Top 4 categories (by displayGroup) for each metric: sales, profit, ROI, units sold.
   * Used by dashboard category pie charts. Uses same date range as account summary.
   */
  async getCategoryBreakdown(
    orgId: string,
    range?: { start?: string; end?: string },
    marketplaceId?: string,
  ): Promise<{
    sales: Array<{ category: string; value: number }>;
    profit: Array<{ category: string; value: number }>;
    roi: Array<{ category: string; value: number }>;
    units: Array<{ category: string; value: number }>;
    currency: string;
  }> {
    const marketplaceFilter = this.resolveMarketplaceFilter(marketplaceId);
    const empty = (): Array<{ category: string; value: number }> => [];
    const defaultRes = {
      sales: empty(),
      profit: empty(),
      roi: empty(),
      units: empty(),
      currency: this.resolveCurrencyFromMarketplace('GBP', marketplaceId),
    };

    const parseDate = (s: string | undefined): Date | null => {
      if (!s || typeof s !== 'string') return null;
      const d = new Date(s);
      return Number.isFinite(d.getTime()) ? d : null;
    };
    const endDate = parseDate(range?.end) ?? new Date();
    const startDate = parseDate(range?.start) ?? new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const safeStart = startDate <= endDate ? startDate : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const safeEnd = endDate;

    const userIds = await this.getOrgMemberUserIds(orgId);
    if (userIds.length === 0) return defaultRes;

    const rawCategoryItems = await (this.prisma as any).orderItem.findMany({
      where: {
        userId: { in: userIds },
        marketplace: marketplaceFilter,
        orderDate: { gte: safeStart, lte: safeEnd },
      },
      select: {
        id: true,
        orderId: true,
        orderItemId: true,
        orderDbId: true,
        sku: true,
        feesSource: true,
        updatedAt: true,
        revenueTotal: true,
        profit: true,
        cogsTotal: true,
        quantity: true,
        product: { select: { displayGroup: true } },
      },
    });
    const orderItems = this.dedupeOrderItemsByOrderLine(
      rawCategoryItems,
    ) as typeof rawCategoryItems;

    const { orderPriceByDbId, skuUnitPriceFallback } =
      await this.buildRevenueFallbackMapsForOrderItems(orderItems);

    const toNum = (v: unknown): number => {
      if (v == null) return 0;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') return parseFloat(v) || 0;
      return Number(v) || 0;
    };

    type Agg = { sales: number; profit: number; cogs: number; units: number };
    const byCategory = new Map<string, Agg>();
    for (const it of orderItems) {
      const cat = (it.product?.displayGroup ?? '').trim() || 'Uncategorized';
      const cur = byCategory.get(cat) ?? { sales: 0, profit: 0, cogs: 0, units: 0 };
      cur.sales += this.resolveOrderLineRevenueTotal(
        it as {
          revenueTotal?: unknown;
          quantity?: unknown;
          orderDbId?: unknown;
          sku?: unknown;
        },
        orderPriceByDbId,
        skuUnitPriceFallback,
      );
      cur.profit += toNum(it.profit);
      cur.cogs += toNum(it.cogsTotal);
      cur.units += toNum(it.quantity) || 0;
      byCategory.set(cat, cur);
    }

    const withRoi = Array.from(byCategory.entries()).map(([category, a]) => ({
      category,
      ...a,
      roi: a.cogs > 0 ? (a.profit / a.cogs) * 100 : 0,
    }));

    const top4 = <T>(arr: T[], fn: (x: T) => number): Array<{ category: string; value: number }> =>
      [...arr]
        .sort((a, b) => fn(b) - fn(a))
        .slice(0, 4)
        .map((x: any) => ({ category: x.category, value: fn(x) }));

    const sales = top4(withRoi, (x) => x.sales);
    const profit = top4(withRoi, (x) => x.profit);
    const roi = top4(withRoi, (x) => x.roi);
    const units = top4(withRoi, (x) => x.units);

    return {
      sales,
      profit,
      roi,
      units,
      currency: 'GBP',
    };
  }

  /**
   * Cost breakdown from actual sales (OrderItem) for the last 30 days: COGS, prep, referral, FBA, digital service fees.
   * All values are positive "cost" amounts. We do not store removal/storage in OrderItem; only order-related costs.
   */
  async getCostBreakdown(
    orgId: string,
    range?: { start?: string; end?: string },
    marketplaceId?: string,
  ): Promise<{
    totalCogs: number;
    prepFees: number;
    referralFees: number;
    fbaFees: number;
    digitalServiceFees: number;
    totalAmazonFees: number;
    currency: string;
    start: string;
    end: string;
  }> {
    const marketplaceFilter = this.resolveMarketplaceFilter(marketplaceId);
    const parseDate = (s: string | undefined): Date | null => {
      if (!s || typeof s !== 'string') return null;
      const d = new Date(s);
      return Number.isFinite(d.getTime()) ? d : null;
    };
    const endDate = parseDate(range?.end) ?? new Date();
    const startDate = parseDate(range?.start) ?? new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const safeStart = startDate <= endDate ? startDate : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    // End date inclusive: use end of day so "last 7 days" includes orders on the end date.
    const safeEnd = new Date(endDate);
    if (range?.end && /^\d{4}-\d{2}-\d{2}$/.test(String(range.end).trim())) {
      safeEnd.setUTCHours(23, 59, 59, 999);
    }

    const userIds = await this.getOrgMemberUserIds(orgId);
    if (userIds.length === 0) {
      return {
        totalCogs: 0,
        prepFees: 0,
        referralFees: 0,
        fbaFees: 0,
        digitalServiceFees: 0,
        totalAmazonFees: 0,
        currency: this.resolveCurrencyFromMarketplace('GBP', marketplaceId),
        start: safeStart.toISOString().slice(0, 10),
        end: safeEnd.toISOString().slice(0, 10),
      };
    }

    const rawCostItems = await (this.prisma as any).orderItem.findMany({
      where: {
        userId: { in: userIds },
        marketplace: marketplaceFilter,
        orderDate: { gte: safeStart, lte: safeEnd },
      },
      select: {
        id: true,
        orderId: true,
        orderItemId: true,
        feesSource: true,
        updatedAt: true,
        cogsTotal: true,
        prepIncVat: true,
        prepExVat: true,
        quantity: true,
        settledReferralFeeTotal: true,
        settledFbaFeeTotal: true,
        settledDigitalServiceFeeTotal: true,
        amazonFeesTotal: true,
        product: {
          select: {
            estimatedReferralFeePerUnit: true,
            estimatedFbaFeePerUnit: true,
            estimatedDigitalServiceFeePerUnit: true,
            estimatedAmazonFeePerUnit: true,
          },
        },
      },
    });
    const orderItems = this.dedupeOrderItemsByOrderLine(
      rawCostItems,
    ) as typeof rawCostItems;

    const toNum = (v: unknown): number => {
      if (v == null) return 0;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') return parseFloat(v) || 0;
      return Number((v as any)?.toString?.() ?? 0) || 0;
    };
    const asCost = (n: number) => Math.abs(n);

    let totalCogs = 0;
    let prepFees = 0;
    let referralFees = 0;
    let fbaFees = 0;
    let digitalServiceFees = 0;
    let totalAmazonFees = 0;

    for (const it of orderItems) {
      totalCogs += toNum(it.cogsTotal);
      const prep = toNum(it.prepIncVat) || toNum(it.prepExVat);
      prepFees += asCost(prep);
      const qty = Number(it.quantity) || 1;
      const product = it.product as { estimatedReferralFeePerUnit?: unknown; estimatedFbaFeePerUnit?: unknown; estimatedDigitalServiceFeePerUnit?: unknown; estimatedAmazonFeePerUnit?: unknown } | null;
      const estReferral = toNum(product?.estimatedReferralFeePerUnit) * qty;
      const estFba = toNum(product?.estimatedFbaFeePerUnit) * qty;
      const estDsf = toNum(product?.estimatedDigitalServiceFeePerUnit) * qty;
      const estTotal = toNum(product?.estimatedAmazonFeePerUnit) * qty;
      const settledReferral = asCost(toNum(it.settledReferralFeeTotal));
      const settledFba = asCost(toNum(it.settledFbaFeeTotal));
      const settledDigital = asCost(toNum(it.settledDigitalServiceFeeTotal));
      const settledTotal = asCost(toNum(it.amazonFeesTotal));
      referralFees += settledReferral > 0 ? settledReferral : asCost(estReferral);
      fbaFees += settledFba > 0 ? settledFba : asCost(estFba);
      digitalServiceFees += settledDigital > 0 ? settledDigital : asCost(estDsf);
      totalAmazonFees += settledTotal > 0 ? settledTotal : asCost(estTotal);
    }

    return {
      totalCogs,
      prepFees,
      referralFees,
      fbaFees,
      digitalServiceFees,
      totalAmazonFees,
      currency: this.resolveCurrencyFromMarketplace('GBP', marketplaceId),
      start: safeStart.toISOString().slice(0, 10),
      end: safeEnd.toISOString().slice(0, 10),
    };
  }

  /**
   * Profit & Loss for a period: revenue minus selling unit costs (COGS, prep, fees) and fixed costs (software/other subscriptions).
   * Total profit = revenue - totalSellingCosts - totalFixedCosts.
   * Also returns VAT adjustment: outputVat (on sales), inputVat (on costs), vatBalance = outputVat - inputVat.
   */
  async getProfitAndLoss(
    orgId: string,
    range?: { start?: string; end?: string },
    marketplaceId?: string,
  ): Promise<{
    revenue: number;
    totalSellingCosts: number;
    totalCogs: number;
    prepFees: number;
    referralFees: number;
    fbaFees: number;
    digitalServiceFees: number;
    totalAmazonFees: number;
    softwareSubsTotal: number;
    otherSubsTotal: number;
    totalFixedCosts: number;
    totalProfit: number;
    outputVat: number;
    inputVat: number;
    vatBalance: number;
    vatRegistered: boolean;
    currency: string;
    start: string;
    end: string;
  }> {
    const marketplaceFilter = this.resolveMarketplaceFilter(marketplaceId);
    const cost = await this.getCostBreakdown(orgId, range, marketplaceId);
    const parseDate = (s: string | undefined): Date | null => {
      if (!s || typeof s !== 'string') return null;
      const d = new Date(s);
      return Number.isFinite(d.getTime()) ? d : null;
    };
    const endDate = parseDate(range?.end) ?? new Date();
    const startDate = parseDate(range?.start) ?? new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const safeStart = startDate <= endDate ? startDate : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const safeEnd = new Date(endDate);
    if (range?.end && /^\d{4}-\d{2}-\d{2}$/.test(String(range.end).trim())) {
      safeEnd.setUTCHours(23, 59, 59, 999);
    }

    const userIds = await this.getOrgMemberUserIds(orgId);
    const toNum = (v: unknown): number => {
      if (v == null) return 0;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') return parseFloat(v) || 0;
      return Number((v as any).toString?.() ?? 0) || 0;
    };
    let revenue = 0;
    let outputVat = 0;
    let inputVat = 0;

    // VAT settings for computing VAT when not stored on order items
    let vatSettings: Awaited<ReturnType<AmazonService['getVatSettingsForUser']>> = null;
    if (userIds.length > 0) {
      try {
        vatSettings = await this.getVatSettingsForUser(userIds[0]);
      } catch {
        // ignore
      }
    }

    if (userIds.length > 0) {
      const rawPnlItems = await (this.prisma as any).orderItem.findMany({
        where: {
          userId: { in: userIds },
          marketplace: marketplaceFilter,
          orderDate: { gte: safeStart, lte: safeEnd },
        },
        select: {
          id: true,
          orderId: true,
          orderItemId: true,
          orderDbId: true,
          sku: true,
          feesSource: true,
          updatedAt: true,
          revenueTotal: true,
          cogsTotal: true,
          quantity: true,
          orderDate: true,
          taxChargedTotal: true,
          amazonFeesTotal: true,
          saleVatAmount: true,
          estimatedSaleVatAmount: true,
          unitVatAmount: true,
          prepVatAmount: true,
          deliveryVatAmount: true,
          amazonFeesVatAmount: true,
        },
      });
      const items = this.dedupeOrderItemsByOrderLine(
        rawPnlItems,
      ) as typeof rawPnlItems;
      const { orderPriceByDbId: pnlOrderPrices, skuUnitPriceFallback: pnlSkuFallback } =
        await this.buildRevenueFallbackMapsForOrderItems(items);
      for (const it of items) {
        const lineRev = this.resolveOrderLineRevenueTotal(
          it as {
            revenueTotal?: unknown;
            quantity?: unknown;
            orderDbId?: unknown;
            sku?: unknown;
          },
          pnlOrderPrices,
          pnlSkuFallback,
        );
        revenue += lineRev;
        const rev = lineRev;
        const cogs = it.cogsTotal != null ? toNum(it.cogsTotal) : null;
        const qty = Math.max(1, Number(it.quantity) || 1);
        const orderDateItem = it.orderDate instanceof Date ? it.orderDate : new Date(it.orderDate);
        const taxCharged = toNum(it.taxChargedTotal);
        const itemFees = toNum(it.amazonFeesTotal);

        let saleVat = toNum(it.saleVatAmount) || toNum(it.estimatedSaleVatAmount);
        let itemInputVat =
          toNum(it.unitVatAmount) +
          toNum(it.prepVatAmount) +
          toNum(it.deliveryVatAmount) +
          toNum(it.amazonFeesVatAmount);
        if ((saleVat === 0 && itemInputVat === 0) && vatSettings && vatSettings.vatRegistrationType !== 'NON_VAT_REGISTERED') {
          const vatResult = this.computeOrderItemVatAndProfit(
            rev,
            cogs,
            qty,
            orderDateItem,
            itemFees,
            taxCharged,
            vatSettings,
          );
          saleVat = vatResult.saleVatAmount != null ? Number(vatResult.saleVatAmount.toFixed(2)) : 0;
          itemInputVat =
            (vatResult.unitVatAmount ?? 0) +
            (vatResult.prepVatAmount ?? 0) +
            (vatResult.deliveryVatAmount ?? 0) +
            (vatResult.amazonFeesVatAmount ?? 0);
        }
        outputVat += saleVat;
        inputVat += itemInputVat;
      }

      // Input VAT from purchases in the period
      const purchases = await (this.prisma as any).purchase.findMany({
        where: {
          userId: { in: userIds },
          purchaseDate: { gte: safeStart, lte: safeEnd },
        },
        select: {
          totalCostIncVat: true,
          totalCostExVat: true,
          costsEnteredInclVat: true,
          vatRatePct: true,
        },
      });
      for (const p of purchases) {
        const incVat = toNum(p.totalCostIncVat);
        const exVat = p.totalCostExVat != null ? toNum(p.totalCostExVat) : null;
        const rate = toNum(p.vatRatePct) || 20;
        const costsInclVat = p.costsEnteredInclVat !== false;
        let purchaseVat = 0;
        if (exVat != null && exVat > 0) {
          purchaseVat = Math.round((incVat - exVat) * 100) / 100;
        } else if (incVat > 0) {
          purchaseVat = costsInclVat
            ? vatAmountFromIncl(incVat, rate)
            : vatAmountFromEx(incVat, rate);
        }
        inputVat += purchaseVat;
      }
    }
    const vatBalance = Math.round((outputVat - inputVat) * 100) / 100;
    const vatRegistered =
      vatSettings != null && vatSettings.vatRegistrationType !== 'NON_VAT_REGISTERED';

    let softwareSubsTotal = 0;
    let otherSubsTotal = 0;
    if (userIds.length > 0) {
      const rows = await (this.prisma as any).aggDailyKpiSummary.findMany({
        where: {
          userId: { in: userIds },
          date: { gte: safeStart, lte: safeEnd },
        },
        select: { softwareSubsTotal: true, otherSubsTotal: true },
      });
      const toNum = (v: unknown): number => {
        if (v == null) return 0;
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string') return parseFloat(v) || 0;
        return Number((v as any).toString?.() ?? 0) || 0;
      };
      for (const r of rows) {
        softwareSubsTotal += toNum(r.softwareSubsTotal);
        otherSubsTotal += toNum(r.otherSubsTotal);
      }
    }

    const totalSellingCosts =
      cost.totalCogs +
      cost.prepFees +
      cost.totalAmazonFees;
    const totalFixedCosts = softwareSubsTotal + otherSubsTotal;
    const totalProfit = revenue - totalSellingCosts - totalFixedCosts;

    return {
      revenue,
      totalSellingCosts,
      totalCogs: cost.totalCogs,
      prepFees: cost.prepFees,
      referralFees: cost.referralFees,
      fbaFees: cost.fbaFees,
      digitalServiceFees: cost.digitalServiceFees,
      totalAmazonFees: cost.totalAmazonFees,
      softwareSubsTotal,
      otherSubsTotal,
      totalFixedCosts,
      totalProfit,
      outputVat,
      inputVat,
      vatBalance,
      vatRegistered,
      currency: cost.currency,
      start: cost.start,
      end: cost.end,
    };
  }

  async getSalesTimeSeries(
    orgId: string,
    range?: { start?: string; end?: string },
    preferredUserId?: string,
    marketplaceId?: string,
  ) {
    const marketplaceFilter = this.resolveMarketplaceFilter(marketplaceId);
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
    const rawTsItems = await (this.prisma as any).orderItem.findMany({
      where: {
        userId: { in: userIds },
        marketplace: marketplaceFilter,
        orderDate: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        id: true,
        orderId: true,
        orderItemId: true,
        orderDbId: true,
        sku: true,
        quantity: true,
        updatedAt: true,
        feesSource: true,
        orderDate: true,
        revenueTotal: true,
        profit: true,
      },
    });

    const tsItems = this.dedupeOrderItemsByOrderLine(rawTsItems) as typeof rawTsItems;

    const { orderPriceByDbId: tsOrderPrices, skuUnitPriceFallback: tsSkuFallback } =
      await this.buildRevenueFallbackMapsForOrderItems(tsItems);

    const toNumTs = (v: unknown): number => {
      if (v == null) return 0;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      const o = v as { toNumber?: () => number; toString?: () => string };
      if (o?.toNumber && typeof o.toNumber === 'function') return o.toNumber();
      if (o?.toString && typeof o.toString === 'function') return Number(o.toString()) || 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const byDate = new Map<
      string,
      { revenue: number; orderIds: Set<string>; profit: number }
    >();

    for (const it of tsItems) {
      const d = it.orderDate as Date;
      const key = d.toISOString().slice(0, 10); // YYYY-MM-DD

      const revenueForLine = this.resolveOrderLineRevenueTotal(
        it as {
          revenueTotal?: unknown;
          quantity?: unknown;
          orderDbId?: unknown;
          sku?: unknown;
        },
        tsOrderPrices,
        tsSkuFallback,
      );
      const profitForLine = it.profit != null ? toNumTs(it.profit) : 0;

      const existing = byDate.get(key) ?? {
        revenue: 0,
        orderIds: new Set<string>(),
        profit: 0,
      };
      existing.revenue += revenueForLine;
      existing.orderIds.add(String(it.orderId ?? ''));
      existing.profit += profitForLine;
      byDate.set(key, existing);
    }

    const currency = this.resolveCurrencyFromMarketplace(
      credentials.region === 'eu' ? 'GBP' : 'USD',
      marketplaceId,
    );

    // One bar per day from start to end (inclusive); fill missing days with 0. Cap at 30 days.
    const dayMs = 24 * 60 * 60 * 1000;
    const startDay = new Date(startDate);
    startDay.setUTCHours(0, 0, 0, 0);
    const endDay = new Date(endDate);
    endDay.setUTCHours(0, 0, 0, 0);
    let numDays = Math.round((endDay.getTime() - startDay.getTime()) / dayMs) + 1;
    if (numDays > 30) {
      numDays = 30;
    }
    if (numDays < 1) {
      numDays = 1;
    }
    const endTime = endDay.getTime();
    const startTime =
      numDays === 30 && (endTime - startDay.getTime()) > (numDays - 1) * dayMs
        ? endTime - (numDays - 1) * dayMs
        : startDay.getTime();
    const points: {
      date: string;
      revenue: number;
      orders: number;
      profit: number;
    }[] = [];
    for (let i = 0; i < numDays; i += 1) {
      const d = new Date(startTime + i * dayMs);
      const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
      const bucket = byDate.get(key) ?? {
        revenue: 0,
        orderIds: new Set<string>(),
        profit: 0,
      };
      points.push({
        date: key,
        revenue: bucket.revenue,
        orders: bucket.orderIds.size,
        profit: bucket.profit,
      });
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
  /** Default days of orders to sync (used when opts.days not provided). */
  static readonly SYNC_ORDERS_DAYS_DEFAULT = 30;

  /**
   * Merge duplicate `orders` rows for the same Amazon order id (same user) caused by inconsistent
   * `marketplace` values. Keeps the best row and re-homes or drops duplicate line items.
   */
  async repairDuplicateAmazonOrdersForUser(
    userId: string,
  ): Promise<{ ordersRemoved: number }> {
    let ordersRemoved = 0;
    const dupGroups = await this.prisma.$queryRaw<Array<{ order_id: string }>>(
      Prisma.sql`SELECT order_id FROM orders WHERE user_id = ${userId} GROUP BY user_id, order_id HAVING COUNT(*) > 1`,
    );
    if (!Array.isArray(dupGroups) || dupGroups.length === 0) {
      return { ordersRemoved: 0 };
    }
    for (const row of dupGroups) {
      const orderId = row?.order_id;
      if (!orderId) continue;
      const orders = await this.prisma.order.findMany({
        where: { userId, orderId },
        orderBy: { updatedAt: 'desc' },
        include: { _count: { select: { orderItems: true } } },
      });
      if (orders.length < 2) continue;

      const rank = (o: (typeof orders)[number]) =>
        (o.marketplace === ORDER_MARKETPLACE_CANONICAL ? 1e9 : 0) +
        o._count.orderItems * 1e6 +
        o.updatedAt.getTime();
      orders.sort((a, b) => rank(b) - rank(a));
      const keeper = orders[0]!;
      const losers = orders.slice(1);

      await this.prisma.$transaction(async (tx) => {
        for (const loser of losers) {
          const lineItems = await tx.orderItem.findMany({
            where: { orderDbId: loser.id },
            select: { id: true, orderItemId: true },
          });
          for (const oi of lineItems) {
            const clash = await tx.orderItem.findUnique({
              where: {
                orderDbId_orderItemId: {
                  orderDbId: keeper.id,
                  orderItemId: oi.orderItemId,
                },
              },
              select: { id: true },
            });
            if (clash) {
              await tx.orderItem.delete({ where: { id: oi.id } });
            } else {
              await tx.orderItem.update({
                where: { id: oi.id },
                data: {
                  orderDbId: keeper.id,
                  marketplace: ORDER_MARKETPLACE_CANONICAL,
                },
              });
            }
          }
          await tx.order.delete({ where: { id: loser.id } });
          ordersRemoved += 1;
        }
        await tx.order.update({
          where: { id: keeper.id },
          data: { marketplace: ORDER_MARKETPLACE_CANONICAL },
        });
        await tx.orderItem.updateMany({
          where: { orderDbId: keeper.id },
          data: { marketplace: ORDER_MARKETPLACE_CANONICAL },
        });
      });
    }
    return { ordersRemoved };
  }

  /** Merge duplicate Amazon `orders` rows for every member of the org (same logic as per-user repair). */
  async repairDuplicateAmazonOrdersForOrg(orgId: string): Promise<{
    ordersRemoved: number;
    orgUserIds: string[];
  }> {
    const userIds = await this.getOrgMemberUserIds(orgId);
    let ordersRemoved = 0;
    for (const uid of userIds) {
      const r = await this.repairDuplicateAmazonOrdersForUser(uid);
      ordersRemoved += r.ordersRemoved;
    }
    return { ordersRemoved, orgUserIds: userIds };
  }

  /**
   * Sync orders from SP-API into DB (including finances per order via listFinancialEventsByOrderId). Call paths:
   * - full-sync (initial): days=30, no cap → all 30-day orders + finances.
   * - orders-batch-sync (recurring): days=30; runs when initial sync is 100%.
   * Optional maxOrders/maxOrderItems cap for testing or limited sync.
   */
  async syncRecentOrdersToDb(
    userId: string,
    opts?: {
      ignoreCursor?: boolean;
      days?: number;
      /** Optional cap on number of orders to process. */
      maxOrders?: number;
      /** Optional cap on total order line items to write. */
      maxOrderItems?: number;
      /** Progress 0–25 for initial-sync progress bar (orders phase). */
      onProgress?: (progress: number) => void | Promise<void>;
    },
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
    const days = Math.max(
      1,
      Math.min(30, Number(opts?.days ?? AmazonService.SYNC_ORDERS_DAYS_DEFAULT) || AmazonService.SYNC_ORDERS_DAYS_DEFAULT),
    );
    const onProgress = opts?.onProgress;
    if (onProgress) await onProgress(1);

    try {
      const { ordersRemoved } = await this.repairDuplicateAmazonOrdersForUser(userId);
      if (ordersRemoved > 0) {
        this.logger.log(
          `[syncRecentOrdersToDb] merged duplicate Amazon order rows: removed ${ordersRemoved} extra order(s) (userId=${userId})`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `[syncRecentOrdersToDb] repairDuplicateAmazonOrdersForUser failed (non-fatal): ${msg}`,
      );
    }

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

    // EU: request all EU marketplaces (UK, DE, FR, IT, ES, etc.); optionally narrow to seller participations.
    const regionMarketplaceIds: Record<string, string[]> = {
      eu: [
        'A1F83G8C2ARO7P', // UK
        'A1PA6795UKMFR9', // DE
        'A13V1IB3VIYZZH', // FR
        'APJ6JRA9NG5V4', // IT
        'A1RKKUPIHCS9HS', // ES
        'A28R8C7NBKEWEA', // IE
        'A1805IZSGTT6HS', // NL
        'AMEN7PMS3EDWL', // BE
        'A2NODRKZP88ZB9', // SE
        'A1C3SOZRARQ6R3', // PL
      ],
      na: ['ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2', 'A1AM78C64UM0Y8', 'A2Q3Y263D00KWC'], // US, CA, MX, BR
      fe: ['A19VAU5U5O7RUS', 'A39IBJ37TRP1C6', 'A1VC38T7YXB528'], // SG, AU, JP
    };
    const region = credentials.region ?? 'eu';
    const allowedInRegion = new Set(
      regionMarketplaceIds[region] ?? regionMarketplaceIds.eu,
    );
    let marketplaceIds = regionMarketplaceIds[region] ?? regionMarketplaceIds.eu;

    try {
      const res = (await this.spApiClient.getMarketplaceParticipations(
        credentials,
      )) as any;
      const payload = res?.payload ?? res?.Payload ?? res ?? {};
      const list: any[] = payload?.payload ?? payload?.Payload ?? payload ?? [];
      const ids = Array.isArray(list)
        ? list
            .map((p) => p?.marketplace?.id ?? p?.Marketplace?.Id ?? null)
            .filter((v) => typeof v === 'string' && v.length > 0 && allowedInRegion.has(v as string))
        : [];
      if (ids.length > 0) {
        marketplaceIds = Array.from(new Set([...marketplaceIds, ...ids]));
      }
    } catch {
      // Fall back to full region list
    }

    const debug = ['1', 'true', 'yes'].includes(
      (this.configService.get<string>('SPAPI_DEBUG_LOGS') ?? '').toLowerCase(),
    );
    if (debug) {
      this.logger.debug(
        `[syncRecentOrdersToDb] region=${region} marketplaces=${marketplaceIds.length} (${marketplaceIds.slice(0, 3).join(',')}${marketplaceIds.length > 3 ? '...' : ''})`,
      );
    }

    type SpApiOrder = {
      AmazonOrderId?: string;
      PurchaseDate?: string;
      LatestShipDate?: string;
      EarliestShipDate?: string;
      OrderTotal?: { Amount?: string; CurrencyCode?: string };
      NumberOfItemsShipped?: number;
      NumberOfItemsUnshipped?: number;
    };

    if (onProgress) await onProgress(2);
    const maxOrders = opts?.maxOrders != null && opts.maxOrders > 0 ? Math.min(1000, Math.floor(opts.maxOrders)) : undefined;
    const maxOrderItems = opts?.maxOrderItems != null && opts.maxOrderItems > 0 ? Math.min(1000, Math.floor(opts.maxOrderItems)) : undefined;
    const allOrders: SpApiOrder[] = [];
    let nextToken: string | undefined;
    try {
      do {
        // Use LastUpdatedAfter/Before; do NOT send OrderStatuses (many accounts return 0 when that filter is set)
        const data = (await this.spApiClient.getOrders(credentials, nextToken
          ? { nextToken }
          : {
              lastUpdatedAfter: createdAfterIso,
              lastUpdatedBefore: createdBeforeIso,
              marketplaceIds,
            })) as { payload?: { Orders?: SpApiOrder[]; NextToken?: string }; Payload?: { Orders?: SpApiOrder[]; NextToken?: string } };
        const page = data?.payload ?? data?.Payload;
        const pageOrders = page?.Orders ?? [];
        allOrders.push(...pageOrders);
        if (maxOrders != null && allOrders.length >= maxOrders) {
          allOrders.splice(maxOrders);
          nextToken = undefined;
          break;
        }
        nextToken = page?.NextToken ?? undefined;
      } while (nextToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[syncRecentOrdersToDb] getOrders failed (userId=${userId}): ${msg}`,
      );
      throw err;
    }

    // Enforce cap so we never process more than maxOrders when set (initial sync = 15 only)
    const orders =
      maxOrders != null && maxOrders > 0
        ? allOrders.slice(0, maxOrders)
        : allOrders;
    if (maxOrders != null && orders.length > 0) {
      this.logger.log(
        `[syncRecentOrdersToDb] getOrders returned ${allOrders.length} order(s), processing ${orders.length} (capped at ${maxOrders} for initial sync; userId=${userId})`,
      );
    } else {
      this.logger.log(
        `[syncRecentOrdersToDb] getOrders returned ${orders.length} orders (paginated; userId=${userId} lastUpdatedAfter=${createdAfterIso} marketplaces=${marketplaceIds.length})`,
      );
    }
    if (onProgress) await onProgress(5);

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
      const keyLower = keyName.toLowerCase();
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if ((k === keyName || k.toLowerCase() === keyLower) && v && typeof v === 'object') {
          const obj = v as Record<string, unknown>;
          const amt = obj.CurrencyAmount ?? obj.currencyAmount ?? obj.Amount ?? obj.amount;
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

    const vatSettings = await this.getVatSettingsForUser(userId);
    const seenAsinsInThisSync = new Set<string>();
    // When maxOrders is set (initial sync), never process more than that – second line of defense
    const processLimit =
      maxOrders != null && maxOrders > 0
        ? Math.min(orders.length, maxOrders)
        : orders.length;
    const totalOrders = processLimit;
    let lastReportedProgress = 5;

    if (maxOrders != null && maxOrders > 0) {
      this.logger.log(
        `[syncRecentOrdersToDb] initial sync: processing up to ${processLimit} orders, cap ${maxOrderItems ?? maxOrders} order items (userId=${userId})`,
      );
    }

    let orderItemsWrittenThisSync = 0;
    for (let orderIndex = 0; orderIndex < processLimit; orderIndex++) {
      if (maxOrderItems != null && orderItemsWrittenThisSync >= maxOrderItems) {
        this.logger.log(
          `[syncRecentOrdersToDb] initial sync: reached cap of ${maxOrderItems} order items, stopping (userId=${userId})`,
        );
        break;
      }
      if (onProgress && totalOrders > 0) {
        const p = 5 + Math.floor((20 * (orderIndex + 1)) / totalOrders);
        if (p > lastReportedProgress) {
          lastReportedProgress = p;
          await onProgress(p);
        }
      }
      const order = orders[orderIndex];
      const amazonOrderId = order.AmazonOrderId;
      if (!amazonOrderId) continue;

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
      if (Number.isNaN(orderDate.getTime())) continue;

      const shouldFetchLineItems =
        !orderItemsThrottled && !existingOrderItemOrderIds.has(amazonOrderId);
      const shouldFetchFinances =
        !financesUnauthorized &&
        (shouldFetchLineItems || existingOrderItemOrderIds.has(amazonOrderId));

      let taxChargedTotal = 0;
      let shippingChargedTotal = 0;
      let amazonFeesTotal = 0;
      let orderItems: any[] = [];
      let finRes: any = null;
      let itemsRes: any = null;

      if (shouldFetchLineItems && shouldFetchFinances) {
        try {
          [itemsRes, finRes] = await Promise.all([
            this.spApiClient.getOrderItems(credentials, amazonOrderId),
            this.spApiClient.listFinancialEventsByOrderId(credentials, amazonOrderId, { maxResultsPerPage: 100 }),
          ]);
          itemsRes = itemsRes as any;
          finRes = finRes as any;
          orderItems = itemsRes?.payload?.OrderItems ?? [];
          for (const item of orderItems) {
            const itemTaxAmt = Number(item?.ItemTax?.Amount ?? 0);
            if (!Number.isNaN(itemTaxAmt)) taxChargedTotal += itemTaxAmt;
            const shipAmt = Number(item?.ShippingPrice?.Amount ?? 0);
            if (!Number.isNaN(shipAmt)) shippingChargedTotal += shipAmt;
          }
          const qtyFromItems = orderItems.reduce(
            (sum: number, item: any) => sum + Number(item?.QuantityOrdered ?? 0),
            0,
          );
          if (qtyFromItems > 0) quantity = qtyFromItems;
        } catch (err: any) {
          const status = err?.statusCode ?? err?.status ?? null;
          const body = typeof err?.message === 'string' ? err.message : '';
          if (status === 429 || body.includes('(429)') || body.includes('QuotaExceeded')) {
            orderItemsThrottled = true;
          }
          console.warn('[AmazonService.syncRecentOrdersToDb] getOrderItems/listFinancialEvents failed', {
            userId,
            amazonOrderId,
            err: err?.message ?? err,
          });
        }
      } else if (shouldFetchLineItems) {
        try {
          itemsRes = (await this.spApiClient.getOrderItems(credentials, amazonOrderId)) as any;
          orderItems = itemsRes?.payload?.OrderItems ?? [];
          for (const item of orderItems) {
            const itemTaxAmt = Number(item?.ItemTax?.Amount ?? 0);
            if (!Number.isNaN(itemTaxAmt)) taxChargedTotal += itemTaxAmt;
            const shipAmt = Number(item?.ShippingPrice?.Amount ?? 0);
            if (!Number.isNaN(shipAmt)) shippingChargedTotal += shipAmt;
          }
          const qtyFromItems = orderItems.reduce(
            (sum: number, item: any) => sum + Number(item?.QuantityOrdered ?? 0),
            0,
          );
          if (qtyFromItems > 0) quantity = qtyFromItems;
        } catch (err: any) {
          const status = err?.statusCode ?? err?.status ?? null;
          const body = typeof err?.message === 'string' ? err.message : '';
          if (status === 429 || body.includes('(429)') || body.includes('QuotaExceeded')) {
            orderItemsThrottled = true;
          }
          console.warn('[AmazonService.syncRecentOrdersToDb] getOrderItems failed', {
            userId,
            amazonOrderId,
            err: err?.message ?? err,
          });
        }
      } else if (shouldFetchFinances) {
        try {
          finRes = (await this.spApiClient.listFinancialEventsByOrderId(credentials, amazonOrderId, { maxResultsPerPage: 100 })) as any;
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
          console.warn('[AmazonService.syncRecentOrdersToDb] listFinancialEventsByOrderId failed', {
            userId,
            amazonOrderId,
            err: err?.message ?? err,
          });
        }
      }

      // When Finances API returns settled fee data we save it per order item (feesSource='finances').
      // ShipmentSettleEventList (deferred) is parsed first; if same item appears in both lists, first wins to avoid double-counting.
      const feeByOrderItemId = new Map<string, number>();
      const feeBySku = new Map<string, number>();

      const addFee = (
        map: Map<string, number>,
        key: string,
        amount: number,
      ) => {
        if (!key) return;
        const prev = map.get(key) ?? 0;
        if (prev !== 0) return;
        map.set(key, amount);
      };

      const sumFeeOrChargeList = (list: any[] | undefined): number => {
        if (!Array.isArray(list)) return 0;
        return list.reduce((sum, fc) => {
          const feeAmt = fc?.FeeAmount?.CurrencyAmount ?? fc?.FeeAmount?.Amount;
          const chargeAmt = fc?.ChargeAmount?.CurrencyAmount ?? fc?.ChargeAmount?.Amount ?? fc?.ChargeAmount;
          const n = Number(feeAmt ?? chargeAmt ?? 0);
          return Number.isNaN(n) ? sum : sum + n;
        }, 0);
      };

      type FeeBreakdown = { referral: number; fba: number; digital: number };
      const breakdownByOrderItemId = new Map<string, FeeBreakdown>();
      const breakdownBySku = new Map<string, FeeBreakdown>();
      const addFeeBreakdown = (
        map: Map<string, FeeBreakdown>,
        key: string,
        r: number,
        f: number,
        d: number,
      ) => {
        if (!key) return;
        const cur = map.get(key) ?? { referral: 0, fba: 0, digital: 0 };
        const hasExisting = cur.referral !== 0 || cur.fba !== 0 || cur.digital !== 0;
        if (hasExisting) return;
        map.set(key, {
          referral: cur.referral + r,
          fba: cur.fba + f,
          digital: cur.digital + d,
        });
      };
      const parseFeeBreakdown = (list: any[] | undefined): FeeBreakdown => {
        const out = { referral: 0, fba: 0, digital: 0 };
        const readAmt = (obj: any): number => {
          if (!obj) return 0;
          const a = obj?.FeeAmount ?? obj?.feeAmount ?? obj;
          const n = a?.CurrencyAmount ?? a?.currencyAmount ?? a?.Amount ?? a?.amount;
          const num = Number(n);
          return Number.isNaN(num) ? 0 : num;
        };
        const addFee = (feeType: string, amt: number) => {
          if (amt === 0) return;
          const t = (feeType || '').toLowerCase();
          if (t === 'referralfee' || t.includes('referral') || t === 'commission') out.referral += amt;
          else if (t === 'fbafees' || t.startsWith('fba') || t.includes('fulfillment')) out.fba += amt;
          else if (t === 'variableclosingfee' || t === 'digitalservicefee' || t.includes('digital')) out.digital += amt;
        };
        if (!Array.isArray(list)) return out;
        for (const fc of list) {
          const feeType = (fc?.FeeType ?? fc?.feeType ?? fc?.Type ?? '') as string;
          const amt = readAmt(fc);
          if (amt !== 0) addFee(feeType, amt);
          // SP-API often nests fee components: ItemFeeList[].FeeComponent[] with FeeType/FeeAmount.
          const components = fc?.FeeComponent ?? fc?.feeComponent ?? fc?.FeeDetailList;
          if (Array.isArray(components)) {
            for (const comp of components) {
              const ct = (comp?.FeeType ?? comp?.feeType ?? comp?.Type ?? '') as string;
              const ca = readAmt(comp);
              if (ca !== 0) addFee(ct, ca);
            }
          }
        }
        return out;
      };

      if (finRes) {
        amazonFeesTotal = sumCurrencyAmountsByKey(finRes, 'FeeAmount');
        // Support both PascalCase and camelCase (SP-API can return either). Include ShipmentSettleEventList (deferred transactions).
        const events =
          finRes?.payload?.FinancialEvents ??
          finRes?.payload?.financialEvents ??
          finRes?.FinancialEvents ??
          {};
        const shipmentLists = [
          ...(events?.ShipmentSettleEventList ?? events?.shipmentSettleEventList ?? []),
          ...(events?.ShipmentEventList ?? events?.shipmentEventList ?? []),
          ...(events?.RefundEventList ?? events?.refundEventList ?? []),
          ...(events?.ChargebackEventList ?? events?.chargebackEventList ?? []),
          ...(events?.GuaranteeClaimEventList ?? events?.guaranteeClaimEventList ?? []),
        ];
        for (const ev of shipmentLists) {
          const items = ev?.ShipmentItemList ?? ev?.shipmentItemList ?? [];
          for (const si of items) {
            const fee =
              sumFeeOrChargeList(si?.ItemFeeList ?? si?.itemFeeList) +
              sumFeeOrChargeList(si?.ItemFeeAdjustmentList ?? si?.itemFeeAdjustmentList) +
              sumFeeOrChargeList(si?.ItemChargeList ?? si?.itemChargeList);
            const orderItemIdRaw = si?.OrderItemId ?? si?.orderItemId;
            const orderItemId = orderItemIdRaw != null ? String(orderItemIdRaw) : '';
            const sku = (si?.SellerSKU ?? si?.sellerSKU) as string | undefined;
            if (fee !== 0) {
              if (orderItemId) addFee(feeByOrderItemId, orderItemId, fee);
              if (sku) addFee(feeBySku, sku, fee);
            }
            const b1 = parseFeeBreakdown(si?.ItemFeeList ?? si?.itemFeeList);
            const b2 = parseFeeBreakdown(si?.ItemFeeAdjustmentList ?? si?.itemFeeAdjustmentList);
            const r = b1.referral + b2.referral, f = b1.fba + b2.fba, d = b1.digital + b2.digital;
            if (orderItemId) addFeeBreakdown(breakdownByOrderItemId, orderItemId, r, f, d);
            if (sku) addFeeBreakdown(breakdownBySku, sku, r, f, d);
          }
        }
      }

      // When we already have OrderItems for this order, fetch Finances if not yet done and backfill settled fee breakdown.
      if (!financesUnauthorized && existingOrderItemOrderIds.has(amazonOrderId)) {
        if (!finRes) {
          try {
            const finResBackfill = (await this.spApiClient.listFinancialEventsByOrderId(
              credentials,
              amazonOrderId,
              { maxResultsPerPage: 100 },
            )) as any;
            const events =
              finResBackfill?.payload?.FinancialEvents ??
              finResBackfill?.payload?.financialEvents ??
              {};
            const shipmentLists = [
              ...(events?.ShipmentSettleEventList ?? events?.shipmentSettleEventList ?? []),
              ...(events?.ShipmentEventList ?? events?.shipmentEventList ?? []),
              ...(events?.RefundEventList ?? events?.refundEventList ?? []),
              ...(events?.ChargebackEventList ?? events?.chargebackEventList ?? []),
              ...(events?.GuaranteeClaimEventList ?? events?.guaranteeClaimEventList ?? []),
            ];
            for (const ev of shipmentLists) {
              const items = ev?.ShipmentItemList ?? ev?.shipmentItemList ?? [];
              for (const si of items) {
                const fee =
                  sumFeeOrChargeList(si?.ItemFeeList ?? si?.itemFeeList) +
                  sumFeeOrChargeList(si?.ItemFeeAdjustmentList ?? si?.itemFeeAdjustmentList) +
                  sumFeeOrChargeList(si?.ItemChargeList ?? si?.itemChargeList);
                const orderItemIdRaw = si?.OrderItemId ?? si?.orderItemId;
                const orderItemId = orderItemIdRaw != null ? String(orderItemIdRaw) : '';
                const sku = (si?.SellerSKU ?? si?.sellerSKU) as string | undefined;
                if (fee !== 0 && orderItemId) addFee(feeByOrderItemId, orderItemId, fee);
                if (fee !== 0 && sku) addFee(feeBySku, sku, fee);
                const b1 = parseFeeBreakdown(si?.ItemFeeList ?? si?.itemFeeList);
                const b2 = parseFeeBreakdown(si?.ItemFeeAdjustmentList ?? si?.itemFeeAdjustmentList);
                const r = b1.referral + b2.referral, f = b1.fba + b2.fba, d = b1.digital + b2.digital;
                if (orderItemId) addFeeBreakdown(breakdownByOrderItemId, orderItemId, r, f, d);
                if (sku) addFeeBreakdown(breakdownBySku, sku, r, f, d);
              }
            }
          } catch (err: any) {
            console.warn(
              '[AmazonService.syncRecentOrdersToDb] backfill finances for existing order items failed',
              { userId, amazonOrderId, err: err?.message ?? err },
            );
          }
        }
        const orderRecord = await (this.prisma as any).order.findFirst({
          where: { userId, orderId: amazonOrderId, marketplace: 'amazon' },
          select: { id: true },
        });
        if (orderRecord) {
          const existingItems = await (this.prisma as any).orderItem.findMany({
            where: { orderDbId: orderRecord.id },
            select: {
              id: true,
              orderItemId: true,
              sku: true,
              asin: true,
              revenueTotal: true,
              cogsTotal: true,
              quantity: true,
              taxChargedTotal: true,
              orderDate: true,
            },
          });
          for (const oi of existingItems) {
            const orderItemIdStr = oi.orderItemId != null ? String(oi.orderItemId) : '';
            let bid = breakdownByOrderItemId.get(orderItemIdStr) ?? (oi.sku ? breakdownBySku.get(oi.sku) : undefined);
            let fee = feeByOrderItemId.get(orderItemIdStr) ?? (oi.sku ? feeBySku.get(oi.sku) ?? 0 : 0);
            // When this order's API returned no fee data, use same-ASIN or same-SKU settled so we overwrite estimate with settled.
            if (fee === 0 && (oi.asin || oi.sku)) {
              const asinTrim = oi.asin && String(oi.asin).trim() ? String(oi.asin).trim() : null;
              const skuTrim = oi.sku && String(oi.sku).trim() ? String(oi.sku).trim() : null;
              const orConditions: Array<{ asin?: string; sku?: string }> = [];
              if (asinTrim) orConditions.push({ asin: asinTrim });
              if (skuTrim) orConditions.push({ sku: skuTrim });
              const sameSettled =
                orConditions.length > 0
                  ? await (this.prisma as any).orderItem.findFirst({
                      where: {
                        AND: [
                          {
                            userId,
                            marketplace: 'amazon',
                            orderDbId: { not: orderRecord.id },
                            feesSource: 'finances',
                            quantity: { gt: 0 },
                          },
                          {
                            OR: [
                              { amazonFeesTotal: { gt: 0 } },
                              { amazonFeesTotal: { lt: 0 } },
                            ],
                          },
                          { OR: orConditions },
                        ],
                      },
                      orderBy: { orderDate: 'desc' },
                      select: {
                        amazonFeesTotal: true,
                        quantity: true,
                        settledReferralFeeTotal: true,
                        settledFbaFeeTotal: true,
                        settledDigitalServiceFeeTotal: true,
                      },
                    })
                  : null;
              if (
                sameSettled &&
                sameSettled.amazonFeesTotal != null &&
                Number(sameSettled.amazonFeesTotal) !== 0 &&
                Number(sameSettled.quantity) > 0
              ) {
                const qtyHere = Number(oi.quantity ?? 1) || 1;
                const feePerUnit = Number(sameSettled.amazonFeesTotal) / Number(sameSettled.quantity);
                fee = Number((feePerUnit * qtyHere).toFixed(2));
                const ref = sameSettled.settledReferralFeeTotal != null ? Number(sameSettled.settledReferralFeeTotal) : 0;
                const fba = sameSettled.settledFbaFeeTotal != null ? Number(sameSettled.settledFbaFeeTotal) : 0;
                const dig = sameSettled.settledDigitalServiceFeeTotal != null ? Number(sameSettled.settledDigitalServiceFeeTotal) : 0;
                if (qtyHere > 0 && (ref !== 0 || fba !== 0 || dig !== 0)) {
                  const scale = (qtyHere / Number(sameSettled.quantity));
                  bid = {
                    referral: Number((ref * scale).toFixed(2)),
                    fba: Number((fba * scale).toFixed(2)),
                    digital: Number((dig * scale).toFixed(2)),
                  };
                }
              }
            }
            if (!bid && fee === 0) continue;
            const rev = Number(oi.revenueTotal ?? 0);
            const cogs = oi.cogsTotal != null ? Number(oi.cogsTotal) : null;
            const qty = Number(oi.quantity ?? 1) || 1;
            const taxChargedNum = Number(oi.taxChargedTotal ?? 0) || 0;
            const orderDateItem = oi.orderDate instanceof Date ? oi.orderDate : new Date(oi.orderDate);
            const vatResult = this.computeOrderItemVatAndProfit(
              rev,
              cogs,
              qty,
              orderDateItem,
              fee,
              taxChargedNum,
              vatSettings,
            );
            const updateData: any = {
              feesSource: 'finances',
              amazonFeesTotal: Number((fee ?? 0).toFixed(2)),
              profit: vatResult.profit != null ? Number(vatResult.profit.toFixed(2)) : undefined,
            };
            if (bid) {
              updateData.settledReferralFeeTotal = Number(bid.referral.toFixed(2));
              updateData.settledFbaFeeTotal = Number(bid.fba.toFixed(2));
              updateData.settledDigitalServiceFeeTotal = Number(bid.digital.toFixed(2));
            }
            await (this.prisma as any).orderItem.update({
              where: { id: oi.id },
              data: updateData,
            });
          }
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
      if (selectedAsin && selectedAsin.trim()) seenAsinsInThisSync.add(selectedAsin.trim());
      for (const it of orderItems) {
        const a = (it?.ASIN ?? it?.Asin) as string | undefined;
        if (a && String(a).trim()) seenAsinsInThisSync.add(String(a).trim());
      }

      // Compute profit only when we have COGS. We subtract taxes charged (VAT) if available,
      // and include Amazon fees when available. Shipping charged is tracked but not treated
      // as cost here (we don't have actual shipping cost yet).
      const cogsPerUnit = selectedProduct.costOfGoods
        ? Number(selectedProduct.costOfGoods)
        : null;
      const cogsTotal = cogsPerUnit != null ? cogsPerUnit * quantity : null;
      // amazonFeesTotal from Finances API is negative; adding it subtracts the fee from profit.
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
        marketplace: ORDER_MARKETPLACE_CANONICAL,
      };
      if (computedTotalProfit != null) {
        updateData.totalProfit = Number(computedTotalProfit.toFixed(2));
      }

      const createData: any = {
        userId,
        productId: selectedProduct.id,
        orderId: amazonOrderId,
        marketplace: ORDER_MARKETPLACE_CANONICAL,
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

      const existingOrderRow = await (this.prisma as any).order.findFirst({
        where: { userId, orderId: amazonOrderId },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      });
      const persistedOrder = existingOrderRow
        ? await (this.prisma as any).order.update({
            where: { id: existingOrderRow.id },
            data: updateData,
          })
        : await (this.prisma as any).order.create({ data: createData });

      // Persist accurate line items for per-product profitability.
      // If we don't have orderItems (e.g. call failed), we skip creating OrderItem rows.
      if (orderItems.length > 0) {
        // Initial sync cap: stop after we've written maxOrderItems line items so the UI shows that many rows.
        const itemCap =
          maxOrderItems != null
            ? Math.max(0, maxOrderItems - orderItemsWrittenThisSync)
            : orderItems.length;
        const itemsToWrite = Math.min(orderItems.length, itemCap);
        const lineRevenues = this.computeLineRevenueTotals(orderItems, totalAmount);
        const totalLineRevenue = lineRevenues.reduce((a, b) => a + b, 0);

        for (let idx = 0; idx < itemsToWrite; idx++) {
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

          const revenueTotal = lineRevenues[idx] ?? 0;
          const shippingCharged = Number(it?.ShippingPrice?.Amount ?? 0);
          const taxCharged = Number(it?.ItemTax?.Amount ?? 0);

          // Per-item fee allocation:
          // - Prefer Finances item-level fees by OrderItemId.
          // - Fall back to SKU mapping.
          // - Otherwise allocate proportionally by revenue (order-level total from Finances API).
          let itemFees = 0;
          let usedOrderLevelFinances = false;
          if (orderItemId && feeByOrderItemId.has(orderItemId)) {
            itemFees = feeByOrderItemId.get(orderItemId) ?? 0;
          } else if (sku && feeBySku.has(sku)) {
            itemFees = feeBySku.get(sku) ?? 0;
          } else if (totalLineRevenue > 0 && amazonFeesTotal !== 0) {
            itemFees = (revenueTotal / totalLineRevenue) * amazonFeesTotal;
            usedOrderLevelFinances = true;
          }
          // If we don't have this order's settled fees, prefer settled fees from another order item with the same ASIN (overwrites estimates).
          let usedSameAsinSettled = false;
          if (itemFees === 0 && asin && String(asin).trim()) {
            const asinTrim = String(asin).trim();
            const sameAsinSettled = await (this.prisma as any).orderItem.findFirst({
              where: {
                userId,
                marketplace: ORDER_MARKETPLACE_CANONICAL,
                asin: asinTrim,
                feesSource: 'finances',
                quantity: { gt: 0 },
                OR: [
                    { amazonFeesTotal: { gt: 0 } },
                    { amazonFeesTotal: { lt: 0 } },
                  ],
              },
              orderBy: { orderDate: 'desc' },
              select: { amazonFeesTotal: true, quantity: true },
            });
            if (
              sameAsinSettled &&
              sameAsinSettled.amazonFeesTotal != null &&
              Number(sameAsinSettled.amazonFeesTotal) !== 0 &&
              Number(sameAsinSettled.quantity) > 0
            ) {
              const feePerUnit =
                Number(sameAsinSettled.amazonFeesTotal) / Number(sameAsinSettled.quantity);
              itemFees = Number((feePerUnit * quantityOrdered).toFixed(2));
              usedSameAsinSettled = true;
            }
          }
          // If no settled fees yet (this order or same ASIN), use product's saved estimate (per unit × qty).
          if (itemFees === 0 && sku) {
            const productWithEst = await this.prisma.product.findUnique({
              where: { userId_sku: { userId, sku } },
              select: { estimatedAmazonFeePerUnit: true },
            });
            const estPerUnit = productWithEst?.estimatedAmazonFeePerUnit != null
              ? Number(productWithEst.estimatedAmazonFeePerUnit)
              : null;
            if (estPerUnit != null && !Number.isNaN(estPerUnit)) {
              itemFees = estPerUnit * quantityOrdered;
            }
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

          // When we have no fees (Finances API not settled yet) and product has no estimate, fetch fee estimate so we don't persist 0 and overstate profit/ROI.
          if (
            itemFees === 0 &&
            (asin || sku) &&
            (itemProduct as any).estimatedAmazonFeePerUnit == null
          ) {
            try {
              const marketplaceId = (
                regionMarketplaceIds[credentials.region ?? 'eu'] ??
                regionMarketplaceIds.eu
              )[0];
              const listingPriceAmount =
                quantityOrdered > 0 ? revenueTotal / quantityOrdered : 15;
              const listingCurrency =
                credentials.region === 'eu' ? 'GBP' : 'USD';
              const params = {
                marketplaceId,
                isAmazonFulfilled: true,
                listingPriceAmount,
                listingPriceCurrency: listingCurrency,
              };
              const res =
                asin && String(asin).trim()
                  ? await this.spApiClient.getMyFeesEstimateForASIN(
                      credentials,
                      String(asin).trim(),
                      params,
                    )
                  : await this.spApiClient.getMyFeesEstimateForSKU(
                      credentials,
                      sku,
                      params,
                    );
              const breakdown = this.parseFeesEstimateBreakdown(res as any);
              if (
                breakdown.total != null &&
                Number.isFinite(breakdown.total)
              ) {
                const ref = breakdown.referralFee ?? 0;
                const fba = breakdown.fbaFee ?? 0;
                const digitalToSave =
                  breakdown.digitalServiceFee ??
                  (credentials.region === 'eu' && (ref !== 0 || fba !== 0)
                    ? Math.round((ref + fba) * 0.02 * 100) / 100
                    : 0);
                await this.prisma.product.update({
                  where: { id: itemProduct.id },
                  data: {
                    estimatedAmazonFeePerUnit: breakdown.total,
                    estimatedReferralFeePerUnit: breakdown.referralFee ?? undefined,
                    estimatedFbaFeePerUnit: breakdown.fbaFee ?? undefined,
                    estimatedDigitalServiceFeePerUnit:
                      digitalToSave || undefined,
                    estimatedAmazonFeeUpdatedAt: new Date(),
                  },
                });
                itemFees = breakdown.total * quantityOrdered;
              }
            } catch (err) {
              this.logger.warn(
                '[syncRecentOrdersToDb] fee estimate fetch failed for order item',
                {
                  orderItemId,
                  sku,
                  asin,
                  err: (err as Error)?.message,
                },
              );
            }
          }

          const cogsPerUnit = itemProduct.costOfGoods
            ? Number(itemProduct.costOfGoods)
            : null;
          const cogsTotal =
            cogsPerUnit != null ? cogsPerUnit * quantityOrdered : null;
          const taxChargedNum = Number.isNaN(taxCharged) ? 0 : taxCharged;
          let vatResult = this.computeOrderItemVatAndProfit(
            revenueTotal,
            cogsTotal,
            quantityOrdered,
            orderDate,
            itemFees,
            taxChargedNum,
            vatSettings,
          );
          const feesFromFinances =
            (orderItemId && feeByOrderItemId.has(orderItemId)) ||
            (sku && feeBySku.has(sku)) ||
            usedSameAsinSettled ||
            usedOrderLevelFinances;
          const settledBreakdown =
            (orderItemId && breakdownByOrderItemId.get(orderItemId)) ??
            (sku && breakdownBySku.get(sku)) ??
            null;
          const existingItem = await this.prisma.orderItem.findUnique({
            where: {
              orderDbId_orderItemId: {
                orderDbId: persistedOrder.id,
                orderItemId,
              },
            },
            select: { amazonFeesTotal: true, profit: true, feesSource: true },
          });
          let finalFees = Number.isNaN(itemFees) ? 0 : Number(itemFees.toFixed(2));
          // Never overwrite a saved estimate with 0: keep existing order-item estimate until settled fees arrive.
          if (
            finalFees === 0 &&
            existingItem &&
            existingItem.amazonFeesTotal != null &&
            Number(existingItem.amazonFeesTotal) !== 0 &&
            (existingItem.feesSource as string) === 'estimate'
          ) {
            finalFees = Number(existingItem.amazonFeesTotal);
            vatResult = this.computeOrderItemVatAndProfit(
              revenueTotal,
              cogsTotal,
              quantityOrdered,
              orderDate,
              finalFees,
              taxChargedNum,
              vatSettings,
            );
          }
          const finalProfit = vatResult.profit != null ? Number(vatResult.profit.toFixed(2)) : null;
          const vatData: Record<string, number | null> = {};
          if (vatResult.salePriceIncVat != null) vatData.salePriceIncVat = vatResult.salePriceIncVat;
          if (vatResult.salePriceExVat != null) vatData.salePriceExVat = vatResult.salePriceExVat;
          if (vatResult.saleVatAmount != null) vatData.saleVatAmount = vatResult.saleVatAmount;
          if (vatResult.unitCostIncVat != null) vatData.unitCostIncVat = vatResult.unitCostIncVat;
          if (vatResult.unitCostExVat != null) vatData.unitCostExVat = vatResult.unitCostExVat;
          if (vatResult.unitVatAmount != null) vatData.unitVatAmount = vatResult.unitVatAmount;
          if (vatResult.deliveryIncVat != null) vatData.deliveryIncVat = vatResult.deliveryIncVat;
          if (vatResult.deliveryExVat != null) vatData.deliveryExVat = vatResult.deliveryExVat;
          if (vatResult.deliveryVatAmount != null) vatData.deliveryVatAmount = vatResult.deliveryVatAmount;
          if (vatResult.prepIncVat != null) vatData.prepIncVat = vatResult.prepIncVat;
          if (vatResult.prepExVat != null) vatData.prepExVat = vatResult.prepExVat;
          if (vatResult.prepVatAmount != null) vatData.prepVatAmount = vatResult.prepVatAmount;
          if (vatResult.amazonFeesExVat != null) vatData.amazonFeesExVat = vatResult.amazonFeesExVat;
          if (vatResult.amazonFeesIncVat != null) vatData.amazonFeesIncVat = vatResult.amazonFeesIncVat;
          if (vatResult.amazonFeesVatAmount != null) vatData.amazonFeesVatAmount = vatResult.amazonFeesVatAmount;
          const updateFeesAndProfit =
            feesFromFinances || (existingItem?.feesSource as string) !== 'finances';
          const breakdownSum = settledBreakdown
            ? settledBreakdown.referral + settledBreakdown.fba + settledBreakdown.digital
            : 0;
          const hasBreakdown = settledBreakdown && breakdownSum !== 0;
          const totalFeeAbs = Math.abs(finalFees);
          const settledFeeFields =
            feesFromFinances && hasBreakdown
              ? {
                  settledReferralFeeTotal: Number(settledBreakdown!.referral.toFixed(2)),
                  settledFbaFeeTotal: Number(settledBreakdown!.fba.toFixed(2)),
                  settledDigitalServiceFeeTotal: Number(settledBreakdown!.digital.toFixed(2)),
                }
              : feesFromFinances && totalFeeAbs > 0
                ? (() => {
                    const half = Number((totalFeeAbs / 2).toFixed(2));
                    return {
                      settledReferralFeeTotal: half,
                      settledFbaFeeTotal: half,
                      settledDigitalServiceFeeTotal: 0,
                    };
                  })()
                : {};
          const updatePayload = {
            userId,
            productId: itemProduct.id,
            marketplace: ORDER_MARKETPLACE_CANONICAL,
            orderId: amazonOrderId,
            sku: sku || genericSku,
            asin,
            quantity: quantityOrdered,
            revenueTotal,
            shippingChargedTotal: Number.isNaN(shippingCharged) ? 0 : shippingCharged,
            taxChargedTotal: Number.isNaN(taxCharged) ? 0 : taxCharged,
            ...(updateFeesAndProfit
              ? {
                  amazonFeesTotal: finalFees,
                  profit: finalProfit,
                  feesSource: feesFromFinances ? 'finances' : 'estimate',
                  ...settledFeeFields,
                }
              : {}),
            cogsTotal,
            ...vatData,
            rawResponse: it,
            orderDate,
          };
          await (this.prisma as any).orderItem.upsert({
            where: {
              orderDbId_orderItemId: {
                orderDbId: persistedOrder.id,
                orderItemId,
              },
            },
            update: updatePayload,
            create: {
              userId,
              orderDbId: persistedOrder.id,
              productId: itemProduct.id,
              marketplace: ORDER_MARKETPLACE_CANONICAL,
              orderId: amazonOrderId,
              orderItemId,
              sku: sku || genericSku,
              asin,
              quantity: quantityOrdered,
              revenueTotal,
              shippingChargedTotal: Number.isNaN(shippingCharged) ? 0 : shippingCharged,
              taxChargedTotal: Number.isNaN(taxCharged) ? 0 : taxCharged,
              amazonFeesTotal: finalFees,
              feesSource: feesFromFinances ? 'finances' : 'estimate',
              ...settledFeeFields,
              cogsTotal,
              profit: finalProfit,
              ...vatData,
              rawResponse: it,
              orderDate,
            },
          });
        }
        orderItemsWrittenThisSync += itemsToWrite;
        if (maxOrderItems != null && orderItemsWrittenThisSync >= maxOrderItems) {
          this.logger.log(
            `[syncRecentOrdersToDb] initial sync: wrote ${orderItemsWrittenThisSync} order items, stopping (userId=${userId})`,
          );
          break;
        }
      }
    }

    // Backfill any missing line items for orders in the window. Skip during initial sync so we don't add more than maxOrderItems.
    // This is important because:
    // - getOrders is incremental (cursor-based) and may not keep returning older orders
    // - getOrderItems can be rate-limited (429), so some orders won't get items on the first pass
    //
    // We retry a small number per run to stay under quotas.
    try {
      if (maxOrders == null) {
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
          rawResponse: true,
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

          const orderTotalAmt = this.parseOrderTotalAmountFromOrderJson(ord.rawResponse);
          const lineRevenues = this.computeLineRevenueTotals(items, orderTotalAmt);

          for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
            const it = items[itemIdx];
            const orderItemId = String(it?.OrderItemId ?? '');
            const sku = String(it?.SellerSKU ?? '');
            const asin = (it?.ASIN as string | undefined) ?? null;
            const qty = Number(it?.QuantityOrdered ?? 0);
            const quantityOrdered = qty > 0 ? qty : 1;
            const revenueTotal = lineRevenues[itemIdx] ?? 0;
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
      }
    } catch {
      // non-fatal
    }

    // Update sync cursor only when doing a full sync. When maxOrders is set (initial sync), do NOT advance the cursor so post-initial-sync can run a full 30-day fetch.
    if (maxOrders == null) {
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

    // Recompute daily KPI aggregates for this user based on the latest orders.
    try {
      await this.recomputeDailyKpiSummary(userId);
    } catch (err) {
      // Non-fatal: log and continue; raw orders are still persisted.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[AmazonService.syncRecentOrdersToDb] failed to recompute daily KPI summary (userId=${userId}): ${msg}`,
      );
    }

    // Catalog category backfill for new ASINs is no longer run here (was blocking order sync).
    // It runs during FBA inventory sync and can be added as a background job if needed.
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

    this.logger.log(
      `[syncRecentOrdersForAllSellers] found ${accounts.length} seller account(s), syncing orders`,
    );

    for (const { userId } of accounts) {
      try {
        this.logger.log(`[syncRecentOrdersForAllSellers] syncing orders for userId=${userId}`);
        await this.syncRecentOrdersToDb(userId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[AmazonService.syncRecentOrdersForAllSellers] failed (userId=${userId}): ${msg}`,
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

  /**
   * Top sellers: OrderItem first (best product details), then fill from Order if needed.
   * Best by total profit, then by units. Period = this month or last 30d.
   */
  async getTopProfitableProducts(
    orgId: string,
    limit = 10,
    period: '30d' | 'month' = '30d',
    marketplaceId?: string,
  ) {
    const marketplaceFilter = this.resolveMarketplaceFilter(marketplaceId);
    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const startDate =
      period === 'month'
        ? new Date(nowSafe.getFullYear(), nowSafe.getMonth(), 1)
        : new Date(nowSafe.getTime() - 30 * 24 * 60 * 60 * 1000);
    const userIds = await this.getOrgMemberUserIds(orgId);
    const dateFilter = {
      orderDate: { gte: startDate, lte: nowSafe },
    };

    // Exclude synthetic products (AMAZON_GENERIC, AMAZON_MULTI) so real products with images show first
    const genericProductIds = await this.prisma.product
      .findMany({
        where: {
          userId: { in: userIds },
          sku: { in: ['AMAZON_GENERIC', 'AMAZON_MULTI'] },
        },
        select: { id: true },
      })
      .then((rows) => rows.map((r) => r.id));
    const excludeProductIds =
      genericProductIds.length > 0 ? { notIn: genericProductIds } : undefined;

    // 1) OrderItem: top by profit, then fill by units (exclude generic so real products + images show)
    const byProfit = await (this.prisma as any).orderItem.groupBy({
      by: ['productId'],
      where: {
        userId: { in: userIds },
        marketplace: 'amazon',
        ...dateFilter,
        profit: { not: null },
        ...(excludeProductIds ? { productId: excludeProductIds } : {}),
      },
      _sum: { revenueTotal: true, profit: true, quantity: true },
      _count: { _all: true },
      orderBy: { _sum: { profit: 'desc' } },
      take: limit,
    });

    let mergedRows: any[] = [...byProfit];
    if (mergedRows.length < limit) {
      const excludeIds = [
        ...byProfit.map((r: any) => r.productId),
        ...(genericProductIds ?? []),
      ];
      const byUnits = await (this.prisma as any).orderItem.groupBy({
        by: ['productId'],
        where: {
          userId: { in: userIds },
          marketplace: marketplaceFilter,
          ...dateFilter,
          ...(excludeIds.length > 0 ? { productId: { notIn: excludeIds } } : {}),
        },
        _sum: { revenueTotal: true, profit: true, quantity: true },
        _count: { _all: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: limit - mergedRows.length,
      });
      mergedRows = [...byProfit, ...byUnits];
    }

    // 2) If still no rows, include generic products (OrderItem then Order) so something shows
    if (mergedRows.length === 0) {
      const byProfitWithGeneric = await (this.prisma as any).orderItem.groupBy({
        by: ['productId'],
        where: {
          userId: { in: userIds },
          marketplace: marketplaceFilter,
          ...dateFilter,
          profit: { not: null },
        },
        _sum: { revenueTotal: true, profit: true, quantity: true },
        _count: { _all: true },
        orderBy: { _sum: { profit: 'desc' } },
        take: limit,
      });
      mergedRows = [...byProfitWithGeneric];
      if (mergedRows.length < limit) {
        const excludeIds = byProfitWithGeneric.map((r: any) => r.productId);
        const byUnits = await (this.prisma as any).orderItem.groupBy({
          by: ['productId'],
          where: {
            userId: { in: userIds },
          marketplace: marketplaceFilter,
            ...dateFilter,
            ...(excludeIds.length > 0 ? { productId: { notIn: excludeIds } } : {}),
          },
          _sum: { revenueTotal: true, profit: true, quantity: true },
          _count: { _all: true },
          orderBy: { _sum: { quantity: 'desc' } },
          take: limit - mergedRows.length,
        });
        mergedRows = [...byProfitWithGeneric, ...byUnits];
      }
      if (mergedRows.length === 0) {
        const orderRows = await (this.prisma as any).order.groupBy({
          by: ['productId'],
          where: {
            userId: { in: userIds },
            marketplace: marketplaceFilter,
            ...dateFilter,
          },
          _sum: { quantity: true, totalProfit: true },
          _count: { _all: true },
          orderBy: { _sum: { totalProfit: 'desc' } },
          take: limit,
        });
        if (orderRows.length > 0) {
          mergedRows = orderRows.map((r: any) => ({
            productId: r.productId,
            _sum: {
              quantity: r._sum?.quantity ?? 0,
              revenueTotal: 0,
              profit: r._sum?.totalProfit ?? 0,
            },
            _count: { _all: r._count?._all ?? 0 },
          }));
        }
      }
    }

    if (mergedRows.length === 0) return [];

    const allProductIds = mergedRows.map((r: any) => r.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: allProductIds } },
      select: { id: true, sku: true, asin: true, title: true, imageUrl: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    return mergedRows.map((r: any) => {
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
        marginPct:
          Number(r._sum?.revenueTotal ?? 0) > 0
            ? Number(r._sum?.profit ?? 0) / Number(r._sum?.revenueTotal ?? 0)
            : 0,
        lineItemsCount: r._count?._all ?? 0,
      };
    });
  }

  /**
   * Replenishment list: all products with stock value zero (out of stock), sorted by most sold first, then estimated profit.
   * Includes every SKU that has availableQty <= 0 (or no inventory record). Order stats are attached when present.
   */
  async getReplenishProducts(orgId: string, limit = 5000, marketplaceId?: string) {
    const marketplaceFilter = this.resolveMarketplaceFilter(marketplaceId);
    const userIds = await this.getOrgMemberUserIds(orgId);

    // All products for org, with inventory (so we can filter by stock)
    const products = await this.prisma.product.findMany({
      where: { userId: { in: userIds } },
      select: {
        id: true,
        sku: true,
        asin: true,
        title: true,
        imageUrl: true,
        inventory: { select: { availableQty: true } },
      },
    });

    // Only products with zero stock (availableQty <= 0 or no inventory row)
    const zeroStockProducts = products.filter((p) => (p.inventory?.availableQty ?? 0) <= 0);
    if (zeroStockProducts.length === 0) return [];

    const productIds = zeroStockProducts.map((p) => p.id);

    // Order stats for all products (so we can sort zero-stock by sales/profit)
    let orderStats: { productId: string; _sum: { quantity?: number; profit?: number; totalProfit?: number }; _max: { orderDate: Date } }[];
    const orderItemStats = await (this.prisma as any).orderItem.groupBy({
      by: ['productId'],
      where: {
        userId: { in: userIds },
        marketplace: marketplaceFilter,
        productId: { in: productIds },
      },
      _sum: { quantity: true, profit: true },
      _max: { orderDate: true },
    });
    if (orderItemStats.length > 0) {
      orderStats = orderItemStats;
    } else {
      const orderStatsFromOrders = await (this.prisma as any).order.groupBy({
        by: ['productId'],
        where: {
          userId: { in: userIds },
          marketplace: marketplaceFilter,
          productId: { in: productIds },
        },
        _sum: { quantity: true, totalProfit: true },
        _max: { orderDate: true },
      });
      orderStats = orderStatsFromOrders.map((r: any) => ({
        productId: r.productId,
        _sum: { quantity: r._sum?.quantity, profit: r._sum?.totalProfit ?? null },
        _max: r._max,
      }));
    }

    const statsByProductId = new Map(
      orderStats.map((r: any) => [
        r.productId,
        {
          unitsSold: Number(r._sum?.quantity ?? 0),
          estimatedProfit: Number(r._sum?.profit ?? 0),
          lastSold: r._max?.orderDate ?? null,
        },
      ]),
    );

    const combined = zeroStockProducts.map((p) => {
      const stats = statsByProductId.get(p.id) ?? {
        unitsSold: 0,
        estimatedProfit: 0,
        lastSold: null as Date | null,
      };
      return {
        productId: p.id,
        imageUrl: p.imageUrl ?? null,
        title: p.title ?? null,
        sku: p.sku,
        asin: p.asin ?? null,
        lastSold: stats.lastSold ? (stats.lastSold as Date).toISOString() : null,
        outOfStock: true,
        unitsSold: stats.unitsSold,
        estimatedProfit: stats.estimatedProfit,
      };
    });

    // Most sold with zero stock first, then by estimated profit
    combined.sort((a, b) => {
      if (b.unitsSold !== a.unitsSold) return b.unitsSold - a.unitsSold;
      return b.estimatedProfit - a.estimatedProfit;
    });

    return combined.slice(0, limit);
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

  /**
   * Sort product IDs by available stock (desc) then sales revenue (desc) for COGS tab.
   */
  private async sortProductIdsByStockAndRevenue(
    userIds: string[],
    productIds: string[],
  ): Promise<string[]> {
    if (productIds.length === 0) return [];
    const invRows = await this.prisma.inventory.findMany({
      where: { userId: { in: userIds }, productId: { in: productIds } },
      select: { productId: true, availableQty: true },
    });
    const stockByProduct = new Map(invRows.map((r) => [r.productId, r.availableQty ?? 0]));
    const revenueRows = await (this.prisma as any).orderItem.groupBy({
      by: ['productId'],
      where: { userId: { in: userIds }, productId: { in: productIds }, marketplace: 'amazon' },
      _sum: { revenueTotal: true },
    });
    const revenueByProduct = new Map(
      Array.isArray(revenueRows)
        ? revenueRows.map((r: any) => [r.productId, Number(r._sum?.revenueTotal ?? 0)])
        : [],
    );
    return [...productIds].sort((a, b) => {
      const stockA = stockByProduct.get(a) ?? 0;
      const stockB = stockByProduct.get(b) ?? 0;
      if (stockB !== stockA) return stockB - stockA;
      const revA = revenueByProduct.get(a) ?? 0;
      const revB = revenueByProduct.get(b) ?? 0;
      return revB - revA;
    });
  }

  /**
   * List products that have at least one Inventory row (from FBA sync).
   * Sorted by available stock (desc) then sales revenue (desc). Paginated.
   * Returns every inventory SKU even if Product row is missing (placeholder sku/title then).
   */
  async listProductsFromInventory(
    orgId: string,
    opts?: { take?: number; skip?: number },
    marketplaceId?: string,
  ): Promise<{ total: number; items: Array<{ id: string; sku: string; asin: string | null; title: string | null; imageUrl: string | null }> }> {
    const userIds = await this.getOrgMemberUserIds(orgId);
    const take = Math.max(1, Math.min(100, opts?.take ?? 10));
    const skip = Math.max(0, opts?.skip ?? 0);

    const invRows = marketplaceId
      ? await this.prisma.inventoryByMarketplace.findMany({
          where: { userId: { in: userIds }, marketplaceId },
          select: { productId: true },
        })
      : await this.prisma.inventory.findMany({
          where: { userId: { in: userIds } },
          select: { productId: true },
        });
    const productIds = [...new Set(invRows.map((r) => r.productId))];
    const total = productIds.length;
    if (total === 0) return { total: 0, items: [] };

    const sortedIds = await this.sortProductIdsByStockAndRevenue(userIds, productIds);
    const pageIds = sortedIds.slice(skip, skip + take);

    const products = await this.prisma.product.findMany({
      where: { id: { in: pageIds } },
      select: { id: true, sku: true, asin: true, title: true, imageUrl: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const items = pageIds.map((id) => {
      const p = byId.get(id);
      if (p) return p;
      return { id, sku: id, asin: null as string | null, title: null as string | null, imageUrl: null as string | null };
    });
    return { total, items };
  }

  /**
   * List inventory SKUs that have at least one cost entry (Purchase row or Product.costOfGoods > 0).
   * Paginated for the "Complete" tab.
   */
  async listProductsWithCostFromInventory(
    orgId: string,
    opts?: { take?: number; skip?: number },
    marketplaceId?: string,
  ): Promise<{ total: number; items: Array<{ id: string; sku: string; asin: string | null; title: string | null; imageUrl: string | null }> }> {
    const userIds = await this.getOrgMemberUserIds(orgId);
    const take = Math.max(1, Math.min(100, opts?.take ?? 10));
    const skip = Math.max(0, opts?.skip ?? 0);

    const invRows = marketplaceId
      ? await this.prisma.inventoryByMarketplace.findMany({
          where: { userId: { in: userIds }, marketplaceId },
          select: { productId: true },
        })
      : await this.prisma.inventory.findMany({
          where: { userId: { in: userIds } },
          select: { productId: true },
        });
    const inventoryProductIds = [...new Set(invRows.map((r) => r.productId))];
    if (inventoryProductIds.length === 0) return { total: 0, items: [] };

    const purchasedDistinct = await (this.prisma as any).purchase.groupBy({
      by: ['productId'],
      where: { userId: { in: userIds }, productId: { in: inventoryProductIds } },
    });
    const hasPurchaseIds = new Set(
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
        if (typeof anyVal?.toNumber === 'function') return anyVal.toNumber();
        if (typeof anyVal?.toString === 'function') return Number(anyVal.toString());
      }
      return Number(value as any);
    };
    const productsWithCogs = await this.prisma.product.findMany({
      where: {
        userId: { in: userIds },
        id: { in: inventoryProductIds },
        costOfGoods: { not: null },
      },
      select: { id: true, costOfGoods: true },
    });
    const hasCogsIds = new Set(
      productsWithCogs.filter((p) => toNum(p.costOfGoods) > 0).map((p) => p.id),
    );

    const completeIds = inventoryProductIds.filter(
      (id) => hasPurchaseIds.has(id) || hasCogsIds.has(id),
    );
    const sortedCompleteIds = await this.sortProductIdsByStockAndRevenue(userIds, completeIds);

    const total = sortedCompleteIds.length;
    const pageIds = sortedCompleteIds.slice(skip, skip + take);
    if (pageIds.length === 0) return { total, items: [] };

    const products = await this.prisma.product.findMany({
      where: { id: { in: pageIds } },
      select: { id: true, sku: true, asin: true, title: true, imageUrl: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const items = pageIds.map((id) => {
      const p = byId.get(id);
      if (p) return p;
      return { id, sku: id, asin: null as string | null, title: null as string | null, imageUrl: null as string | null };
    });
    return { total, items };
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
          orderDate: true,
        },
      });

      const vatSettings = await this.getVatSettingsForUser(updated.userId);
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

        const cogsTotalNum = cogsTotal == null ? 0 : cogsTotal;
        const orderDate = it.orderDate ? new Date(it.orderDate) : new Date();
        const vatResult = this.computeOrderItemVatAndProfit(
          revenueTotal,
          cogsTotalNum,
          safeQty,
          orderDate,
          amazonFeesTotal,
          taxChargedTotal,
          vatSettings,
        );
        const profit =
          vatResult.profit != null ? Number(vatResult.profit.toFixed(2)) : null;
        const vatData: Record<string, number | null> = {};
        if (vatResult.salePriceIncVat != null) vatData.salePriceIncVat = vatResult.salePriceIncVat;
        if (vatResult.salePriceExVat != null) vatData.salePriceExVat = vatResult.salePriceExVat;
        if (vatResult.saleVatAmount != null) vatData.saleVatAmount = vatResult.saleVatAmount;
        if (vatResult.unitCostIncVat != null) vatData.unitCostIncVat = vatResult.unitCostIncVat;
        if (vatResult.unitCostExVat != null) vatData.unitCostExVat = vatResult.unitCostExVat;
        if (vatResult.unitVatAmount != null) vatData.unitVatAmount = vatResult.unitVatAmount;
        if (vatResult.deliveryIncVat != null) vatData.deliveryIncVat = vatResult.deliveryIncVat;
        if (vatResult.deliveryExVat != null) vatData.deliveryExVat = vatResult.deliveryExVat;
        if (vatResult.deliveryVatAmount != null) vatData.deliveryVatAmount = vatResult.deliveryVatAmount;
        if (vatResult.prepIncVat != null) vatData.prepIncVat = vatResult.prepIncVat;
        if (vatResult.prepExVat != null) vatData.prepExVat = vatResult.prepExVat;
        if (vatResult.prepVatAmount != null) vatData.prepVatAmount = vatResult.prepVatAmount;
        if (vatResult.amazonFeesExVat != null) vatData.amazonFeesExVat = vatResult.amazonFeesExVat;
        if (vatResult.amazonFeesIncVat != null) vatData.amazonFeesIncVat = vatResult.amazonFeesIncVat;
        if (vatResult.amazonFeesVatAmount != null) vatData.amazonFeesVatAmount = vatResult.amazonFeesVatAmount;

        await (this.prisma as any).orderItem.update({
          where: { id: it.id },
          data: {
            cogsTotal: cogsTotal == null ? null : Number(cogsTotal.toFixed(2)),
            profit,
            ...vatData,
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

  /**
   * Dev-only: call SP-API getOrders (no persist) and return count + debug. Tries multiple request variants.
   */
  async testOrdersApiFetch(
    orgId: string,
    preferredUserId?: string,
  ): Promise<{
    orderCount: number;
    createdAfter: string;
    createdBefore: string;
    marketplaceCount: number;
    sampleOrderIds: string[];
    responseKeys?: string[];
    payloadKeys?: string[];
    tried?: string[];
    error?: string;
  }> {
    try {
      const userIds = await this.getOrgMemberUserIds(orgId);
      const withAccount = await this.prisma.sellerAccount.findFirst({
        where: {
          userId: userIds.length && preferredUserId && userIds.includes(preferredUserId) ? preferredUserId : { in: userIds },
          marketplace: 'amazon',
          isActive: true,
        },
        select: { userId: true },
      });
      if (!withAccount) {
        return { orderCount: 0, createdAfter: '', createdBefore: '', marketplaceCount: 0, sampleOrderIds: [], error: 'No seller account for org' };
      }
      const credentials = await this.getAmazonCredentialsForUser(withAccount.userId);
      const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
      const start = new Date(nowSafe.getTime() - 30 * 24 * 60 * 60 * 1000);
      const afterIso = start.toISOString().split('.')[0] + 'Z';
      const beforeIso = nowSafe.toISOString().split('.')[0] + 'Z';
      // Client uses UK-only for EU; we pass 1 marketplace so marketplaceCount in response is accurate
      const marketplaceIds = credentials.region === 'eu' ? ['A1F83G8C2ARO7P'] : (credentials.region === 'na' ? ['ATVPDKIKX0DER'] : ['A1VC38T7YXB528']);
      const orderStatuses = ['Shipped', 'Unshipped', 'PartiallyShipped', 'Canceled'];
      const tried: string[] = [];
      let data: any = null;
      let lastError: string | null = null;

      const parseOrders = (d: any): Array<{ AmazonOrderId?: string }> => {
        if (!d || typeof d !== 'object') return [];
        const p = d.payload ?? d.Payload ?? d;
        if (!p || typeof p !== 'object') return [];
        const list = p.Orders ?? p.orders;
        return Array.isArray(list) ? list : [];
      };

      const getNextToken = (d: any): string | undefined => {
        if (!d || typeof d !== 'object') return undefined;
        const p = d.payload ?? d.Payload ?? d;
        return p?.NextToken ?? undefined;
      };

      /** Fetch all pages via NextToken and return aggregated orders + first response metadata. */
      const fetchAllOrders = async (params: Parameters<typeof this.spApiClient.getOrders>[1]): Promise<{ data: any; orders: Array<{ AmazonOrderId?: string }> }> => {
        const orders: Array<{ AmazonOrderId?: string }> = [];
        let next: string | undefined;
        let firstData: any = null;
        do {
          const reqParams = next ? { nextToken: next } : (params ?? {});
          const res = await this.spApiClient.getOrders(credentials, reqParams);
          if (!firstData) firstData = res;
          orders.push(...parseOrders(res));
          next = getNextToken(res);
        } while (next);
        return { data: firstData, orders };
      };

      // 1) LastUpdatedAfter/Before, with OrderStatuses
      try {
        tried.push('LastUpdatedAfter+OrderStatuses');
        const { data: res1, orders: orders1 } = await fetchAllOrders({
          lastUpdatedAfter: afterIso,
          lastUpdatedBefore: beforeIso,
          marketplaceIds,
          orderStatuses,
        });
        data = res1;
        if (orders1.length > 0) {
          return {
            orderCount: orders1.length,
            createdAfter: afterIso,
            createdBefore: beforeIso,
            marketplaceCount: marketplaceIds.length,
            sampleOrderIds: orders1.slice(0, 5).map((o) => o?.AmazonOrderId ?? '').filter(Boolean),
            responseKeys: data ? Object.keys(data) : [],
            payloadKeys: data?.payload ? Object.keys(data.payload) : data?.Payload ? Object.keys(data.Payload) : undefined,
            tried,
          };
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }

      // 2) LastUpdatedAfter/Before, NO OrderStatuses (wider filter)
      try {
        tried.push('LastUpdatedAfter+noOrderStatuses');
        const { data: res2, orders: orders2 } = await fetchAllOrders({
          lastUpdatedAfter: afterIso,
          lastUpdatedBefore: beforeIso,
          marketplaceIds,
        });
        data = res2;
        if (orders2.length > 0) {
          return {
            orderCount: orders2.length,
            createdAfter: afterIso,
            createdBefore: beforeIso,
            marketplaceCount: marketplaceIds.length,
            sampleOrderIds: orders2.slice(0, 5).map((o) => o?.AmazonOrderId ?? '').filter(Boolean),
            responseKeys: data ? Object.keys(data) : [],
            payloadKeys: data?.payload ? Object.keys(data.payload) : data?.Payload ? Object.keys(data.Payload) : undefined,
            tried,
          };
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }

      // 3) CreatedAfter/CreatedBefore, with OrderStatuses
      try {
        tried.push('CreatedAfter+OrderStatuses');
        const { data: res3, orders: orders3 } = await fetchAllOrders({
          createdAfter: afterIso,
          createdBefore: beforeIso,
          marketplaceIds,
          orderStatuses,
        });
        data = res3;
        if (orders3.length > 0) {
          return {
            orderCount: orders3.length,
            createdAfter: afterIso,
            createdBefore: beforeIso,
            marketplaceCount: marketplaceIds.length,
            sampleOrderIds: orders3.slice(0, 5).map((o) => o?.AmazonOrderId ?? '').filter(Boolean),
            responseKeys: data ? Object.keys(data) : [],
            payloadKeys: data?.payload ? Object.keys(data.payload) : data?.Payload ? Object.keys(data.Payload) : undefined,
            tried,
          };
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }

      const orders = data ? parseOrders(data) : [];
      return {
        orderCount: orders.length,
        createdAfter: afterIso,
        createdBefore: beforeIso,
        marketplaceCount: marketplaceIds.length,
        sampleOrderIds: orders.slice(0, 5).map((o) => o?.AmazonOrderId ?? '').filter(Boolean),
        responseKeys: data ? Object.keys(data) : [],
        payloadKeys: data?.payload ? Object.keys(data.payload) : data?.Payload ? Object.keys(data.Payload) : undefined,
        tried,
        error: lastError ?? (orders.length === 0 ? 'All variants returned 0 orders' : undefined),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[testOrdersApiFetch] failed: ${msg}`);
      return {
        orderCount: 0,
        createdAfter: '',
        createdBefore: '',
        marketplaceCount: 0,
        sampleOrderIds: [],
        error: msg,
      };
    }
  }

  /**
   * Dev-only: return counts to debug "zero orders" (org members + orders + order_items for that org).
   * Includes whether org members have a seller account (Amazon connected) so we can see if sync runs for them.
   */
  async getOrdersDebug(orgId: string): Promise<{
    orgId: string;
    orgMemberCount: number;
    memberUserIds: string[];
    orderCount: number;
    orderItemCount: number;
    memberHasSellerAccount: boolean;
    message?: string;
  }> {
    let userIds: string[];
    try {
      userIds = await this.getOrgMemberUserIds(orgId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        orgId,
        orgMemberCount: 0,
        memberUserIds: [],
        orderCount: 0,
        orderItemCount: 0,
        memberHasSellerAccount: false,
        message: `getOrgMemberUserIds failed: ${msg}`,
      };
    }
    if (userIds.length === 0) {
      return { orgId, orgMemberCount: 0, memberUserIds: [], orderCount: 0, orderItemCount: 0, memberHasSellerAccount: false, message: 'No org members' };
    }
    const [orderCount, orderItemCount, sellerAccounts] = await Promise.all([
      this.prisma.order.count({
        where: { userId: { in: userIds }, marketplace: 'amazon' },
      }),
      this.prisma.orderItem.count({
        where: { userId: { in: userIds }, marketplace: 'amazon' },
      }),
      this.prisma.sellerAccount.findMany({
        where: { userId: { in: userIds }, marketplace: 'amazon', isActive: true },
        select: { userId: true },
      }),
    ]);
    const memberHasSellerAccount = sellerAccounts.length > 0;
    return { orgId, orgMemberCount: userIds.length, memberUserIds: userIds, orderCount, orderItemCount, memberHasSellerAccount };
  }

  /**
   * List order items for the org (most recent first). Each row uses stored amazonFeesTotal and profit:
   * when Finances API has settled (feesSource='finances') those are exact concluded values for past sales.
   */
  async listOrders(orgId: string, marketplaceId?: string) {
    const marketplaceFilter = this.resolveMarketplaceFilter(marketplaceId);
    let userIds: string[];
    try {
      userIds = await this.getOrgMemberUserIds(orgId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[listOrders] getOrgMemberUserIds failed (orgId=${orgId}): ${msg}`);
      return [];
    }
    this.logger.log(`[listOrders] orgId=${orgId} orgMemberCount=${userIds.length}`);
    if (userIds.length === 0) {
      this.logger.log(`[listOrders] returning []: no org members for orgId=${orgId}`);
      return [];
    }
    let items: Awaited<
      ReturnType<
        typeof this.prisma.orderItem.findMany<{
          where: { userId: { in: string[] }; marketplace: string };
          orderBy: [{ orderDate: 'desc' }];
          select: {
            id: true;
            orderId: true;
            orderItemId: true;
            orderDate: true;
            updatedAt: true;
            sku: true;
            asin: true;
            quantity: true;
            orderDbId: true;
            revenueTotal: true;
            taxChargedTotal: true;
            amazonFeesTotal: true;
            feesSource: true;
            settledReferralFeeTotal: true;
            settledFbaFeeTotal: true;
            settledDigitalServiceFeeTotal: true;
            profit: true;
            cogsTotal: true;
            productId: true;
            product: { select: { title: true; imageUrl: true; id: true; estimatedReferralFeePerUnit: true; estimatedFbaFeePerUnit: true; estimatedDigitalServiceFeePerUnit: true; estimatedAmazonFeePerUnit: true } };
          };
        }>
      >
    >;
    try {
      items = await this.prisma.orderItem.findMany({
        where: { userId: { in: userIds }, marketplace: marketplaceFilter as any },
        orderBy: [{ orderDate: 'desc' }],
        select: {
          id: true,
          orderId: true,
          orderItemId: true,
          orderDate: true,
          updatedAt: true,
          sku: true,
          asin: true,
          quantity: true,
          orderDbId: true,
          revenueTotal: true,
          taxChargedTotal: true,
          amazonFeesTotal: true,
          feesSource: true,
          settledReferralFeeTotal: true,
          settledFbaFeeTotal: true,
          settledDigitalServiceFeeTotal: true,
          profit: true,
          cogsTotal: true,
          productId: true,
          product: {
            select: {
              title: true,
              imageUrl: true,
              id: true,
              estimatedReferralFeePerUnit: true,
              estimatedFbaFeePerUnit: true,
              estimatedDigitalServiceFeePerUnit: true,
              estimatedAmazonFeePerUnit: true,
            },
          },
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[listOrders] orderItem.findMany failed (orgId=${orgId}): ${msg}`);
      return [];
    }

    // Same Amazon order line can appear twice if duplicate parent `orders` rows existed (marketplace mismatch).
    items = this.dedupeOrderItemsByOrderLine(
      items as Array<{
        id: string;
        orderId: string;
        orderItemId?: string | null;
        feesSource?: string | null;
        updatedAt?: Date | string;
      }>,
    ) as typeof items;

    this.logger.log(`[listOrders] orgId=${orgId} orderItemCount=${items.length}`);
    const productIds = [...new Set(items.map((i) => i.productId).filter(Boolean))];
    const orderDbIds = [
      ...new Set(
        items
          .map((i: any) => (i.orderDbId != null ? String(i.orderDbId) : ''))
          .filter(Boolean),
      ),
    ];
    const inventoryByProductId = new Map<
      string,
      { availableQty: number; totalQty: number }
    >();
    const orderPriceByDbId = new Map<string, { itemPrice: number; quantity: number }>();
    const skuUnitPriceFallback = new Map<string, number>();
    const productFeesById = new Map<
      string,
      { referralPerUnit: number | null; fbaPerUnit: number | null; digitalServicePerUnit: number | null; amazonFeePerUnit: number | null }
    >();
    const safeNum = (v: unknown): number => {
      if (v == null) return 0;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      const o = v as { toNumber?: () => number; toString?: () => string };
      if (o?.toNumber && typeof o.toNumber === 'function') return o.toNumber();
      if (o?.toString && typeof o.toString === 'function') return Number(o.toString()) || 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    if (productIds.length > 0) {
      try {
        const inv = await this.prisma.inventory.findMany({
          where: { productId: { in: productIds } },
          select: { productId: true, availableQty: true, totalQty: true },
        });
        for (const row of inv) {
          inventoryByProductId.set(row.productId, {
            availableQty: row.availableQty,
            totalQty: row.totalQty,
          });
        }
      } catch {
        // Non-fatal: proceed without inventory data
      }
      try {
        const placeholders = productIds.map((_, i) => `$${i + 1}`).join(',');
        const sql = `SELECT id, estimated_referral_fee_per_unit, estimated_fba_fee_per_unit, estimated_digital_service_fee_per_unit, estimated_amazon_fee_per_unit FROM products WHERE id IN (${placeholders})`;
        const products = await this.prisma.$queryRawUnsafe<
          Array<{
            id: string;
            estimated_referral_fee_per_unit: number | string | null;
            estimated_fba_fee_per_unit: number | string | null;
            estimated_digital_service_fee_per_unit: number | string | null;
            estimated_amazon_fee_per_unit: number | string | null;
          }>
        >(sql, ...productIds);
        for (const p of products) {
          const referral = p.estimated_referral_fee_per_unit != null ? parseFloat(String(p.estimated_referral_fee_per_unit)) : null;
          const fba = p.estimated_fba_fee_per_unit != null ? parseFloat(String(p.estimated_fba_fee_per_unit)) : null;
          const digitalService = p.estimated_digital_service_fee_per_unit != null ? parseFloat(String(p.estimated_digital_service_fee_per_unit)) : null;
          const amazonFee = p.estimated_amazon_fee_per_unit != null ? parseFloat(String(p.estimated_amazon_fee_per_unit)) : null;
          productFeesById.set(p.id, {
            referralPerUnit: referral != null && Number.isFinite(referral) ? referral : null,
            fbaPerUnit: fba != null && Number.isFinite(fba) ? fba : null,
            digitalServicePerUnit: digitalService != null && Number.isFinite(digitalService) ? digitalService : null,
            amazonFeePerUnit: amazonFee != null && Number.isFinite(amazonFee) ? amazonFee : null,
          });
        }
      } catch {
        // Raw query or product columns may fail; table still shows with totals and 50/50 fallback
      }
    }
    if (orderDbIds.length > 0) {
      try {
        const rows = await this.prisma.order.findMany({
          where: { id: { in: orderDbIds } },
          select: { id: true, itemPrice: true, quantity: true },
        });
        for (const row of rows) {
          orderPriceByDbId.set(String(row.id), {
            itemPrice: safeNum(row.itemPrice),
            quantity: safeNum(row.quantity),
          });
        }
      } catch {
        // Non-fatal: keep existing revenueTotal path.
      }
    }
    for (const it of items) {
      const sku = String((it as any).sku ?? '').trim();
      if (!sku || skuUnitPriceFallback.has(sku)) continue;
      const rev = safeNum((it as any).revenueTotal);
      const qty = safeNum((it as any).quantity);
      if (rev > 0 && qty > 0) {
        skuUnitPriceFallback.set(sku, rev / qty);
      }
    }

    const toNum = (v: unknown): number | null => {
      if (v == null) return null;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
      }
      const o = v as { toNumber?: () => number; toString?: () => string; value?: unknown; _value?: unknown };
      if (o?.toNumber && typeof o.toNumber === 'function') {
        const n = o.toNumber();
        return Number.isFinite(n) ? n : null;
      }
      if (o?.toString && typeof o.toString === 'function') {
        const n = parseFloat(o.toString());
        return Number.isFinite(n) ? n : null;
      }
      if (o?.value != null) return toNum(o.value);
      if (o?._value != null) return toNum(o._value);
      try {
        const parsed = JSON.parse(JSON.stringify(v));
        if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
        if (typeof parsed === 'string') return toNum(parsed);
      } catch {
        // ignore
      }
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    try {
      const mappedRows = items.map((it) => {
      const productRaw = (it as any).product ?? null;
      const product = productRaw as { title?: string | null; imageUrl?: string | null; estimatedReferralFeePerUnit?: unknown; estimatedFbaFeePerUnit?: unknown; estimatedDigitalServiceFeePerUnit?: unknown; estimatedAmazonFeePerUnit?: unknown } | null;
      const inv = inventoryByProductId.get(it.productId) ?? null;
      const fees = productFeesById.get(it.productId) ?? null;
      const qty = safeNum(it.quantity) || 1;
      const skuKey = String((it as any).sku ?? '').trim();
      const rawRevenueTotal = safeNum(it.revenueTotal);
      const orderDbId = (it as any).orderDbId != null ? String((it as any).orderDbId) : '';
      const orderFallback = orderDbId ? orderPriceByDbId.get(orderDbId) : null;
      const revenueTotal =
        rawRevenueTotal > 0
          ? rawRevenueTotal
          : orderFallback != null &&
              orderFallback.itemPrice > 0 &&
              orderFallback.quantity > 0
            ? orderFallback.itemPrice * qty
            : skuKey && skuUnitPriceFallback.has(skuKey)
              ? (skuUnitPriceFallback.get(skuKey) as number) * qty
            : rawRevenueTotal;
      const taxChargedTotal = safeNum(it.taxChargedTotal);
      const settledFees = safeNum(it.amazonFeesTotal);
      // Use order item stored fees when present; else product's saved estimate (so we always pick up estimates from DB).
      const estPerUnit = fees?.amazonFeePerUnit ?? toNum(product?.estimatedAmazonFeePerUnit) ?? null;
      const estReferral = fees?.referralPerUnit ?? toNum(product?.estimatedReferralFeePerUnit) ?? null;
      const estFba = fees?.fbaPerUnit ?? toNum(product?.estimatedFbaFeePerUnit) ?? null;
      const estDigital = fees?.digitalServicePerUnit ?? toNum(product?.estimatedDigitalServiceFeePerUnit) ?? null;
      // Use settled total when we have it (finances); otherwise use estimated total (estimated per unit × qty); else conservative fallback so ROI isn't overstated.
      const feesForDisplay =
        settledFees !== 0
          ? settledFees
          : estPerUnit != null && Number.isFinite(estPerUnit)
            ? -Math.abs(estPerUnit * qty)
            : revenueTotal > 0
              ? -Math.abs(revenueTotal * DEFAULT_AMAZON_FEE_RATE_WHEN_UNKNOWN)
              : 0;
      const feesSource = (it as any).feesSource ?? null;
      let referralFeeTotal: number | null = null;
      let fbaFeeTotal: number | null = null;
      let digitalServiceFeeTotal: number | null = null;
      // Use settled breakdown from Finances API when available (orders that have settled).
      const settledReferral = toNum((it as any).settledReferralFeeTotal);
      const settledFba = toNum((it as any).settledFbaFeeTotal);
      const settledDigital = toNum((it as any).settledDigitalServiceFeeTotal);
      const hasSettledBreakdown =
        feesSource === 'finances' &&
        (settledReferral != null || settledFba != null || settledDigital != null);
      if (hasSettledBreakdown) {
        referralFeeTotal = settledReferral;
        fbaFeeTotal = settledFba;
        digitalServiceFeeTotal = settledDigital;
      }
      // For finances orders, only use stored breakdown from DB — never recalculate.
      // For estimate orders: always use full referral and FBA from estimates; 2% digital is added on top, never taken from referral/FBA.
      const hasAllThree = estReferral != null && Number.isFinite(estReferral) && estFba != null && Number.isFinite(estFba) && estDigital != null && Number.isFinite(estDigital);
      const hasRefAndFba = estReferral != null && Number.isFinite(estReferral) && estFba != null && Number.isFinite(estFba);
      if (!hasSettledBreakdown && feesSource !== 'finances') {
        // Use full estimate values for referral and FBA (never reduce them by a proportion).
        if (estReferral != null && Number.isFinite(estReferral)) {
          referralFeeTotal = Math.round(-Math.abs(estReferral * qty) * 100) / 100;
        }
        if (estFba != null && Number.isFinite(estFba)) {
          fbaFeeTotal = Math.round(-Math.abs(estFba * qty) * 100) / 100;
        }
        if (estDigital != null && Number.isFinite(estDigital)) {
          digitalServiceFeeTotal = Math.round(-Math.abs(estDigital * qty) * 100) / 100;
        }
        // Only use 50/50 split when we have no estimated breakdown at all (no ref, no fba, no digital).
        if (Number.isFinite(feesForDisplay) && feesForDisplay !== 0 && referralFeeTotal == null && fbaFeeTotal == null && digitalServiceFeeTotal == null) {
          referralFeeTotal = Math.round((feesForDisplay / 2) * 100) / 100;
          fbaFeeTotal = Math.round((feesForDisplay - referralFeeTotal) * 100) / 100;
        }
        // UK fallback: 2% is added on top of (referral + FBA), not taken from them — does not change referral or FBA.
        if (digitalServiceFeeTotal == null && (referralFeeTotal != null || fbaFeeTotal != null)) {
          const sum = Math.abs(referralFeeTotal ?? 0) + Math.abs(fbaFeeTotal ?? 0);
          if (sum > 0) digitalServiceFeeTotal = Math.round(-sum * 0.02 * 100) / 100;
        }
      }
      // Total Amazon fee must include referral + FBA + digital; when we have a breakdown, use that sum.
      const totalFromBreakdown =
        (referralFeeTotal ?? 0) + (fbaFeeTotal ?? 0) + (digitalServiceFeeTotal ?? 0);
      const finalFeesForDisplay =
        (referralFeeTotal != null || fbaFeeTotal != null || digitalServiceFeeTotal != null) &&
        totalFromBreakdown !== 0
          ? Math.round(totalFromBreakdown * 100) / 100
          : feesForDisplay;
      const cogsTotal = it.cogsTotal != null ? safeNum(it.cogsTotal) : null;
      // Profit = revenue - tax - COGS + fees (fees are negative, so + fees subtracts the cost)
      const profit =
        cogsTotal != null
          ? revenueTotal - taxChargedTotal - cogsTotal + finalFeesForDisplay
          : null;
      const salePrice = qty > 0 ? revenueTotal / qty : revenueTotal;
      const roiPct =
        profit != null && cogsTotal != null && cogsTotal > 0
          ? (profit / cogsTotal) * 100
          : null;
      const orderDate = it.orderDate instanceof Date ? it.orderDate.toISOString() : String(it.orderDate ?? '');
      return {
        id: String(it.id),
        __productId: String(it.productId ?? ''),
        orderId: String(it.orderId),
        orderDate,
        sku: String(it.sku),
        asin: it.asin != null ? String(it.asin) : null,
        title: product?.title != null ? String(product.title) : null,
        imageUrl: product?.imageUrl != null ? String(product.imageUrl) : null,
        quantity: Number(it.quantity) || 0,
        salePrice: Math.round(salePrice * 100) / 100,
        profit: profit != null ? Math.round(profit * 100) / 100 : null,
        roiPct: roiPct != null ? Math.round(roiPct * 10) / 10 : null,
        amazonFeesTotal: Number.isFinite(finalFeesForDisplay) ? Math.round(finalFeesForDisplay * 100) / 100 : 0,
        referralFeeTotal: referralFeeTotal ?? null,
        fbaFeeTotal: fbaFeeTotal ?? null,
        digitalServiceFeeTotal: digitalServiceFeeTotal ?? null,
        feesSource: feesSource != null ? String(feesSource) : null,
        availableStock: inv?.availableQty ?? null,
        totalStock: inv?.totalQty ?? null,
      };
    });
      // Show a realistic stock progression across recent rows for the same product:
      // newest row uses current available stock, older rows step up by sold qty.
      const soldSoFarByProduct = new Map<string, number>();
      for (const row of mappedRows) {
        const pid = row.__productId;
        if (!pid) continue;
        const soldBefore = soldSoFarByProduct.get(pid) ?? 0;
        if (row.availableStock != null && Number.isFinite(row.availableStock)) {
          row.availableStock = Math.max(0, row.availableStock + soldBefore);
        }
        soldSoFarByProduct.set(
          pid,
          soldBefore + (Number.isFinite(row.quantity) ? Math.max(0, row.quantity) : 0),
        );
      }
      return mappedRows.map(({ __productId, ...row }) => row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[listOrders] mapping order items failed (orgId=${orgId}): ${msg}`);
      return [];
    }
  }

  async listInventory(orgId: string, marketplaceId?: string) {
    const userIds = await this.getOrgMemberUserIds(orgId);
    type InventoryProductRow = {
      id: string;
      sku: string;
      asin: string | null;
      title: string | null;
      imageUrl: string | null;
      updatedAt: Date;
      estimatedAmazonFeePerUnit: number | null;
      estimatedAmazonFeeUpdatedAt: Date | null;
      inventory: {
        availableQty: number;
        reservedQty: number;
        inboundQty: number;
        issueQty: number;
        totalQty: number;
        rawJson: unknown;
        updatedAt: Date;
      } | null;
      inventoryByMarketplace: Array<{
        marketplaceId: string;
        fulfillableQty: number;
        inboundQty: number;
        reservedQty: number;
        researchingQty: number;
        unfulfillableQty: number;
        currentQty: number;
        updatedAt: Date;
      }>;
    };

    const rows = (await this.prisma.product.findMany({
      where: { userId: { in: userIds } },
      orderBy: [{ updatedAt: 'desc' }],
      select: {
        id: true,
        sku: true,
        asin: true,
        title: true,
        imageUrl: true,
        productType: true,
        displayGroup: true,
        updatedAt: true,
        estimatedAmazonFeePerUnit: true,
        estimatedReferralFeePerUnit: true,
        estimatedFbaFeePerUnit: true,
        estimatedAmazonFeeUpdatedAt: true,
        currentListedPrice: true,
        costOfGoods: true,
        feeEstimateRawJson: true,
        inventory: {
          select: {
            availableQty: true,
            reservedQty: true,
            inboundQty: true,
            issueQty: true,
            totalQty: true,
            rawJson: true,
            updatedAt: true,
          },
        },
        inventoryByMarketplace: {
          select: {
            marketplaceId: true,
            fulfillableQty: true,
            inboundQty: true,
            reservedQty: true,
            researchingQty: true,
            unfulfillableQty: true,
            currentQty: true,
            fcProcessingQty: true,
            customerOrdersQty: true,
            transshipmentQty: true,
            inboundWorkingQty: true,
            inboundShippedQty: true,
            inboundReceivingQty: true,
            warehouseDamagedQty: true,
            expiredQty: true,
            updatedAt: true,
          },
          orderBy: [{ marketplaceId: 'asc' }],
        },
      },
    } as any)) as unknown as InventoryProductRow[];

    // Products are currently user-scoped (multiple users can exist in one org),
    // but Inventory is an org-level screen. If multiple users have the same SKU,
    // we want one canonical row per SKU; otherwise the UI shows duplicates and
    // only one of them will have inventory filled in (sync is SKU-keyed).
    // Prefer the row that has both catalog (productType/displayGroup) and fee data when present, so we don't hide catalog or fees.
    const pickCanonicalForSku = (a: InventoryProductRow, b: InventoryProductRow) => {
      const aInv = a.inventory?.updatedAt ?? null;
      const bInv = b.inventory?.updatedAt ?? null;

      // Prefer a row that has inventory data at all.
      if (aInv && !bInv) return a;
      if (!aInv && bInv) return b;

      // If both have inventory timestamps, prefer the newest inventory snapshot.
      if (aInv && bInv) {
        if (aInv.getTime() !== bInv.getTime()) return aInv > bInv ? a : b;
      }

      // Prefer the row that has catalog (productType/displayGroup) and/or fee data so we show them when we have them.
      const hasCatalog = (p: InventoryProductRow) =>
        !!((p as any).productType?.trim?.() || (p as any).displayGroup?.trim?.());
      const hasFees = (p: InventoryProductRow) => !!(p as any).estimatedAmazonFeeUpdatedAt;
      const catalogFeeScore = (p: InventoryProductRow) => (hasCatalog(p) ? 2 : 0) + (hasFees(p) ? 1 : 0);
      const ca = catalogFeeScore(a);
      const cb = catalogFeeScore(b);
      if (ca !== cb) return ca > cb ? a : b;

      // Prefer the newest product row as a tie-breaker.
      if (a.updatedAt.getTime() !== b.updatedAt.getTime()) {
        return a.updatedAt > b.updatedAt ? a : b;
      }

      // Prefer more enriched metadata (title/asin/image).
      const score = (p: InventoryProductRow) =>
        (p.title ? 1 : 0) + (p.asin ? 1 : 0) + (p.imageUrl ? 1 : 0);
      const sa = score(a);
      const sb = score(b);
      if (sa !== sb) return sa > sb ? a : b;

      // Fall back to stable choice.
      return a;
    };

    const bySku = new Map<string, InventoryProductRow>();
    for (const p of rows) {
      const existing = bySku.get(p.sku);
      bySku.set(p.sku, existing ? pickCanonicalForSku(existing, p) : p);
    }
    const uniqueRows = Array.from(bySku.values()).sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );

    return uniqueRows.map((p) => {
      const selectedMarketplace = marketplaceId
        ? ((p as any).inventoryByMarketplace ?? []).find(
            (m: any) => m.marketplaceId === marketplaceId,
          )
        : null;
      const selectedAvailable =
        selectedMarketplace != null
          ? Number(selectedMarketplace.fulfillableQty ?? 0)
          : null;
      const selectedReserved =
        selectedMarketplace != null
          ? Number(selectedMarketplace.reservedQty ?? 0)
          : null;
      const selectedInbound =
        selectedMarketplace != null
          ? Number(selectedMarketplace.inboundQty ?? 0)
          : null;
      const selectedIssue =
        selectedMarketplace != null
          ? Number(
              (selectedMarketplace.unfulfillableQty ?? 0) +
                (selectedMarketplace.researchingQty ?? 0),
            )
          : null;
      const selectedTotal =
        selectedMarketplace != null
          ? Number(selectedMarketplace.currentQty ?? 0)
          : null;
      return {
      productId: p.id,
      sku: p.sku,
      asin: p.asin,
      title: p.title,
      imageUrl: p.imageUrl,
      productType: (p as any).productType ?? null,
      displayGroup: (p as any).displayGroup ?? null,
      productUpdatedAt: p.updatedAt,
      estimatedAmazonFeePerUnit: p.estimatedAmazonFeePerUnit != null ? Number(p.estimatedAmazonFeePerUnit) : null,
      estimatedReferralFeePerUnit: (p as any).estimatedReferralFeePerUnit != null ? Number((p as any).estimatedReferralFeePerUnit) : null,
      estimatedFbaFeePerUnit: (p as any).estimatedFbaFeePerUnit != null ? Number((p as any).estimatedFbaFeePerUnit) : null,
      estimatedAmazonFeeUpdatedAt: p.estimatedAmazonFeeUpdatedAt ?? null,
      currentListedPrice: (p as any).currentListedPrice != null ? Number((p as any).currentListedPrice) : null,
      costOfGoods: (p as any).costOfGoods != null ? Number((p as any).costOfGoods) : null,
      feeEstimateRawJson: (p as any).feeEstimateRawJson ?? null,
      availableQty: marketplaceId ? selectedAvailable : p.inventory?.availableQty ?? null,
      reservedQty: marketplaceId ? selectedReserved : p.inventory?.reservedQty ?? null,
      inboundQty: marketplaceId ? selectedInbound : p.inventory?.inboundQty ?? null,
      issueQty: marketplaceId ? selectedIssue : p.inventory?.issueQty ?? null,
      totalQty: marketplaceId ? selectedTotal : p.inventory?.totalQty ?? null,
      inventoryUpdatedAt: p.inventory?.updatedAt ?? null,
      rawJson: p.inventory?.rawJson ?? null,
      byMarketplace: (p as any).inventoryByMarketplace?.map((m: any) => ({
        marketplaceId: m.marketplaceId,
        fulfillableQty: Number(m.fulfillableQty ?? 0),
        inboundQty: Number(m.inboundQty ?? 0),
        reservedQty: Number(m.reservedQty ?? 0),
        researchingQty: Number(m.researchingQty ?? 0),
        unfulfillableQty: Number(m.unfulfillableQty ?? 0),
        currentQty: Number(m.currentQty ?? 0),
        fcProcessingQty: Number(m.fcProcessingQty ?? 0),
        customerOrdersQty: Number(m.customerOrdersQty ?? 0),
        transshipmentQty: Number(m.transshipmentQty ?? 0),
        inboundWorkingQty: Number(m.inboundWorkingQty ?? 0),
        inboundShippedQty: Number(m.inboundShippedQty ?? 0),
        inboundReceivingQty: Number(m.inboundReceivingQty ?? 0),
        warehouseDamagedQty: Number(m.warehouseDamagedQty ?? 0),
        expiredQty: Number(m.expiredQty ?? 0),
        updatedAt: m.updatedAt ?? null,
      })) ?? [],
    };
    });
  }

  /**
   * Set manual check-in date for a shipment (when historic check-in was not recorded).
   * Recomputes checkInDurationDays from createdDate to the new checkedInDate.
   */
  async setShipmentManualCheckedInDate(
    orgId: string,
    shipmentId: string,
    checkedInDateIso: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const userIds = await this.getOrgMemberUserIds(orgId);
    const shipment = await this.prisma.shipment.findFirst({
      where: { shipmentId, userId: { in: userIds } },
      select: { id: true, userId: true, createdDate: true },
    });
    if (!shipment) {
      return { ok: false, error: 'Shipment not found' };
    }
    const checkedInDate = new Date(checkedInDateIso);
    if (Number.isNaN(checkedInDate.getTime())) {
      return { ok: false, error: 'Invalid date' };
    }
    const checkInDurationDays =
      shipment.createdDate != null
        ? Math.max(0, Math.floor((checkedInDate.getTime() - shipment.createdDate.getTime()) / (24 * 60 * 60 * 1000)))
        : null;
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        checkedInDate,
        checkedInDateIsClosedDate: false,
        checkInDurationDays: checkInDurationDays ?? undefined,
      },
    });
    return { ok: true };
  }

  /**
   * List FBA inbound shipments for the org (from DB).
   * Masks createdDate/checkedInDate when they fall on the same calendar day as createdAt/updatedAt,
   * since those were likely stored as "today" at sync time rather than real API dates.
   */
  async listShipments(orgId: string, marketplaceId?: string) {
    const userIds = await this.getOrgMemberUserIds(orgId);
    const rows = await this.prisma.shipment.findMany({
      where: { userId: { in: userIds } },
      orderBy: [{ createdDate: 'desc' }, { updatedAt: 'desc' }],
    });
    const sameCalendarDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    return rows.map((s) => {
      const createdDateReal =
        s.createdDate != null && !sameCalendarDay(s.createdDate, s.createdAt)
          ? s.createdDate
          : null;
      const checkedInDateReal =
        s.checkedInDate != null && !sameCalendarDay(s.checkedInDate, s.updatedAt)
          ? s.checkedInDate
          : null;
      const checkInDurationDays =
        checkedInDateReal != null
          ? s.checkInDurationDays ??
            (createdDateReal && checkedInDateReal
              ? Math.max(0, Math.floor((checkedInDateReal.getTime() - createdDateReal.getTime()) / (24 * 60 * 60 * 1000)))
              : null)
          : null;
      return {
        id: s.id,
        shipmentId: s.shipmentId,
        shipmentName: s.shipmentName ?? null,
        shipmentStatus: s.shipmentStatus ?? null,
        destinationFulfillmentCenterId: s.destinationFulfillmentCenterId ?? null,
        createdDate: createdDateReal?.toISOString() ?? null,
        lastUpdatedDate: s.lastUpdatedDate?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
        unitsSent: s.unitsSent,
        unitsReceived: s.unitsReceived,
        unitsDamaged: s.unitsDamaged,
        unitsDisposed: s.unitsDisposed,
        unitsMissing: s.unitsMissing,
        pickupDate: s.pickupDate?.toISOString() ?? null,
        transportStatus: s.transportStatus ?? null,
        deliveryDate: s.deliveryDate?.toISOString() ?? null,
        damageClosedDate: s.damageClosedDate?.toISOString() ?? null,
        checkInDurationDays,
        checkedInDate: checkedInDateReal?.toISOString() ?? null,
        checkedInDateIsClosedDate: checkedInDateReal != null ? s.checkedInDateIsClosedDate ?? null : null,
      };
    });
  }

  /**
   * Per-shipment summary of missing units from FBA shipments (for topbar notification).
   * Returns one entry per shipment that has unitsMissing > 0, ordered by sent date (most recent first).
   */
  async getShipmentsMissingSummary(orgId: string): Promise<{
    shipments: Array<{
      shipmentId: string;
      missingUnits: number;
      sentDate: string | null;
      shipmentName: string | null;
    }>;
  }> {
    const userIds = await this.getOrgMemberUserIds(orgId);
    const rows = await this.prisma.shipment.findMany({
      where: {
        userId: { in: userIds },
        unitsMissing: { gt: 0 },
      },
      select: {
        shipmentId: true,
        shipmentName: true,
        unitsMissing: true,
        pickupDate: true,
        createdDate: true,
      },
      orderBy: [{ createdDate: 'desc' }, { pickupDate: 'desc' }],
    });
    const shipments = rows.map((r) => {
      const sentDate =
        (r.pickupDate ?? r.createdDate)?.toISOString().slice(0, 10) ?? null;
      return {
        shipmentId: r.shipmentId,
        missingUnits: r.unitsMissing ?? 0,
        sentDate,
        shipmentName: r.shipmentName ?? null,
      };
    });
    return { shipments };
  }

  /**
   * Sync FBA inbound shipments from SP-API and upsert into shipments table.
   * Returns raw API payloads for debugging (getShipments response per page).
   */
  async syncShipments(
    orgId: string,
    preferredUserId?: string,
    options?: {
      onProgress?: (progress: { processed: number; total: number }) => void | Promise<void>;
      /** When set, only fetch shipments updated in the last N days (e.g. 30 for initial sync). Default 60. */
      days?: number;
      /** When set (e.g. 15), only fetch and process this many shipments. Used for limited sync. */
      maxShipments?: number;
    },
  ): Promise<{
    synced: number;
    errors: string[];
    rawResponses?: unknown[];
  }> {
    const credentials = await this.getAmazonCredentialsForOrg(orgId, preferredUserId);
    const userIds = await this.getOrgMemberUserIds(orgId);
    const account =
      preferredUserId && userIds.includes(preferredUserId)
        ? await this.prisma.sellerAccount.findUnique({
            where: {
              userId_marketplace: { userId: preferredUserId, marketplace: 'amazon' },
            },
          })
        : await this.prisma.sellerAccount.findFirst({
            where: { userId: { in: userIds }, marketplace: 'amazon' },
            orderBy: { updatedAt: 'desc' },
          });
    const ownerUserId = account?.userId ?? userIds[0];
    if (!ownerUserId) {
      return { synced: 0, errors: ['No Amazon account found for org'] };
    }

    const errors: string[] = [];
    const rawResponses: unknown[] = [];
    let synced = 0;
    const throttleMs = Math.max(200, Number(this.configService.get<string>('SPAPI_THROTTLE_MS')) || 800);
    let lastReportedProcessed = -1;
    let lastReportedTotal = -1;
    const reportProgress = async (processed: number, total: number) => {
      if (!options?.onProgress) return;
      const safeTotal = Math.max(0, total);
      const safeProcessed = Math.max(0, Math.min(processed, safeTotal));
      if (
        safeProcessed === lastReportedProcessed &&
        safeTotal === lastReportedTotal
      ) {
        return;
      }
      lastReportedProcessed = safeProcessed;
      lastReportedTotal = safeTotal;
      await options.onProgress({ processed: safeProcessed, total: safeTotal });
    };

    const parseDate = (v: unknown): Date | null => {
      if (v == null) return null;
      if (typeof v === 'string') {
        const trimmed = v.trim();
        if (!trimmed) return null;
        const d = new Date(trimmed);
        return Number.isNaN(d.getTime()) ? null : d;
      }
      if (typeof v === 'number' && !Number.isNaN(v)) {
        const ms = v > 1e12 ? v : v * 1000;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? null : d;
      }
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
      if (typeof v === 'object' && v !== null) {
        const o = v as Record<string, unknown>;
        const s = o.value ?? o.date ?? o.iso ?? o.Value ?? o.Date ?? o.ISO ?? o.__date__;
        if (s != null) return parseDate(s);
      }
      return null;
    };
    const toInt = (v: unknown): number => {
      if (v == null) return 0;
      if (typeof v === 'number' && Number.isInteger(v)) return v;
      const n = parseInt(String(v), 10);
      return Number.isNaN(n) ? 0 : n;
    };

    /** Parse date from ShipmentName when API does not return CreatedDate. e.g. "FBA STA (11/03/2025 19:20)-BHX4" -> DD/MM/YYYY HH:MM */
    const parseDateFromShipmentName = (name: unknown): Date | null => {
      const s = typeof name === 'string' ? name : null;
      if (!s) return null;
      const match = s.match(/\((\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?\)/);
      if (!match) return null;
      const [, day, month, year, hour = '0', min = '0'] = match;
      const d = new Date(
        parseInt(year, 10),
        parseInt(month, 10) - 1,
        parseInt(day, 10),
        parseInt(hour, 10),
        parseInt(min, 10),
        0,
        0,
      );
      return Number.isNaN(d.getTime()) ? null : d;
    };

    // Phase 1 requires the first getShipments request to specify every status; otherwise the API won't return all shipment IDs.
    // Single source of truth for all FBA inbound statuses (comma-separated in request).
    const ALL_SHIPMENT_STATUSES = [
      'WORKING',
      'READY_TO_SHIP',
      'SHIPPED',
      'IN_TRANSIT',
      'DELIVERED',
      'CHECKED_IN',
      'RECEIVING',
      'CLOSED',
      'CANCELLED',
      'DELETED',
      'ERROR',
    ] as const;
    const marketplaceId =
      credentials.region === 'eu' ? 'A1F83G8C2ARO7P'
        : credentials.region === 'fe' ? 'A1VC38T7YXB528'
          : 'ATVPDKIKX0DER';

    const parseShipmentList = (p: any): any[] => {
      let list: unknown = p?.ShipmentData ?? p?.shipmentData ?? p?.Shipments ?? p?.shipments;
      if (list != null && !Array.isArray(list) && typeof list === 'object') {
        const obj = list as Record<string, unknown>;
        list =
          obj.member ?? obj.Member ?? obj.Shipment ?? obj.shipment
          ?? obj.Shipments ?? obj.shipments ?? obj.ShipmentData ?? obj.shipmentData ?? [];
      }
      return Array.isArray(list) ? list : [];
    };

    // ——— Phase 1: Fetch shipments (last N days). First request uses DATE_RANGE; pagination uses NEXT_TOKEN. ———
    const SHIPMENT_SYNC_DAYS = options?.days != null && options.days > 0 ? Math.min(90, Math.floor(options.days)) : 60;
    const now = new Date();
    const shipmentWindowStart = new Date(now.getTime() - SHIPMENT_SYNC_DAYS * 24 * 60 * 60 * 1000);
    const lastUpdatedAfterIso = shipmentWindowStart.toISOString().split('.')[0] + 'Z';
    const lastUpdatedBeforeIso = now.toISOString().split('.')[0] + 'Z';

    const listRows: any[] = [];
    let nextToken: string | undefined;
    await reportProgress(0, 100);
    this.logger.log(
      `[syncShipments] Phase 1: getShipments last ${SHIPMENT_SYNC_DAYS} days, all ${ALL_SHIPMENT_STATUSES.length} statuses`,
    );
    do {
      try {
        if (throttleMs > 0) await new Promise((r) => setTimeout(r, throttleMs));
        const queryType: 'NEXT_TOKEN' | 'DATE_RANGE' | 'SHIPMENT' = nextToken ? 'NEXT_TOKEN' : 'DATE_RANGE';
        const res = (await this.spApiClient.getFbaInboundShipments(credentials, {
          marketplaceId,
          queryType,
          ...(nextToken
            ? { nextToken }
            : {
                lastUpdatedAfter: lastUpdatedAfterIso,
                lastUpdatedBefore: lastUpdatedBeforeIso,
                shipmentStatusList: [...ALL_SHIPMENT_STATUSES],
              }),
        })) as any;
        const payload = res?.payload ?? res;
        rawResponses.push(payload);
        // No DTO: payload and ShipmentData items are raw API JSON; we never map or strip fields.
        this.logger.log(
          `[syncShipments] getShipments page: payload keys=${Object.keys(payload ?? {}).join(', ')} ShipmentData length=${parseShipmentList(payload).length}`,
        );
        const items = parseShipmentList(payload);
        for (const row of items) {
          listRows.push(row);
          if (options?.maxShipments != null && listRows.length >= options.maxShipments) break;
        }
        if (options?.maxShipments != null && listRows.length >= options.maxShipments) {
          nextToken = undefined;
        } else {
          nextToken = payload?.NextToken ?? payload?.nextToken ?? undefined;
        }
      } catch (e) {
        const msg = (e as Error).message ?? 'Failed to fetch shipments';
        errors.push(msg);
        this.logger.warn(`[syncShipments] Phase 1 request failed: ${msg}`);
        break;
      }
    } while (nextToken);

    const rowsToProcess =
      options?.maxShipments != null
        ? listRows.slice(0, options.maxShipments)
        : listRows;
    this.logger.log(`[syncShipments] Phase 1 done: ${listRows.length} shipment(s) from API, processing ${rowsToProcess.length}. Saving to DB.`);
    if (rowsToProcess.length === 0) {
      await reportProgress(100, 100);
    }

    // Statuses that mean "checked in at FC" – we record lastUpdatedDate as checkedInDate when we see these
    const CHECKED_IN_STATUSES = ['CLOSED', 'RECEIVING', 'Closed', 'Receiving'];

    // Raw API data only: no DTO or mapper – we use the same objects from getFbaInboundShipments (JSON.parse(response.body)).
    // Log full first shipment object so no field is hidden by truncation (e.g. LastUpdatedDate, ClosedDate).
    if (rowsToProcess.length > 0) {
      const r0 = rowsToProcess[0] as Record<string, unknown>;
      this.logger.log(`[syncShipments] First row keys (raw API, no DTO): ${Object.keys(r0).join(', ')}`);
      const fullFirstRow = JSON.stringify(r0);
      if (fullFirstRow.length <= 4000) {
        this.logger.log(`[syncShipments] First row full: ${fullFirstRow}`);
      } else {
        this.logger.log(`[syncShipments] First row full (${fullFirstRow.length} chars): ${fullFirstRow.slice(0, 4000)}...`);
        this.logger.log(`[syncShipments] First row tail: ...${fullFirstRow.slice(-1500)}`);
      }
    }
    for (const row of rowsToProcess) {
      const shipmentId = row.ShipmentId ?? row.shipmentId ?? row.ShipmentIdentifier ?? row.shipmentIdentifier;
      if (!shipmentId) continue;
      // Created: API may return CreatedDate; else parse from ShipmentName e.g. "FBA STA (11/03/2025 19:20)-BHX4"
      const createdDate =
        parseDate(
          row.CreatedDate ?? row.createdDate ?? row.Created ?? row.created ?? row.Created_date ?? row.created_date,
        ) ?? parseDateFromShipmentName(row.ShipmentName ?? row.shipmentName);
      // Last updated / closed: try every plausible key (API may return LastUpdatedDate or ClosedDate even if not in v0 schema)
      const lastUpdatedDate =
        parseDate(
          row.LastUpdatedDate ??
            row.lastUpdatedDate ??
            row.LastUpdatedAt ??
            row.lastUpdatedAt ??
            row.ClosedDate ??
            row.closedDate ??
            row.ClosedAt ??
            row.closedAt ??
            row.LastUpdated ??
            row.lastUpdated ??
            row.LastUpdateDate ??
            row.lastUpdateDate ??
            row.UpdateDate ??
            row.updateDate ??
            row.LastModifiedDate ??
            row.lastModifiedDate ??
            row.Last_updated_date ??
            row.last_updated_date,
        );
      if (rowsToProcess.indexOf(row) === 0) {
        const dateLikeKeys = Object.keys(row).filter(
          (k) =>
            /date|updated|closed|modified|at$/i.test(k) &&
            typeof (row as Record<string, unknown>)[k] !== 'object',
        );
        this.logger.log(
          `[syncShipments] First row date-like keys and values: ${JSON.stringify(
            Object.fromEntries(dateLikeKeys.map((k) => [k, (row as Record<string, unknown>)[k]])),
          )}`,
        );
        this.logger.log(
          `[syncShipments] First shipment dates parsed: createdDate=${createdDate?.toISOString() ?? 'null'} lastUpdatedDate=${lastUpdatedDate?.toISOString() ?? 'null'}`,
        );
      }
      const status = (row.ShipmentStatus ?? row.shipmentStatus ?? row.Status ?? row.status ?? '') as string;
      const statusUpper = status.toUpperCase();

      let checkedInDate: Date | null = null;
      let checkedInDateIsClosedDate: boolean | undefined = undefined;

      const existing = await this.prisma.shipment.findUnique({
        where: { userId_shipmentId: { userId: ownerUserId, shipmentId: String(shipmentId) } },
        select: { shipmentStatus: true, checkedInDate: true },
      });
      // Automatic check-in: only set from API when we don't already have a date (1st preference = automatic timestamp when status first changed; never overwrite existing automatic or manual).
      if (lastUpdatedDate && (statusUpper === 'CLOSED' || statusUpper === 'RECEIVING') && existing?.checkedInDate == null) {
        const wasAlreadyCheckedIn =
          existing?.shipmentStatus != null &&
          CHECKED_IN_STATUSES.some((s) => existing.shipmentStatus!.toUpperCase() === s.toUpperCase());
        checkedInDate = lastUpdatedDate;
        checkedInDateIsClosedDate = !existing || wasAlreadyCheckedIn;
      }
      // When API does not return LastUpdatedDate, we do not set checkedInDate; user can enter manually in the app.

      const checkInDurationDays =
        createdDate && checkedInDate
          ? Math.max(0, Math.floor((checkedInDate.getTime() - createdDate.getTime()) / (24 * 60 * 60 * 1000)))
          : null;

      const updatePayload = {
        shipmentName: (row.ShipmentName ?? row.shipmentName ?? null) ?? undefined,
        shipmentStatus: (row.ShipmentStatus ?? row.shipmentStatus ?? row.Status ?? row.status ?? null) ?? undefined,
        destinationFulfillmentCenterId: (row.DestinationFulfillmentCenterId ?? row.destinationFulfillmentCenterId ?? row.FulfillmentCenterId ?? row.fulfillmentCenterId ?? null) ?? undefined,
        createdDate: createdDate ?? undefined,
        lastUpdatedDate: lastUpdatedDate ?? undefined,
        ...(checkedInDate != null && { checkedInDate, checkedInDateIsClosedDate }),
        ...(checkInDurationDays != null && { checkInDurationDays }),
      };

      const createPayload = {
        userId: ownerUserId,
        shipmentId: String(shipmentId),
        shipmentName: row.ShipmentName ?? row.shipmentName ?? null,
        shipmentStatus: row.ShipmentStatus ?? row.shipmentStatus ?? row.Status ?? row.status ?? null,
        destinationFulfillmentCenterId: row.DestinationFulfillmentCenterId ?? row.destinationFulfillmentCenterId ?? row.FulfillmentCenterId ?? row.fulfillmentCenterId ?? null,
        createdDate: createdDate ?? undefined,
        lastUpdatedDate: lastUpdatedDate ?? undefined,
        ...(checkedInDate != null && { checkedInDate, checkedInDateIsClosedDate }),
        ...(checkInDurationDays != null && { checkInDurationDays }),
      };

      try {
        await this.prisma.shipment.upsert({
          where: { userId_shipmentId: { userId: ownerUserId, shipmentId: String(shipmentId) } },
          update: updatePayload,
          create: createPayload,
        });
        synced += 1;
        if (rowsToProcess.length > 0) {
          const stageProgress = Math.min(
            40,
            Math.floor((synced / rowsToProcess.length) * 40),
          );
          await reportProgress(stageProgress, 100);
        }
        this.logger.log(`[syncShipments] saved list data for ${shipmentId} (${synced}/${rowsToProcess.length})`);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        errors.push(`Shipment ${shipmentId} save: ${msg}`);
      }
    }

    // ——— Phase 2: For each shipment ID, fetch items + transport and update DB (batches of 4 in parallel) ———
    this.logger.log(`[syncShipments] Phase 2: enriching ${rowsToProcess.length} shipment(s) with items and transport.`);
    const STATUSES_WITH_TRANSPORT = ['WORKING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED'];
    const PHASE2_BATCH = 4;

    const enrichOneShipment = async (row: any, index: number): Promise<void> => {
      const shipmentId = row.ShipmentId ?? row.shipmentId ?? row.ShipmentIdentifier ?? row.shipmentIdentifier;
      if (!shipmentId) return;

      let unitsSent = 0;
      let unitsReceived = 0;
      let unitsDamaged = 0;
      let unitsDisposed = 0;
      try {
        if (throttleMs > 0) await new Promise((r) => setTimeout(r, Math.floor(throttleMs / 2)));
        const itemsRes = (await this.spApiClient.getFbaInboundShipmentItemsByShipmentId(credentials, String(shipmentId))) as any;
        const itemPayload = itemsRes?.payload ?? itemsRes;
        const itemList = itemPayload?.ItemData ?? itemPayload?.itemData ?? itemPayload?.ShipmentItems ?? itemPayload?.shipmentItems ?? [];
        const itemArr = Array.isArray(itemList) ? itemList : [];
        for (const it of itemArr) {
          unitsSent += toInt(it.QuantityShipped ?? it.quantityShipped);
          unitsReceived += toInt(it.QuantityReceived ?? it.quantityReceived);
          unitsDamaged += toInt(it.QuantityDamaged ?? it.quantityDamaged);
          unitsDisposed += toInt(it.QuantityDisposed ?? it.quantityDisposed);
        }
      } catch (e) {
        const msg = (e as Error).message ?? '';
        errors.push(`Shipment ${shipmentId} items: ${msg}`);
      }

      let pickupDate: Date | null = null;
      let transportStatus: string | null = null;
      let deliveryDate: Date | null = null;
      const rowStatus = (row.ShipmentStatus ?? row.shipmentStatus ?? row.Status ?? row.status ?? '') as string;
      if (STATUSES_WITH_TRANSPORT.includes(rowStatus.toUpperCase())) {
        try {
          if (throttleMs > 0) await new Promise((r) => setTimeout(r, Math.floor(throttleMs / 2)));
          const transportRes = (await this.spApiClient.getFbaInboundTransportDetails(credentials, String(shipmentId))) as any;
          const transportPayload = transportRes?.payload ?? transportRes;
          const transport = transportPayload?.TransportContent ?? transportPayload?.transportContent ?? transportPayload ?? {};
          pickupDate = parseDate(transport.PickupDate ?? transport.pickupDate ?? transport.ShipmentPickupDate ?? transport.shipmentPickupDate) ?? null;
          transportStatus = (transport.TransportStatus ?? transport.transportStatus ?? null) ?? null;
          deliveryDate = parseDate(transport.DeliveryDate ?? transport.deliveryDate ?? transport.EstimatedDeliveryDate ?? transport.estimatedDeliveryDate) ?? null;
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          if (!msg.includes('403') && !msg.includes('Unauthorized')) {
            errors.push(`Shipment ${shipmentId} transportDetails: ${msg}`);
          }
        }
      }

      const damageClosedDate = parseDate(row.DamageClosedDate ?? row.damageClosedDate ?? row.UnitsDamageClosedDate ?? row.unitsDamageClosedDate);
      const unitsMissing = Math.max(0, unitsSent - unitsReceived);

      try {
        await this.prisma.shipment.update({
          where: { userId_shipmentId: { userId: ownerUserId, shipmentId: String(shipmentId) } },
          data: {
            unitsSent,
            unitsReceived,
            unitsDamaged,
            unitsDisposed,
            unitsMissing,
            pickupDate: pickupDate ?? undefined,
            transportStatus: transportStatus ?? undefined,
            deliveryDate: deliveryDate ?? undefined,
            damageClosedDate: damageClosedDate ?? undefined,
          },
        });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        errors.push(`Shipment ${shipmentId} update: ${msg}`);
      }
    };

    for (let start = 0; start < rowsToProcess.length; start += PHASE2_BATCH) {
      const chunk = rowsToProcess.slice(start, start + PHASE2_BATCH);
      await Promise.all(chunk.map((row, j) => enrichOneShipment(row, start + j)));
      if (rowsToProcess.length > 0) {
        const done = Math.min(start + chunk.length, rowsToProcess.length);
        const stageProgress = 40 + Math.floor((done / rowsToProcess.length) * 60);
        await reportProgress(Math.min(100, stageProgress), 100);
      }
    }

    await reportProgress(100, 100);
    this.logger.log(`[syncShipments] done: synced=${synced} errors=${errors.length}${errors.length ? ` [${errors.join('; ')}]` : ''}`);
    return { synced, errors, rawResponses };
  }

  /**
   * Fetch FBA inventory summaries from SP-API and upsert Inventory rows
   * for products we already know about in this org (matched by SKU).
   * @param opts.maxPages - If set (e.g. 1), only fetch this many pages per marketplace. Used for initial sync to get a minimal set quickly.
   */
  async syncFbaInventory(orgId: string, preferredUserId?: string, opts?: { maxPages?: number }) {
    const debug = ['1', 'true', 'yes'].includes(
      (this.configService.get<string>('SPAPI_DEBUG_LOGS') ?? '').toLowerCase(),
    );
    const throttleMs =
      Number(this.configService.get<string>('SPAPI_THROTTLE_MS')) || 1200;

    this.logger.log(
      `syncFbaInventory start (orgId=${orgId}${
        preferredUserId ? ', preferredUserId=set' : ''
      })`,
    );

    const credentials = await this.getAmazonCredentialsForOrg(
      orgId,
      preferredUserId,
    );

    const userIds = await this.getOrgMemberUserIds(orgId);
    
    // Get the userId from the account used for credentials
    const account = preferredUserId && userIds.includes(preferredUserId)
      ? await this.prisma.sellerAccount.findUnique({
          where: {
            userId_marketplace: {
              userId: preferredUserId,
              marketplace: 'amazon',
            },
          },
        })
      : await this.prisma.sellerAccount.findFirst({
          where: { userId: { in: userIds }, marketplace: 'amazon' },
          orderBy: { updatedAt: 'desc' },
        });
    
    const ownerUserId = account?.userId ?? preferredUserId ?? userIds[0];

    const products = await this.prisma.product.findMany({
      where: { userId: { in: userIds } },
      orderBy: [{ updatedAt: 'desc' }],
      select: {
  id: true,
  userId: true,
  sku: true,
  asin: true,
  updatedAt: true,
},
    });
    const bySku = new Map<
      string,
      { id: string; userId: string; updatedAt: Date }
    >();
    const byAsin = new Map<
  string,
  { id: string; userId: string; updatedAt: Date }
>();
    for (const p of products) {
      const existing = bySku.get(p.sku);
      // Prefer an existing Product owned by the seller connection we're syncing.
      if (!existing || (existing.userId !== ownerUserId && p.userId === ownerUserId)) {
        bySku.set(p.sku, { id: p.id, userId: p.userId, updatedAt: p.updatedAt });
      }
      if (p.asin) {
        byAsin.set(p.asin, { id: p.id, userId: p.userId, updatedAt: p.updatedAt });
      }
    }


    

    // FBA Inventory API only accepts marketplaces in the same region as the credentials.
    // getMarketplaceParticipations returns ALL seller marketplaces (e.g. EU + India + MEA);
    // we must filter to the credential region or we get 403 "marketplaces not valid for region".
    const regionMarketplaceIds: Record<string, string[]> = {
      eu: [
        'A1F83G8C2ARO7P', // UK
        'A1PA6795UKMFR9', // DE
        'A13V1IB3VIYZZH', // FR
        'APJ6JRA9NG5V4', // IT
        'A1RKKUPIHCS9HS', // ES
        'A28R8C7NBKEWEA', // IE
        'A1805IZSGTT6HS', // NL
        'AMEN7PMS3EDWL', // BE
        'A2NODRKZP88ZB9', // SE
        'A1C3SOZRARQ6R3', // PL
      ],
      na: ['ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2', 'A1AM78C64UM0Y8', 'A2Q3Y263D00KWC'], // US, CA, MX, BR
      fe: ['A19VAU5U5O7RUS', 'A39IBJ37TRP1C6', 'A1VC38T7YXB528'], // SG, AU, JP
    };
    const allowedInRegion = new Set(
      regionMarketplaceIds[credentials.region ?? 'eu'] ?? regionMarketplaceIds.eu,
    );

    const defaultRegion = credentials.region ?? 'eu';
    let marketplaceIds =
      defaultRegion === 'eu'
        ? [
            'A1F83G8C2ARO7P', // UK
            'A1PA6795UKMFR9', // DE
            'A13V1IB3VIYZZH', // FR
            'APJ6JRA9NG5V4', // IT
            'A1RKKUPIHCS9HS', // ES
          ]
        : defaultRegion === 'fe'
          ? ['A1VC38T7YXB528', 'A19VAU5U5O7RUS', 'A39IBJ37TRP1C6'] // JP, SG, AU
          : ['ATVPDKIKX0DER']; // US (na)

    // Optionally narrow to seller's participations, but only for marketplaces in this region.
    try {
      const res = (await this.spApiClient.getMarketplaceParticipations(
        credentials,
      )) as any;

      const payload = res?.payload ?? res?.Payload ?? res ?? {};
      const list: any[] = payload?.payload ?? payload?.Payload ?? payload ?? [];

      const ids = Array.isArray(list)
        ? list
            .map((p) => p?.marketplace?.id ?? p?.Marketplace?.Id ?? null)
            .filter((v) => typeof v === 'string' && v.length > 0 && allowedInRegion.has(v as string))
        : [];

      if (ids.length) {
        marketplaceIds = Array.from(new Set([...marketplaceIds, ...ids]));
      }

      if (debug) {
        this.logger.debug(
          `Marketplace participations resolved ${ids.length} ids in region (marketplacesToSync=${marketplaceIds.length})`,
        );
      }
    } catch {
      // ignore; fall back to region defaults
    }

     
  const now = new Date();

  const org = await this.prisma.organization.findUnique({
    where: { id: orgId },
    select: { lastFbaInventorySyncAt: true },
  });

  if (org?.lastFbaInventorySyncAt) {
    const secondsAgo = (now.getTime() - org.lastFbaInventorySyncAt.getTime()) / 1000;
    if (secondsAgo < 60) {  // 60 = 1 minute
      if (debug) {
        this.logger.debug(
          `[syncFbaInventory] Skipping - last successful sync was ${Math.round(secondsAgo / 60)} min ago`,
        );
      }
      return;  // exit function early, no API calls
    }
  }
  // END OF COOLDOWN BLOCK

    let marketplacesProcessed = 0;
    let inventorySummariesSeen = 0;
    let matchedSkus = 0;
    let skippedUnknownSku = 0;
    const marketplaceErrors: Array<{ marketplaceId: string; error: string }> =
      [];
    
      let marketplacesWithSuccessfulResponse = 0;
      let upsertedInventoryRows = 0;

    const inventoryBySku = new Map<
  string,
  {
    sellerSku: string;
    marketplaceId: string;
    asin: string | null;
    fulfillable: number;
    inbound: number;
    reserved: number;
    researching: number;
    unfulfillable: number;
    fcProcessingQty: number;
    customerOrdersQty: number;
    transshipmentQty: number;
    inboundWorkingQty: number;
    inboundShippedQty: number;
    inboundReceivingQty: number;
    warehouseDamagedQty: number;
    expiredQty: number;
    raw: any;
  }
>();


try {
  if (debug) {
    this.logger.debug(`Marketplaces to sync: ${marketplaceIds.join(',')}`);
  }


      
      const maxPages = opts?.maxPages;
      for (const marketplaceId of marketplaceIds) {
        marketplacesProcessed += 1;
        let nextToken: string | undefined = undefined;
        let pagesFetched = 0;

        // Paginate until exhausted (or maxPages when set, e.g. initial sync)
        while (true) {

  if (throttleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, throttleMs));
  }

  let res: any;
  try {

          res = await this.spApiClient.getFbaInventorySummaries(
  credentials,
  {
    marketplaceId,
    details: true,
    nextToken,
  },
);

          const pageCount = res?.payload?.inventorySummaries?.length ?? 0;
          const hasNext =
            !!(res?.pagination?.nextToken ?? res?.pagination?.NextToken ?? res?.Pagination?.nextToken ?? res?.Pagination?.NextToken ?? res?.nextToken ?? res?.NextToken ?? (res?.payload && (res.payload as any).nextToken) ?? (res?.payload && (res.payload as any).NextToken));
          if (debug) {
            this.logger.debug(
              `[FBA ${marketplaceId}] Page: received ${pageCount} summaries, hasNextPage=${hasNext}, totalSkusSoFar=${inventoryBySku.size}`,
            );
          }

          } catch (e: any) {
            const status = e?.response?.status ?? e?.status ?? null;
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.warn(
              `[FBA ${marketplaceId}] request failed${status ? ` (${status})` : ''}: ${msg}`,
            );
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
          const summaries =
            payload?.inventorySummaries ??
            payload?.InventorySummaries ??
            payload?.summaries ??
            [];


          for (const s of summaries) {
            const sku: string | undefined =
  s?.sellerSku ?? s?.SellerSku ?? s?.sellerSKU;

if (!sku) continue;

  const details = s.inventoryDetails ?? {};

  const fulfillable =
    details.afnFulfillableQuantity ??
    details.fulfillableQuantity ??
    0;

  const inbound =
    (details.afnInboundWorkingQuantity ?? 0) +
    (details.afnInboundShippedQuantity ?? 0) +
    (details.afnInboundReceivingQuantity ?? 0);

const key = `${marketplaceId}::${sku}`;

const rq = details.reservedQuantity;
const uq = details.unfulfillableQuantity;
const existing = inventoryBySku.get(key) ?? {
  sellerSku: sku,
  marketplaceId,
  asin: (s?.asin ?? s?.ASIN ?? null) as string | null,
  fulfillable: 0,
  inbound: 0,
  reserved: 0,
  researching: 0,
  unfulfillable: 0,
  fcProcessingQty: 0,
  customerOrdersQty: 0,
  transshipmentQty: 0,
  inboundWorkingQty: 0,
  inboundShippedQty: 0,
  inboundReceivingQty: 0,
  warehouseDamagedQty: 0,
  expiredQty: 0,
  raw: null as any,
};

existing.fulfillable += fulfillable;
existing.inbound += inbound;
existing.reserved += rq?.totalReservedQuantity ?? 0;
existing.researching += details.researchingQuantity?.totalResearchingQuantity ?? 0;
existing.unfulfillable += uq?.totalUnfulfillableQuantity ?? 0;
existing.fcProcessingQty += rq?.fcProcessingQuantity ?? 0;
existing.customerOrdersQty += rq?.pendingCustomerOrderQuantity ?? 0;
existing.transshipmentQty += rq?.pendingTransshipmentQuantity ?? 0;
existing.inboundWorkingQty += details.afnInboundWorkingQuantity ?? details.inboundWorkingQuantity ?? 0;
existing.inboundShippedQty += details.afnInboundShippedQuantity ?? details.inboundShippedQuantity ?? 0;
existing.inboundReceivingQty += details.afnInboundReceivingQuantity ?? details.inboundReceivingQuantity ?? 0;
existing.warehouseDamagedQty += uq?.warehouseDamagedQuantity ?? 0;
existing.expiredQty += uq?.expiredQuantity ?? 0;
if (s?.asin != null || s?.ASIN != null) {
  existing.asin = (s?.asin ?? s?.ASIN ?? null) as string | null;
}
existing.raw = s;

inventoryBySku.set(key, existing);


            
            upsertedInventoryRows += 1;
          }

          pagesFetched += 1;
          if (maxPages != null && maxPages > 0 && pagesFetched >= maxPages) {
            if (debug) {
              this.logger.debug(
                `[FBA ${marketplaceId}] Stopping after ${pagesFetched} page(s) (maxPages=${maxPages})`,
              );
            }
            break;
          }

          // SP-API returns next page token in pagination (or payload); check all known locations
          const rawToken: string | undefined =
            res?.pagination?.nextToken ??
            res?.pagination?.NextToken ??
            res?.Pagination?.nextToken ??
            res?.Pagination?.NextToken ??
            res?.nextToken ??
            res?.NextToken ??
            payload?.nextToken ??
            payload?.NextToken ??
            res?.payload?.nextToken ??
            res?.payload?.NextToken ??
            undefined;
          const token = typeof rawToken === 'string' ? rawToken.trim() || undefined : undefined;

          if (!token) {
            if (debug) {
              this.logger.debug(
                `[FBA ${marketplaceId}] No more pages; totalSkusInMap=${inventoryBySku.size}`,
              );
            }
            break;
          }
          nextToken = token;
          if (debug) {
            this.logger.debug(
              `[FBA ${marketplaceId}] Pagination: fetching next page (nextToken length=${token.length}, totalSkusSoFar=${inventoryBySku.size})`,
            );
          }
        }
        // Initial sync: only first marketplace's first page(s) to get top 10 in-stock for fee estimates
        if (maxPages != null && maxPages > 0) break;
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



// SAVE INVENTORY
// 1) Save per-marketplace rows into InventoryByMarketplace
// 2) Build true aggregates across marketplaces and save totals into Inventory
try {
  for (const row of inventoryBySku.values()) {
    const sku = row.sellerSku;
    const product = await this.prisma.product.upsert({
      where: {
        userId_sku: {
          userId: ownerUserId,
          sku: row.sellerSku,
        },
      },
      update: {
        asin: row.asin ?? undefined,
      },
      create: {
        userId: ownerUserId,
        sku: row.sellerSku,
        asin: row.asin ?? null,
      },
    });
    const match = { id: product.id, userId: product.userId, updatedAt: product.updatedAt };
    bySku.set(sku, match);

    const totalQty =
      row.fulfillable +
      row.inbound +
      row.reserved +
      row.researching +
      row.unfulfillable;

    const byMp = {
      userId: match.userId,
      fulfillableQty: row.fulfillable,
      inboundQty: row.inbound,
      reservedQty: row.reserved,
      researchingQty: row.researching,
      unfulfillableQty: row.unfulfillable,
      currentQty: totalQty,
      fcProcessingQty: row.fcProcessingQty ?? 0,
      customerOrdersQty: row.customerOrdersQty ?? 0,
      transshipmentQty: row.transshipmentQty ?? 0,
      inboundWorkingQty: row.inboundWorkingQty ?? 0,
      inboundShippedQty: row.inboundShippedQty ?? 0,
      inboundReceivingQty: row.inboundReceivingQty ?? 0,
      warehouseDamagedQty: row.warehouseDamagedQty ?? 0,
      expiredQty: row.expiredQty ?? 0,
      rawJson: row.raw ?? row,
    };
    await this.prisma.inventoryByMarketplace.upsert({
      where: {
        productId_marketplaceId: {
          productId: match.id,
          marketplaceId: row.marketplaceId,
        },
      },
      update: byMp,
      create: {
        ...byMp,
        productId: match.id,
        marketplaceId: row.marketplaceId,
      },
    });
  }

  // Build true aggregates across marketplaces (per SKU)
  const aggregateBySku = new Map<
    string,
    {
      sellerSku: string;
      asin: string | null;
      fulfillable: number;
      inbound: number;
      reserved: number;
      researching: number;
      unfulfillable: number;
      raw: any[];
    }
  >();

  for (const row of inventoryBySku.values()) {
    const existing = aggregateBySku.get(row.sellerSku) ?? {
      sellerSku: row.sellerSku,
      asin: row.asin ?? null,
      fulfillable: 0,
      inbound: 0,
      reserved: 0,
      researching: 0,
      unfulfillable: 0,
      raw: [],
    };

    existing.fulfillable += row.fulfillable;
    existing.inbound += row.inbound;
    existing.reserved += row.reserved;
    existing.researching += row.researching;
    existing.unfulfillable += row.unfulfillable;
    if (row.asin != null) existing.asin = row.asin;
    existing.raw.push(row.raw);

    aggregateBySku.set(row.sellerSku, existing);
  }

  // Save aggregate totals (per SKU) into Inventory
  for (const agg of aggregateBySku.values()) {
    const sku = agg.sellerSku;
    const product = await this.prisma.product.upsert({
      where: {
        userId_sku: {
          userId: ownerUserId,
          sku: agg.sellerSku,
        },
      },
      update: {
        asin: agg.asin ?? undefined,
      },
      create: {
        userId: ownerUserId,
        sku: agg.sellerSku,
        asin: agg.asin ?? null,
      },
    });
    const match = { id: product.id, userId: product.userId, updatedAt: product.updatedAt };
    bySku.set(sku, match);

    const totalQty =
      agg.fulfillable +
      agg.inbound +
      agg.reserved +
      agg.researching +
      agg.unfulfillable;
    const issueQty = agg.researching + agg.unfulfillable;

    await this.prisma.inventory.upsert({
      where: {
        productId: match.id,
      },
      update: {
        userId: match.userId,
        availableQty: agg.fulfillable,
        reservedQty: agg.reserved,
        inboundQty: agg.inbound,
        issueQty,
        totalQty,
        rawJson: agg.raw as object,
      },
      create: {
        userId: match.userId,
        productId: match.id,
        availableQty: agg.fulfillable,
        reservedQty: agg.reserved,
        inboundQty: agg.inbound,
        issueQty,
        totalQty,
        rawJson: agg.raw as object,
      },
    });
  }
  const writtenCount = aggregateBySku.size;
  this.logger.log(`[syncFbaInventory] wrote ${writtenCount} inventory row(s) for org ${orgId}`);
  if (writtenCount === 0) {
    this.logger.warn(`[syncFbaInventory] FBA API returned no inventory for this org – check credentials and that the seller has FBA inventory. Existing DB rows are not deleted.`);
  }
} catch (e) {
  throw e;
}

    // Catalog category backfill no longer runs inline here (was adding 1s per ASIN + API time, e.g. 2.5+ min for 94 ASINs).
    // Use the "Backfill catalog category" API or a dedicated job if needed.

} // closes: syncFbaInventory

  /**
   * SKUs with an inventory row but no fee snapshot or listed price yet.
   * Dashboard stock value uses currentListedPrice × qty (0 when null), so missing rows skew totals.
   */
  async countInventoryProductsMissingFeeSnapshot(orgId: string): Promise<number> {
    const userIds = await this.getOrgMemberUserIds(orgId);
    if (userIds.length === 0) return 0;
    return this.prisma.product.count({
      where: {
        userId: { in: userIds },
        sku: { not: '' },
        inventory: { isNot: null },
        OR: [{ estimatedAmazonFeeUpdatedAt: null }, { currentListedPrice: null }],
      },
    });
  }

  /**
   * Refresh estimated Amazon fees per product and current listed price.
   * - Fetches this seller's current listed price from Listings API and upserts Product.currentListedPrice.
   * - Calls Product Fees API with that price (or sold price when we have orders) and saves estimated referral/FBA/total.
   * Estimated fees and estimated profit (based on current listed price + fee estimate) are distinct from concluded
   * fees and profit (actual amounts after sale, from Finances API / order items).
   */
  async refreshFeeEstimatesForOrg(
    orgId: string,
    options?: {
      onProgress?: (progress: { processed: number; total: number }) => void | Promise<void>;
      /** When set, only process this many products with highest total quantity in stock (for initial sync quick pass). */
      topByQuantityInStock?: number;
    },
  ): Promise<{
    skipped?: boolean;
    reason?: string;
    updatedCount?: number;
    errorCount?: number;
    skippedCount?: number;
    total?: number;
    processed?: number;
  }> {
    // Optional: throttle to once per 24h (uncomment to re-enable)
    // const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    // const org = await this.prisma.organization.findUnique({
    //   where: { id: orgId },
    //   select: { lastFeesEstimateAt: true },
    // });
    // if (org?.lastFeesEstimateAt) {
    //   const elapsed = Date.now() - org.lastFeesEstimateAt.getTime();
    //   if (elapsed < ONE_DAY_MS) {
    //     return { skipped: true, reason: 'already_run_today' };
    //   }
    // }

    const credentials = await this.getAmazonCredentialsForOrg(orgId);
    const userIds = await this.getOrgMemberUserIds(orgId);
    const regionMarketplaceIds: Record<string, string[]> = {
      eu: ['A1F83G8C2ARO7P', 'A1PA6795UKMFR9', 'A13V1IB3VIYZZH'],
      na: ['ATVPDKIKX0DER'],
      fe: ['A1VC38T7YXB528'],
    };
    const marketplaceId =
      (regionMarketplaceIds[credentials.region ?? 'na'] ?? regionMarketplaceIds.na)[0] ?? 'ATVPDKIKX0DER';
    const marketplaceIds = regionMarketplaceIds[credentials.region ?? 'eu'] ?? regionMarketplaceIds.eu;

    // Need sellerId for Listings API: getListingsItem returns this seller's own listing and their listed price (not other sellers' or buy box).
    const account = await this.prisma.sellerAccount.findFirst({
      where: { userId: { in: userIds }, marketplace: 'amazon' },
      orderBy: { updatedAt: 'desc' },
      select: { sellerId: true },
    });
    const sellerId = account?.sellerId ?? null;

    const batchSize = 50;
    const totalProductCount = await this.prisma.product.count({
      where: { userId: { in: userIds }, sku: { not: '' } },
    });

    // Load all order items for the org once (like FBA fetches all pages); sold price is then available for every batch.
    const orderItems = await this.prisma.orderItem.findMany({
      where: { userId: { in: userIds } },
      select: { productId: true, revenueTotal: true, quantity: true },
    });
    const soldPriceByProductId = new Map<string, number[]>();
    for (const item of orderItems) {
      const qty = Number(item.quantity) || 1;
      const rev = Number(item.revenueTotal) || 0;
      const unitPrice = rev / qty;
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;
      const arr = soldPriceByProductId.get(item.productId) ?? [];
      arr.push(unitPrice);
      soldPriceByProductId.set(item.productId, arr);
    }
    const defaultListingPrice = 15;
    const getSoldPrice = (productId: string): number | null => {
      const arr = soldPriceByProductId.get(productId);
      if (!arr?.length) return null;
      const sum = arr.reduce((a, b) => a + b, 0);
      const avg = sum / arr.length;
      return Number.isFinite(avg) && avg > 0 ? Math.round(avg * 100) / 100 : null;
    };

    const listingCurrency = credentials.region === 'eu' ? 'GBP' : credentials.region === 'fe' ? 'JPY' : 'USD';
    // Delay between each Product Fees API call to avoid 429. Configurable via FEE_ESTIMATE_DELAY_MS (default 1000ms).
    const delayMs = Math.max(500, Number(this.configService.get<string>('FEE_ESTIMATE_DELAY_MS')) || 1000);
    const retryWaitMs = 60000;
    let updatedCount = 0;
    let errorCount = 0;
    let totalProcessed = 0;

    const topN = options?.topByQuantityInStock;
    const isTopNPass = topN != null && topN > 0;
    if (isTopNPass) {
      const invRows = await this.prisma.inventory.findMany({
        where: { userId: { in: userIds } },
        orderBy: { totalQty: 'desc' },
        take: topN * 2,
        select: { productId: true },
      });
      const productIds = [...new Set(invRows.map((r) => r.productId))].slice(0, topN);
      if (productIds.length === 0) {
        this.logger.log(`[refreshFeeEstimatesForOrg] Top-${topN} pass: no inventory rows, skipping`);
        return { updatedCount: 0, errorCount: 0, skippedCount: 0, total: 0, processed: 0 };
      }
      const products = await this.prisma.product.findMany({
        where: { id: { in: productIds }, sku: { not: '' } },
        select: { id: true, sku: true, asin: true, currentListedPrice: true },
      });
      this.logger.log(`[refreshFeeEstimatesForOrg] Top-${topN} pass: processing ${products.length} products only (initial sync); full fee sync runs in background`);
      await options?.onProgress?.({ processed: 0, total: products.length });
      const currentListedPriceByProductId = new Map<string, number>();
      for (const p of products) {
        const raw = (p as any).currentListedPrice;
        if (raw != null) {
          const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(String(raw));
          if (Number.isFinite(n) && n > 0) currentListedPriceByProductId.set(p.id, n);
        }
      }
      const toProcess = products.slice(0, topN);
      const delayMsTop = 200;
      let updatedCountTop = 0;
      let errorCountTop = 0;
      let processedTop = 0;
      for (const product of toProcess) {
        const callOnce = async (useAsin: boolean): Promise<boolean> => {
          let currentListedPriceToSave: number | null = null;
          if (sellerId) {
            try {
              const listingRes = await this.spApiClient.getListingsItem(
                credentials,
                sellerId,
                product.sku,
                [marketplaceId],
                ['summaries', 'offers', 'attributes'],
              );
              const parsed = this.parseListingsItemPrice(listingRes as any);
              if (parsed != null && parsed > 0) currentListedPriceToSave = parsed;
            } catch {
              // keep existing
            }
          }
          const soldPrice = getSoldPrice(product.id);
          const storedListedPrice = currentListedPriceByProductId.get(product.id) ?? null;
          const listingPriceAmount =
            soldPrice ?? currentListedPriceToSave ?? storedListedPrice ?? defaultListingPrice;
          const params = {
            marketplaceId,
            isAmazonFulfilled: true,
            listingPriceAmount,
            listingPriceCurrency: listingCurrency,
          };
          try {
            const res = useAsin && product.asin
              ? ((await this.spApiClient.getMyFeesEstimateForASIN(credentials, product.asin, params)) as any)
              : ((await this.spApiClient.getMyFeesEstimateForSKU(credentials, product.sku, params)) as any);
            const breakdown = this.parseFeesEstimateBreakdown(res);
            const hasValidTotal = breakdown.total != null && Number.isFinite(breakdown.total);
            const ref = breakdown.referralFee ?? 0;
            const fba = breakdown.fbaFee ?? 0;
            const digitalFromApi = breakdown.digitalServiceFee ?? 0;
            const digitalToSave =
              digitalFromApi > 0
                ? digitalFromApi
                : credentials.region === 'eu' && (ref !== 0 || fba !== 0)
                  ? Math.round((ref + fba) * 0.02 * 100) / 100
                  : undefined;
            const feeResult = (res as any)?.payload?.FeesEstimateResult ?? (res as any)?.FeesEstimateResult;
            const priceInFeeRes = feeResult?.FeesEstimateIdentifier?.PriceToEstimateFees?.ListingPrice
              ?? feeResult?.feesEstimateIdentifier?.priceToEstimateFees?.listingPrice;
            const amountFromFeeRaw = priceInFeeRes?.Amount ?? priceInFeeRes?.amount;
            const amountFromFee = typeof amountFromFeeRaw === 'number' && Number.isFinite(amountFromFeeRaw)
              ? amountFromFeeRaw
              : typeof amountFromFeeRaw === 'string'
                ? parseFloat(amountFromFeeRaw)
                : null;
            const listingPriceToPersist =
              currentListedPriceToSave
              ?? (amountFromFee != null && !Number.isNaN(amountFromFee) && amountFromFee > 0 ? amountFromFee : null)
              ?? currentListedPriceByProductId.get(product.id)
              ?? listingPriceAmount;
            const persistPrice = listingPriceToPersist !== defaultListingPrice
              || currentListedPriceToSave != null
              || currentListedPriceByProductId.has(product.id);
            await this.prisma.product.update({
              where: { id: product.id },
              data: {
                feeEstimateRawJson: res ?? undefined,
                ...(persistPrice ? { currentListedPrice: listingPriceToPersist } : {}),
                ...(hasValidTotal
                  ? {
                      estimatedAmazonFeePerUnit: breakdown.total,
                      estimatedReferralFeePerUnit: breakdown.referralFee ?? undefined,
                      estimatedFbaFeePerUnit: breakdown.fbaFee ?? undefined,
                      estimatedDigitalServiceFeePerUnit: digitalToSave ?? breakdown.digitalServiceFee ?? undefined,
                      estimatedAmazonFeeUpdatedAt: new Date(),
                    }
                  : {}),
              },
            });
            return hasValidTotal;
          } catch {
            return false;
          }
        };
        try {
          await new Promise((r) => setTimeout(r, delayMsTop));
          let ok = product.asin ? await callOnce(true) : await callOnce(false);
          if (!ok && product.asin) ok = await callOnce(false);
          if (ok) updatedCountTop += 1;
          else errorCountTop += 1;
        } catch {
          errorCountTop += 1;
        }
        processedTop += 1;
        await options?.onProgress?.({ processed: processedTop, total: toProcess.length });
      }
      this.logger.log(`[refreshFeeEstimatesForOrg] Top-${topN} pass done: updated=${updatedCountTop} errors=${errorCountTop}`);
      return {
        updatedCount: updatedCountTop,
        errorCount: errorCountTop,
        skippedCount: Math.max(0, toProcess.length - updatedCountTop - errorCountTop),
        total: toProcess.length,
        processed: toProcess.length,
      };
    }

    // Full pass: only when topByQuantityInStock was NOT set (e.g. fee-sync job or manual Refresh fees).
    // Initial sync only runs the top-10 block above and returns; this loop must never run for initial sync.
    await options?.onProgress?.({ processed: 0, total: totalProductCount });

    // Paginate until all products are processed (same pattern as FBA inventory: loop until no more pages).
    while (true) {
      const neverUpdated = await this.prisma.product.findMany({
        where: { userId: { in: userIds }, sku: { not: '' }, estimatedAmazonFeeUpdatedAt: null },
        orderBy: { updatedAt: 'asc' },
        take: batchSize,
        select: { id: true, sku: true, asin: true, currentListedPrice: true },
      });
      let products: Array<{ id: string; sku: string; asin: string | null; currentListedPrice: unknown }> = neverUpdated;
      if (products.length < batchSize) {
        const take = batchSize - products.length;
        const idsToExclude = products.map((p) => p.id);
        const oldestUpdated = await this.prisma.product.findMany({
          where: {
            userId: { in: userIds },
            sku: { not: '' },
            estimatedAmazonFeeUpdatedAt: { not: null },
            id: { notIn: idsToExclude },
          },
          orderBy: { estimatedAmazonFeeUpdatedAt: 'asc' },
          take,
          select: { id: true, sku: true, asin: true, currentListedPrice: true },
        });
        products = [...products, ...oldestUpdated];
      }
      if (products.length === 0) break;

      const currentListedPriceByProductId = new Map<string, number>();
      for (const p of products) {
        const raw = (p as any).currentListedPrice;
        if (raw != null) {
          const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(String(raw));
          if (Number.isFinite(n) && n > 0) currentListedPriceByProductId.set(p.id, n);
        }
      }
      const toProcess = products.slice(0, batchSize);

      for (const product of toProcess) {
      const callOnce = async (useAsin: boolean): Promise<boolean> => {
        // Fetch this seller's current listed price from Listings API when possible; upsert so DB stays in sync when price changes.
        let currentListedPriceToSave: number | null = null;
        if (sellerId) {
          try {
            const listingRes = await this.spApiClient.getListingsItem(
              credentials,
              sellerId,
              product.sku,
              [marketplaceId],
              ['summaries', 'offers', 'attributes'],
            );
            const parsed = this.parseListingsItemPrice(listingRes as any);
            if (parsed != null && parsed > 0) currentListedPriceToSave = parsed;
          } catch {
            // Listings API may 403/404 for some SKUs; keep existing currentListedPrice if fetch fails
          }
        }
        // For fee estimate: sold price > just-fetched listing price > stored currentListedPrice > default (so referral is never understated).
        const soldPrice = getSoldPrice(product.id);
        const storedListedPrice = currentListedPriceByProductId.get(product.id) ?? null;
        const listingPriceAmount =
          soldPrice ?? currentListedPriceToSave ?? storedListedPrice ?? defaultListingPrice;

        const params = {
          marketplaceId,
          isAmazonFulfilled: true,
          listingPriceAmount,
          listingPriceCurrency: listingCurrency,
        };
        const res = useAsin && product.asin
          ? ((await this.spApiClient.getMyFeesEstimateForASIN(
              credentials,
              product.asin,
              params,
            )) as any)
          : ((await this.spApiClient.getMyFeesEstimateForSKU(
              credentials,
              product.sku,
              params,
            )) as any);
        const breakdown = this.parseFeesEstimateBreakdown(res);
        // Fees from API are typically negative; accept any finite total so we persist the breakdown.
        const hasValidTotal = breakdown.total != null && Number.isFinite(breakdown.total);
        // UK fallback: if API doesn't return digital service fee, use 2% of (referral + FBA) for EU/UK
        const ref = breakdown.referralFee ?? 0;
        const fba = breakdown.fbaFee ?? 0;
        const digitalFromApi = breakdown.digitalServiceFee ?? 0;
        const digitalToSave =
          digitalFromApi > 0
            ? digitalFromApi
            : credentials.region === 'eu' && (ref !== 0 || fba !== 0)
              ? Math.round((ref + fba) * 0.02 * 100) / 100
              : undefined;
        // Always persist the price we used for the fee estimate so current_listed_price is never left null.
        const feeResult = (res as any)?.payload?.FeesEstimateResult ?? (res as any)?.FeesEstimateResult;
        const priceInFeeRes = feeResult?.FeesEstimateIdentifier?.PriceToEstimateFees?.ListingPrice
          ?? feeResult?.feesEstimateIdentifier?.priceToEstimateFees?.listingPrice;
        const amountFromFeeRaw = priceInFeeRes?.Amount ?? priceInFeeRes?.amount;
        const amountFromFee = typeof amountFromFeeRaw === 'number' && Number.isFinite(amountFromFeeRaw)
          ? amountFromFeeRaw
          : typeof amountFromFeeRaw === 'string'
            ? parseFloat(amountFromFeeRaw)
            : null;
        const listingPriceToPersist =
          currentListedPriceToSave
          ?? (amountFromFee != null && !Number.isNaN(amountFromFee) && amountFromFee > 0 ? amountFromFee : null)
          ?? currentListedPriceByProductId.get(product.id)
          ?? listingPriceAmount;
        // Don't persist the default 15 when we have no real listing price (so DB stays null/real values instead of filled with 15).
        const persistPrice = listingPriceToPersist !== defaultListingPrice
          || currentListedPriceToSave != null
          || currentListedPriceByProductId.has(product.id);
        // Update only fee and price fields; do not touch productType, displayGroup, or other catalog data.
        await this.prisma.product.update({
          where: { id: product.id },
          data: {
            feeEstimateRawJson: res ?? undefined,
            ...(persistPrice ? { currentListedPrice: listingPriceToPersist } : {}),
            ...(hasValidTotal
              ? {
                  estimatedAmazonFeePerUnit: breakdown.total,
                  estimatedReferralFeePerUnit: breakdown.referralFee ?? undefined,
                  estimatedFbaFeePerUnit: breakdown.fbaFee ?? undefined,
                  estimatedDigitalServiceFeePerUnit: digitalToSave ?? breakdown.digitalServiceFee ?? undefined,
                  estimatedAmazonFeeUpdatedAt: new Date(),
                }
              : {}),
          },
        });
        return !!hasValidTotal;
      };

      try {
        let ok = product.asin ? await callOnce(true) : await callOnce(false);
        if (!ok && product.asin) ok = await callOnce(false);
        if (ok) updatedCount += 1;
        else if (!ok) errorCount += 1;
      } catch (e) {
        const msg = (e as Error).message ?? '';
        const is429 = msg.includes('(429)') || msg.includes('QuotaExceeded');
        if (is429) {
          this.logger.warn(
            `[refreshFeeEstimatesForOrg] SKU ${product.sku} rate limited (429); waiting ${retryWaitMs / 1000}s before retry…`,
          );
          await new Promise((r) => setTimeout(r, retryWaitMs));
          try {
            let ok = product.asin ? await callOnce(true) : await callOnce(false);
            if (!ok && product.asin) ok = await callOnce(false);
            if (ok) updatedCount += 1;
            else errorCount += 1;
          } catch (retryErr) {
            this.logger.warn(
              `[refreshFeeEstimatesForOrg] SKU ${product.sku} failed after retry: ${(retryErr as Error).message}`,
            );
            errorCount += 1;
          }
        } else {
          this.logger.warn(
            `[refreshFeeEstimatesForOrg] SKU ${product.sku} failed: ${msg}`,
          );
          errorCount += 1;
        }
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }

      totalProcessed += toProcess.length;
      await options?.onProgress?.({
        processed: Math.min(totalProcessed, totalProductCount),
        total: totalProductCount,
      });
      if (
        toProcess.length < batchSize ||
        totalProcessed >= totalProductCount
      ) {
        break;
      }
    }

    await this.prisma.organization.update({
      where: { id: orgId },
      data: { lastFeesEstimateAt: new Date() },
    });

    const skippedCount = Math.max(0, totalProductCount - totalProcessed);
    return { updatedCount, errorCount, skippedCount, total: totalProductCount, processed: totalProcessed };
  }

  /** Parse total fee amount from Product Fees API (referral + FBA + all components).
   * Prefer summing FeeDetailList so we include every component (referral, FBA, etc.);
   * use TotalFeesEstimate only when FeeDetailList is empty (some responses may only have the total).
   */
  private parseFeesEstimateAmount(res: any): number | null {
    const result = res?.payload?.FeesEstimateResult ?? res?.FeesEstimateResult ?? res;
    if (!result) return null;
    const fees = result.FeesEstimate ?? result.feesEstimate;
    if (!fees) return null;

    const moneyToNum = (m: any): number => {
      if (m == null) return 0;
      const a = m.Amount ?? m.amount ?? m.CurrencyAmount ?? (typeof m.CurrencyAmount === 'object' ? m.CurrencyAmount?.Amount : null);
      if (typeof a === 'number' && Number.isFinite(a)) return a;
      if (typeof a === 'string') return parseFloat(a) || 0;
      return 0;
    };

    const sumFeeDetailList = (list: any[] | undefined): number => {
      if (!Array.isArray(list)) return 0;
      let sum = 0;
      for (const item of list) {
        const included = item.IncludedFeeDetailList ?? item.includedFeeDetailList;
        if (Array.isArray(included) && included.length > 0) {
          sum += sumFeeDetailList(included);
        } else {
          sum += moneyToNum(item.FinalFee ?? item.finalFee ?? item.FeeAmount ?? item.feeAmount);
        }
      }
      return sum;
    };

    const list = fees.FeeDetailList ?? fees.feeDetailList;
    if (Array.isArray(list) && list.length > 0) {
      const fromDetails = sumFeeDetailList(list);
      if (Number.isFinite(fromDetails)) return fromDetails;
    }

    const total = fees.TotalFeesEstimate ?? fees.totalFeesEstimate;
    if (total != null) {
      const amt = moneyToNum(total);
      if (Number.isFinite(amt)) return amt;
    }
    return null;
  }

  /** Parse fee breakdown from Product Fees API: total, referral, FBA, and digital service fee from FeeDetailList. */
  private parseFeesEstimateBreakdown(res: any): {
    total: number | null;
    referralFee: number | null;
    fbaFee: number | null;
    digitalServiceFee: number | null;
  } {
    const result = res?.payload?.FeesEstimateResult ?? res?.FeesEstimateResult ?? res;
    if (!result) return { total: null, referralFee: null, fbaFee: null, digitalServiceFee: null };
    const fees = result.FeesEstimate ?? result.feesEstimate;
    if (!fees) return { total: null, referralFee: null, fbaFee: null, digitalServiceFee: null };

    const moneyToNum = (m: any): number => {
      if (m == null) return 0;
      const a = m.Amount ?? m.amount ?? m.CurrencyAmount ?? (typeof m.CurrencyAmount === 'object' ? m.CurrencyAmount?.Amount : null);
      if (typeof a === 'number' && Number.isFinite(a)) return a;
      if (typeof a === 'string') return parseFloat(a) || 0;
      return 0;
    };

    const list = fees.FeeDetailList ?? fees.feeDetailList;
    let total: number | null = null;
    let referralFee: number | null = null;
    let fbaFee: number | null = null;
    let digitalServiceFee: number | null = null;

    if (Array.isArray(list) && list.length > 0) {
      let sum = 0;
      let fbaFromNested = 0;
      for (const item of list) {
        const feeType = (item.FeeType ?? item.feeType ?? '') as string;
        // Prefer FeeAmount over FinalFee: when there's a promotion, FinalFee can be 0 but FeeAmount has the actual fee (e.g. FBA 3.14).
        const amount = moneyToNum(item.FeeAmount ?? item.feeAmount ?? item.FinalFee ?? item.finalFee);
        if (Number.isFinite(amount)) sum += amount;
        if (feeType === 'ReferralFee') referralFee = amount;
        else if (feeType === 'FBAFees') fbaFee = amount;
        else if (feeType === 'VariableClosingFee' || feeType === 'DigitalServiceFee') digitalServiceFee = amount;
        // Some responses put FBA only under IncludedFeeDetailList (e.g. FBAPickAndPack); use it when top-level FBAFees is missing.
        const included = item.IncludedFeeDetailList ?? item.includedFeeDetailList;
        if (Array.isArray(included)) {
          for (const sub of included) {
            const subType = (sub.FeeType ?? sub.feeType ?? '') as string;
            const subAmt = moneyToNum(sub.FeeAmount ?? sub.feeAmount ?? sub.FinalFee ?? sub.finalFee);
            if (Number.isFinite(subAmt) && subType.startsWith('FBA')) fbaFromNested += subAmt;
          }
        }
      }
      total = sum;
      if (fbaFee == null && fbaFromNested !== 0) fbaFee = fbaFromNested;
    } else {
      const totalEst = fees.TotalFeesEstimate ?? fees.totalFeesEstimate;
      if (totalEst != null) total = moneyToNum(totalEst);
    }

    return { total: total != null && Number.isFinite(total) ? total : null, referralFee, fbaFee, digitalServiceFee };
  }

  /** Parse current listing price from Listings Items API getListingsItem response (for pre-sale fee estimate). */
  private parseListingsItemPrice(res: any): number | null {
    if (!res) return null;
    const root = res.payload ?? res;
    const extractAmount = (p: any): number | null => {
      if (p == null) return null;
      const amount =
        p.amount ?? p.Amount ?? p.value ?? p.Value
        ?? p.CurrencyAmount?.Amount ?? p.CurrencyAmount?.amount
        ?? (typeof p.CurrencyAmount === 'object' && p.CurrencyAmount != null
          ? (p.CurrencyAmount.Amount ?? p.CurrencyAmount.amount) : null);
      if (typeof amount === 'number' && Number.isFinite(amount)) return amount;
      if (typeof amount === 'string') return parseFloat(amount) || null;
      return null;
    };
    const offers = root.offers ?? root.Offers;
    if (Array.isArray(offers)) {
      for (const o of offers) {
        const price = o?.price ?? o?.Price;
        const amt = extractAmount(price);
        if (amt != null && amt > 0) return amt;
      }
    }
    const summaries = root.summaries ?? root.Summaries;
    if (Array.isArray(summaries)) {
      for (const s of summaries) {
        const listPrice = s?.list_price ?? s?.listPrice ?? s?.listingPrice;
        if (Array.isArray(listPrice)) {
          for (const lp of listPrice) {
            const v = lp?.value ?? lp?.amount ?? lp?.Value ?? lp?.Amount;
            if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
            if (typeof v === 'string') { const n = parseFloat(v); if (Number.isFinite(n) && n > 0) return n; }
          }
        }
      }
    }
    const attrs = root.attributes ?? root.Attributes;
    if (attrs && typeof attrs === 'object') {
      const listPrice = attrs.list_price ?? attrs.listPrice ?? attrs.listingPrice;
      if (Array.isArray(listPrice) && listPrice.length > 0) {
        const v = listPrice[0]?.value ?? listPrice[0]?.amount;
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string') return parseFloat(v) || null;
      }
    }
    const found = this.findFirstPositiveAmount(root);
    if (found != null) return found;
    return null;
  }

  /** Deep-search for a numeric amount/price in JSON (fallback when Listings API structure varies). Only accepts values that look like prices (0.01–100000). */
  private findFirstPositiveAmount(obj: any, depth = 0): number | null {
    if (depth > 10 || obj == null) return null;
    const accept = (n: number) => Number.isFinite(n) && n >= 0.01 && n <= 100000;
    if (typeof obj === 'number' && accept(obj)) return obj;
    if (typeof obj !== 'object') return null;
    const keys = ['amount', 'Amount', 'value', 'Value'];
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        const v = obj[k];
        if (typeof v === 'number' && accept(v)) return v;
        if (typeof v === 'string') { const n = parseFloat(v); if (accept(n)) return n; }
      }
    }
    for (const v of Object.values(obj)) {
      const n = this.findFirstPositiveAmount(v, depth + 1);
      if (n != null) return n;
    }
    return null;
  }

  /** Dev: return raw Product Fees API response for one SKU or ASIN to debug fee structure. */
  async devGetFeesEstimateRaw(
    orgId: string,
    opts: { sku?: string; asin?: string; listingPrice?: number; save?: boolean },
  ): Promise<unknown> {
    const credentials = await this.getAmazonCredentialsForOrg(orgId);
    const regionMarketplaceIds: Record<string, string[]> = {
      eu: ['A1F83G8C2ARO7P'],
      na: ['ATVPDKIKX0DER'],
      fe: ['A1VC38T7YXB528'],
    };
    const marketplaceId = (regionMarketplaceIds[credentials.region ?? 'na'] ?? regionMarketplaceIds.na)[0] ?? 'ATVPDKIKX0DER';
    const listingPriceAmount = opts.listingPrice ?? 15;
    const params = { marketplaceId, isAmazonFulfilled: true, listingPriceAmount, listingPriceCurrency: 'GBP' as const };
    const res = opts.asin
      ? await this.spApiClient.getMyFeesEstimateForASIN(credentials, opts.asin, params)
      : await this.spApiClient.getMyFeesEstimateForSKU(credentials, opts.sku!, params);
    const parsed = this.parseFeesEstimateAmount(res as any);
    const result = (res as any)?.payload?.FeesEstimateResult ?? (res as any)?.FeesEstimateResult;
    const fees = result?.FeesEstimate ?? result?.feesEstimate;
    const detailList = fees?.FeeDetailList ?? fees?.feeDetailList;
    const totalEst = fees?.TotalFeesEstimate ?? fees?.totalFeesEstimate;
    const summary = {
      hasFeeDetailList: Array.isArray(detailList) && detailList.length > 0,
      feeDetailListLength: Array.isArray(detailList) ? detailList.length : 0,
      totalFeesEstimateAmount: totalEst != null ? (totalEst.Amount ?? totalEst.amount ?? totalEst.CurrencyAmount) : null,
      parsedAmount: parsed,
    };
    const out = { raw: res, parsedAmount: parsed, _summary: summary };
    if (opts.save) {
      const path = require('path');
      const fs = require('fs');
      const filePath = path.join(process.cwd(), 'fee-estimate-debug.json');
      fs.writeFileSync(filePath, JSON.stringify(out, null, 2), 'utf8');
      this.logger.log(`[devGetFeesEstimateRaw] Wrote ${filePath}`);
      return { ...out, savedTo: filePath };
    }
    return out;
  }

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
        rawResponse: true,
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
      type FeeBreakdownBackfill = { referral: number; fba: number; digital: number };
      const breakdownByOrderItemId = new Map<string, FeeBreakdownBackfill>();
      const breakdownBySku = new Map<string, FeeBreakdownBackfill>();
      const addFee = (
        map: Map<string, number>,
        key: string,
        amount: number,
      ) => {
        if (!key) return;
        map.set(key, (map.get(key) ?? 0) + amount);
      };
      const sumFeeOrChargeList = (list: any[] | undefined): number => {
        if (!Array.isArray(list)) return 0;
        return list.reduce((sum, fc) => {
          const feeAmt = fc?.FeeAmount?.CurrencyAmount ?? fc?.FeeAmount?.Amount;
          const chargeAmt = fc?.ChargeAmount?.CurrencyAmount ?? fc?.ChargeAmount?.Amount ?? fc?.ChargeAmount;
          const n = Number(feeAmt ?? chargeAmt ?? 0);
          return Number.isNaN(n) ? sum : sum + n;
        }, 0);
      };
      const parseFeeBreakdownBackfill = (list: any[] | undefined): FeeBreakdownBackfill => {
        const out = { referral: 0, fba: 0, digital: 0 };
        const readAmt = (obj: any): number => {
          if (!obj) return 0;
          const a = obj?.FeeAmount ?? obj?.feeAmount ?? obj;
          const n = a?.CurrencyAmount ?? a?.currencyAmount ?? a?.Amount ?? a?.amount;
          const num = Number(n);
          return Number.isNaN(num) ? 0 : num;
        };
        const addFee = (feeType: string, amt: number) => {
          if (amt === 0) return;
          const t = (feeType || '').toLowerCase();
          if (t === 'referralfee' || t.includes('referral') || t === 'commission') out.referral += amt;
          else if (t === 'fbafees' || t.startsWith('fba') || t.includes('fulfillment')) out.fba += amt;
          else if (t === 'variableclosingfee' || t === 'digitalservicefee' || t.includes('digital')) out.digital += amt;
        };
        if (!Array.isArray(list)) return out;
        for (const fc of list) {
          const feeType = (fc?.FeeType ?? fc?.feeType ?? fc?.Type ?? '') as string;
          const amt = readAmt(fc);
          if (amt !== 0) addFee(feeType, amt);
          const components = fc?.FeeComponent ?? fc?.feeComponent ?? fc?.FeeDetailList;
          if (Array.isArray(components)) {
            for (const comp of components) {
              const ct = (comp?.FeeType ?? comp?.feeType ?? comp?.Type ?? '') as string;
              const ca = readAmt(comp);
              if (ca !== 0) addFee(ct, ca);
            }
          }
        }
        return out;
      };
      const addFeeBreakdownBackfill = (
        map: Map<string, FeeBreakdownBackfill>,
        key: string,
        r: number,
        f: number,
        d: number,
      ) => {
        if (!key) return;
        const cur = map.get(key) ?? { referral: 0, fba: 0, digital: 0 };
        map.set(key, { referral: cur.referral + r, fba: cur.fba + f, digital: cur.digital + d });
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
          const keyLower = keyName.toLowerCase();
          for (const [k, v] of Object.entries(
            input as Record<string, unknown>,
          )) {
            if ((k === keyName || k.toLowerCase() === keyLower) && v && typeof v === 'object') {
              const obj = v as Record<string, unknown>;
              const amt = obj.CurrencyAmount ?? obj.currencyAmount ?? obj.Amount ?? obj.amount;
              const n = Number(amt ?? 0);
              if (!Number.isNaN(n)) total += n;
            } else {
              total += sumCurrencyAmountsByKey(v, keyName);
            }
          }
          return total;
        };

        amazonFeesTotal = sumCurrencyAmountsByKey(finRes, 'FeeAmount');

        const events =
          finRes?.payload?.FinancialEvents ??
          finRes?.payload?.financialEvents ??
          {};
        const shipmentLists = [
          ...(events?.ShipmentSettleEventList ?? events?.shipmentSettleEventList ?? []),
          ...(events?.ShipmentEventList ?? events?.shipmentEventList ?? []),
          ...(events?.RefundEventList ?? events?.refundEventList ?? []),
          ...(events?.ChargebackEventList ?? events?.chargebackEventList ?? []),
          ...(events?.GuaranteeClaimEventList ?? events?.guaranteeClaimEventList ?? []),
        ];
        for (const ev of shipmentLists) {
          const items = ev?.ShipmentItemList ?? ev?.shipmentItemList ?? [];
          for (const si of items) {
            const fee =
              sumFeeOrChargeList(si?.ItemFeeList ?? si?.itemFeeList) +
              sumFeeOrChargeList(si?.ItemFeeAdjustmentList ?? si?.itemFeeAdjustmentList) +
              sumFeeOrChargeList(si?.ItemChargeList ?? si?.itemChargeList);
            const orderItemIdRaw = si?.OrderItemId ?? si?.orderItemId;
            const orderItemId = orderItemIdRaw != null ? String(orderItemIdRaw) : '';
            const sku = (si?.SellerSKU ?? si?.sellerSKU) as string | undefined;
            if (fee !== 0) {
              if (orderItemId) addFee(feeByOrderItemId, orderItemId, fee);
              if (sku) addFee(feeBySku, sku, fee);
            }
            const b1 = parseFeeBreakdownBackfill(si?.ItemFeeList ?? si?.itemFeeList);
            const b2 = parseFeeBreakdownBackfill(si?.ItemFeeAdjustmentList ?? si?.itemFeeAdjustmentList);
            const r = b1.referral + b2.referral, f = b1.fba + b2.fba, d = b1.digital + b2.digital;
            if (orderItemId) addFeeBreakdownBackfill(breakdownByOrderItemId, orderItemId, r, f, d);
            if (sku) addFeeBreakdownBackfill(breakdownBySku, sku, r, f, d);
          }
        }
      } catch (err) {
        console.warn(
          '[AmazonService.backfillOrderItems] listFinancialEventsByOrderId failed',
          { userId, amazonOrderId, err },
        );
      }

      const orderTotalAmt = this.parseOrderTotalAmountFromOrderJson(ord.rawResponse);
      const lineRevenues = this.computeLineRevenueTotals(orderItems, orderTotalAmt);
      const totalLineRevenue = lineRevenues.reduce((a, b) => a + b, 0);

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

        const revenueTotal = lineRevenues[idx] ?? 0;
        const shippingCharged = Number(it?.ShippingPrice?.Amount ?? 0);
        const taxCharged = Number(it?.ItemTax?.Amount ?? 0);

        let itemFees = 0;
        if (orderItemId && feeByOrderItemId.has(orderItemId)) {
          itemFees = feeByOrderItemId.get(orderItemId) ?? 0;
        } else if (sku && feeBySku.has(sku)) {
          itemFees = feeBySku.get(sku) ?? 0;
        } else if (totalLineRevenue > 0 && amazonFeesTotal !== 0) {
          itemFees = (revenueTotal / totalLineRevenue) * amazonFeesTotal;
        }
        // If we don't have this order's settled fees, prefer settled from another order with the same ASIN (overwrites estimates).
        let usedSameAsinSettled = false;
        if (itemFees === 0 && asin && String(asin).trim()) {
          const asinTrim = String(asin).trim();
          const sameAsinSettled = await (this.prisma as any).orderItem.findFirst({
            where: {
              userId,
              marketplace: 'amazon',
              asin: asinTrim,
              feesSource: 'finances',
              quantity: { gt: 0 },
              OR: [
                    { amazonFeesTotal: { gt: 0 } },
                    { amazonFeesTotal: { lt: 0 } },
                  ],
            },
            orderBy: { orderDate: 'desc' },
            select: { amazonFeesTotal: true, quantity: true },
          });
          if (
            sameAsinSettled &&
            sameAsinSettled.amazonFeesTotal != null &&
            Number(sameAsinSettled.amazonFeesTotal) !== 0 &&
            Number(sameAsinSettled.quantity) > 0
          ) {
            const feePerUnit =
              Number(sameAsinSettled.amazonFeesTotal) / Number(sameAsinSettled.quantity);
            itemFees = Number((feePerUnit * quantityOrdered).toFixed(2));
            usedSameAsinSettled = true;
          }
        }
        // If no settled (this order or same ASIN), use product's estimated fee (per unit × qty).
        if (itemFees === 0 && sku) {
          const productWithEst = await this.prisma.product.findUnique({
            where: { userId_sku: { userId, sku } },
            select: { estimatedAmazonFeePerUnit: true },
          });
          const estPerUnit = productWithEst?.estimatedAmazonFeePerUnit != null
            ? Number(productWithEst.estimatedAmazonFeePerUnit)
            : null;
          if (estPerUnit != null && !Number.isNaN(estPerUnit)) {
            itemFees = estPerUnit * quantityOrdered;
          }
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
        const feesFromFinances =
          (orderItemId && feeByOrderItemId.has(orderItemId)) ||
          (sku && feeBySku.has(sku)) ||
          usedSameAsinSettled;
        const settledBreakdown =
          (orderItemId && breakdownByOrderItemId.get(orderItemId)) ??
          (sku && breakdownBySku.get(sku)) ??
          null;
        const existingItem = await this.prisma.orderItem.findUnique({
          where: {
            orderDbId_orderItemId: { orderDbId: ord.id, orderItemId },
          },
          select: { amazonFeesTotal: true, profit: true, feesSource: true },
        });
        let finalFees = Number.isNaN(itemFees) ? 0 : Number(itemFees.toFixed(2));
        let finalProfit = profit != null ? Number(profit.toFixed(2)) : null;
        // Never overwrite a saved estimate with 0: keep existing until settled fees arrive.
        if (
          finalFees === 0 &&
          existingItem &&
          existingItem.amazonFeesTotal != null &&
          Number(existingItem.amazonFeesTotal) !== 0 &&
          (existingItem.feesSource as string) === 'estimate'
        ) {
          finalFees = Number(existingItem.amazonFeesTotal);
          finalProfit =
            cogsTotal != null
              ? Number((revenueTotal - taxCharged - cogsTotal + finalFees).toFixed(2))
              : null;
        }
        const updateFeesAndProfit =
          feesFromFinances || (existingItem?.feesSource as string) !== 'finances';
        const settledFeeFields =
          feesFromFinances && settledBreakdown
            ? {
                settledReferralFeeTotal: Number(settledBreakdown.referral.toFixed(2)),
                settledFbaFeeTotal: Number(settledBreakdown.fba.toFixed(2)),
                settledDigitalServiceFeeTotal: Number(settledBreakdown.digital.toFixed(2)),
              }
            : {};
        const updatePayload = {
          userId,
          productId: itemProduct.id,
          marketplace: 'amazon',
          orderId: amazonOrderId,
          sku: sku || 'AMAZON_GENERIC',
          asin,
          quantity: quantityOrdered,
          revenueTotal,
          shippingChargedTotal: Number.isNaN(shippingCharged) ? 0 : shippingCharged,
          taxChargedTotal: Number.isNaN(taxCharged) ? 0 : taxCharged,
          ...(updateFeesAndProfit
            ? {
                amazonFeesTotal: finalFees,
                profit: finalProfit,
                feesSource: feesFromFinances ? 'finances' : 'estimate',
                ...settledFeeFields,
              }
            : {}),
          cogsTotal,
          rawResponse: it,
          orderDate: ord.orderDate,
        };
        await (this.prisma as any).orderItem.upsert({
          where: {
            orderDbId_orderItemId: { orderDbId: ord.id, orderItemId },
          },
          update: updatePayload,
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
            shippingChargedTotal: Number.isNaN(shippingCharged) ? 0 : shippingCharged,
            taxChargedTotal: Number.isNaN(taxCharged) ? 0 : taxCharged,
            amazonFeesTotal: finalFees,
            feesSource: feesFromFinances ? 'finances' : 'estimate',
            ...settledFeeFields,
            cogsTotal,
            profit: finalProfit,
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

    // Extract marketplace IDs where seller is active.
    let marketplaceIds = ['A1F83G8C2ARO7P']; // UK ONLY

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
        marketplaceIds = Array.from(new Set([...marketplaceIds, ...ids]));
      }
    } catch {
      // ignore; fall back to region defaults
    }
    // Catalog API: for EU use only UK marketplace (same as orders/inventory) to avoid 404/403 from other EU marketplaces
    if ((credentials.region ?? 'eu') === 'eu') {
      marketplaceIds = ['A1F83G8C2ARO7P'];
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

    // Catalog API: strict quota (often 1–2 req/sec). Default 1s between calls to avoid 429.
    const catalogThrottleMs =
      Number(this.configService.get<string>('SPAPI_CATALOG_THROTTLE_MS')) ||
      1000;

    const userIds = await this.getOrgMemberUserIds(orgId);
    const needsBackfill = {
      userId: { in: userIds },
      asin: { not: null },
      OR: [{ title: null }, { imageUrl: null }],
    };

    // Prioritize products visible on dashboard: recent orders, top sellers, replenish
    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const startDate = new Date(
      nowSafe.getTime() - 30 * 24 * 60 * 60 * 1000,
    );
    const dateFilter = { orderDate: { gte: startDate, lte: nowSafe } };

    const byProfit = await (this.prisma as any).orderItem.groupBy({
      by: ['productId'],
      where: {
        userId: { in: userIds },
        marketplace: 'amazon',
        ...dateFilter,
        profit: { not: null },
      },
      _sum: { profit: true, quantity: true },
      orderBy: { _sum: { profit: 'desc' } },
      take: Math.max(limit * 2, 200),
    });
    const profitProductIds = byProfit
      .map((r: any) => r.productId)
      .filter(Boolean);
    const byUnits = await (this.prisma as any).orderItem.groupBy({
      by: ['productId'],
      where: {
        userId: { in: userIds },
        marketplace: 'amazon',
        ...dateFilter,
        ...(profitProductIds.length > 0
          ? { productId: { notIn: profitProductIds } }
          : {}),
      },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: limit,
    });
    const dashboardProductIds = [
      ...profitProductIds,
      ...byUnits.map((r: any) => r.productId).filter(Boolean),
    ];

    const invRows = await this.prisma.inventory.findMany({
      where: { userId: { in: userIds } },
      select: { productId: true },
      distinct: ['productId'],
    });
    const invProductIds = invRows.map((r) => r.productId);

    const allNeedingBackfill = await this.prisma.product.findMany({
      where: needsBackfill,
      select: { id: true, asin: true, title: true, imageUrl: true, updatedAt: true },
    });
    const byId = new Map(allNeedingBackfill.map((p) => [p.id, p]));
    const dashboardSet = new Set(dashboardProductIds);
    const invSet = new Set(invProductIds);

    const orderedIds: string[] = [
      ...dashboardProductIds.filter((id) => byId.has(id)),
      ...invProductIds.filter(
        (id) => byId.has(id) && !dashboardSet.has(id),
      ),
      ...allNeedingBackfill
        .filter((p) => !dashboardSet.has(p.id) && !invSet.has(p.id))
        .sort(
          (a, b) =>
            b.updatedAt.getTime() - a.updatedAt.getTime(),
        )
        .map((p) => p.id),
    ];

    const products = orderedIds
      .slice(0, limit)
      .map((id) => byId.get(id)!)
      .filter(Boolean);

    let updated = 0;
    let skipped = 0;
    const errors: { asin: string; error: string }[] = [];
    const updatedProducts: Array<{
      id: string;
      asin: string | null;
      title: string | null;
      imageUrl: string | null;
    }> = [];
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
          let skipToNextMarketplace = false;
          for (let attempt = 0; attempt <= 2; attempt++) {
            try {
              res = (await this.spApiClient.getCatalogItem(credentials, asin, [
                marketplaceId,
              ])) as any;
              break;
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              if (
                msg.includes('/catalog/2022-04-01/items/') &&
                msg.includes('(404)') &&
                msg.toLowerCase().includes('not found in marketplace')
              ) {
                skipToNextMarketplace = true;
                break;
              }
              const is429 =
                msg.includes('429') ||
                msg.includes('QuotaExceeded') ||
                msg.toLowerCase().includes('quota exceeded');
              if (is429 && attempt < 2) {
                const waitMs = attempt === 0 ? 3000 : 6000;
                this.logger.warn(
                  `[backfillProductTitles] Catalog 429 for ASIN ${asin}; waiting ${waitMs / 1000}s before retry`,
                );
                await new Promise((r) => setTimeout(r, waitMs));
                continue;
              }
              throw e;
            }
          }
          if (skipToNextMarketplace) continue;
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

          const done = !!(title && imageUrl);
          await new Promise((r) => setTimeout(r, catalogThrottleMs));
          if (done) break;
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
        updatedProducts.push({
          id: p.id,
          asin: p.asin,
          title: title ?? p.title,
          imageUrl: imageUrl ?? p.imageUrl,
        });
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
      updatedProducts,
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
   * Dev-only: call Catalog API and return raw response + parsed productType and displayGroup.
   */
  async devGetCatalogItemCategoryDebug(
    orgId: string,
    preferredUserId: string,
    asin: string,
  ): Promise<{
    asin: string;
    marketplaceIdsUsed: string[];
    rawPayload: any;
    fullResponse: any;
    parsedProductType: string | null;
    parsedDisplayGroup: string | null;
    error?: string;
  }> {
    const credentials = await this.getAmazonCredentialsForOrg(
      orgId,
      preferredUserId,
    );
    const region = credentials.region ?? 'eu';
    const marketplaceIds =
      region === 'eu'
        ? ['A1F83G8C2ARO7P']
        : region === 'fe'
          ? ['A1VC38T7YXB528']
          : ['ATVPDKIKX0DER'];
    const includedData =
      'summaries,attributes,images,classifications,productTypes,salesRanks';
    try {
      const res = (await this.spApiClient.getCatalogItem(
        credentials,
        asin,
        marketplaceIds,
        includedData,
      )) as any;
      const payload =
        res?.payload ??
        res?.Payload ??
        res?.item ??
        res?.Item ??
        res?.data ??
        res ??
        {};
      const { productType: parsedProductType, displayGroup: parsedDisplayGroup } =
        this.parseProductTypeAndDisplayGroupFromPayload(payload);
      return {
        asin,
        marketplaceIdsUsed: marketplaceIds,
        rawPayload: payload,
        fullResponse: res,
        parsedProductType,
        parsedDisplayGroup,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return {
        asin,
        marketplaceIdsUsed: marketplaceIds,
        rawPayload: null,
        fullResponse: null,
        parsedProductType: null,
        parsedDisplayGroup: null,
        error,
      };
    }
  }

  /**
   * Parse productType and displayGroup from Catalog Items API response.
   * - productType: from productTypes[].productType (ItemProductTypeByMarketplace has no displayGroup).
   * - displayGroup: from summaries[].websiteDisplayGroupName (or websiteDisplayGroup), or salesRanks[].displayGroupRanks[].websiteDisplayGroup.
   */
  private parseProductTypeAndDisplayGroupFromPayload(payload: any): {
    productType: string | null;
    displayGroup: string | null;
  } {
    const out = { productType: null as string | null, displayGroup: null as string | null };
    if (!payload || typeof payload !== 'object') return out;

    // 1) productType from productTypes array (ItemProductTypeByMarketplace), or summaries[].itemClassification
    const productTypes =
      payload.productTypes ?? payload.ProductTypes ?? payload.product_type ?? null;
    if (Array.isArray(productTypes) && productTypes.length > 0) {
      const first = productTypes[0];
      if (first && typeof first === 'object') {
        const pt =
          first.productType ?? first.product_type ?? first.value ?? null;
        if (typeof pt === 'string' && pt.trim()) out.productType = pt.trim();
      } else if (typeof first === 'string' && first.trim()) {
        out.productType = first.trim();
      }
    }
    if (!out.productType) {
      const summaries = payload.summaries ?? payload.Summaries ?? null;
      if (Array.isArray(summaries) && summaries.length > 0) {
        const s = summaries[0];
        const pt =
          s?.itemClassification ?? s?.item_classification ?? s?.productType ?? s?.product_type ?? null;
        if (typeof pt === 'string' && pt.trim()) out.productType = pt.trim();
      }
    }

    // 2) displayGroup: from summaries (websiteDisplayGroupName), salesRanks (displayGroupRanks), or classifications (browse node)
    const summaries = payload.summaries ?? payload.Summaries ?? null;
    if (Array.isArray(summaries) && summaries.length > 0) {
      const s = summaries[0];
      const name =
        s?.websiteDisplayGroupName ??
        s?.website_display_group_name ??
        s?.websiteDisplayGroup ??
        s?.website_display_group ??
        null;
      if (typeof name === 'string' && name.trim()) {
        out.displayGroup = name.trim();
        return out;
      }
      // Fallback: browseClassification.displayName (category path)
      const browse = s?.browseClassification ?? s?.browse_classification ?? null;
      if (browse && typeof browse === 'object') {
        const dn = browse.displayName ?? browse.display_name ?? browse.DisplayName ?? null;
        if (typeof dn === 'string' && dn.trim()) out.displayGroup = dn.trim();
        if (out.displayGroup) return out;
      }
    }
    const salesRanks = payload.salesRanks ?? payload.SalesRanks ?? null;
    if (Array.isArray(salesRanks) && salesRanks.length > 0) {
      const byMp = salesRanks[0];
      const displayGroupRanks =
        byMp?.displayGroupRanks ??
        byMp?.display_group_ranks ??
        byMp?.DisplayGroupRanks ??
        [];
      if (Array.isArray(displayGroupRanks) && displayGroupRanks.length > 0) {
        const first = displayGroupRanks[0];
        const name =
          first?.websiteDisplayGroup ??
          first?.website_display_group ??
          null;
        if (typeof name === 'string' && name.trim()) out.displayGroup = name.trim();
      }
    }
    // Fallback: top-level classifications (browse path)
    const classifications = payload.classifications ?? payload.Classifications ?? null;
    if (!out.displayGroup && Array.isArray(classifications) && classifications.length > 0) {
      const list = classifications[0]?.classifications ?? classifications[0]?.Classifications ?? [];
      const first = Array.isArray(list) ? list[0] : null;
      if (first) {
        const dn = first.displayName ?? first.display_name ?? first.DisplayName ?? null;
        if (typeof dn === 'string' && dn.trim()) out.displayGroup = dn.trim();
      }
    }
    return out;
  }

  /**
   * Call Catalog API for one ASIN, parse productType and displayGroup, save when present.
   * For EU: try UK first, then DE then FR if 404 so more rows get data. Never throws.
   */
  async fetchAndStoreCatalogCategoryForAsin(
    orgId: string,
    preferredUserId: string,
    asin: string,
  ): Promise<{ productType: string | null; displayGroup: string | null; updated: number }> {
    const out = { productType: null as string | null, displayGroup: null as string | null, updated: 0 };
    const userIds = await this.getOrgMemberUserIds(orgId);
    if (userIds.length === 0) return out;

    let credentials: any;
    try {
      credentials = await this.getAmazonCredentialsForOrg(orgId, preferredUserId);
    } catch {
      return out;
    }
    const region = credentials.region ?? 'eu';
    const includedData = 'summaries,attributes,images,classifications,productTypes,salesRanks';
    const euMarketplaces = ['A1F83G8C2ARO7P', 'A1PA6795UKMFR9', 'A13V1IB3VIYZZH'];
    const marketplaceIds =
      region === 'eu'
        ? euMarketplaces
        : region === 'fe'
          ? ['A1VC38T7YXB528']
          : ['ATVPDKIKX0DER'];

    let productType: string | null = null;
    let displayGroup: string | null = null;
    for (const marketplaceId of marketplaceIds) {
      let gotResponse = false;
      for (let attempt = 0; attempt <= 2 && !gotResponse; attempt++) {
        try {
          const res = (await this.spApiClient.getCatalogItem(
            credentials,
            asin,
            [marketplaceId],
            includedData,
          )) as any;
          const payload =
            res?.payload ?? res?.Payload ?? res?.item ?? res?.Item ?? res?.data ?? res ?? {};
          const parsed = this.parseProductTypeAndDisplayGroupFromPayload(payload);
          productType = parsed.productType;
          displayGroup = parsed.displayGroup;
          gotResponse = true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const is404 = msg.includes('404') || msg.includes('NOT_FOUND');
          const is429 =
            msg.includes('429') ||
            msg.includes('QuotaExceeded') ||
            msg.toLowerCase().includes('quota exceeded') ||
            msg.toLowerCase().includes('throttl');
          if (is429 && attempt < 2) {
            const waitMs = attempt === 0 ? 3000 : 6000;
            this.logger.warn(
              `[fetchAndStoreCatalogCategoryForAsin] Catalog 429 for ASIN ${asin}; waiting ${waitMs / 1000}s before retry`,
            );
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          if (is404) {
            gotResponse = true;
            break;
          }
          await this.markCatalogCheckedNoData(userIds, asin);
          return out;
        }
      }
      if (productType?.trim() || displayGroup?.trim()) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    const data: { productType?: string; displayGroup?: string } = {};
    if (productType != null && productType.trim() !== '') data.productType = productType;
    if (displayGroup != null && displayGroup.trim() !== '') data.displayGroup = displayGroup;
    if (Object.keys(data).length === 0) {
      await this.markCatalogCheckedNoData(userIds, asin);
      return out;
    }

    try {
      const result = await (this.prisma as any).product.updateMany({
        where: {
          userId: { in: userIds },
          asin,
          OR: [
            { productType: null },
            { productType: '' },
            { displayGroup: null },
            { displayGroup: '' },
          ],
        },
        data,
      });
      return { productType, displayGroup, updated: result.count };
    } catch {
      return out;
    }
  }

  /** Mark products as catalog-checked with no data (set null → '') so they leave the backfill set and we don't retry. */
  private async markCatalogCheckedNoData(userIds: string[], asin: string): Promise<void> {
    try {
      await (this.prisma as any).product.updateMany({
        where: { userId: { in: userIds }, asin, productType: null },
        data: { productType: '' },
      });
      await (this.prisma as any).product.updateMany({
        where: { userId: { in: userIds }, asin, displayGroup: null },
        data: { displayGroup: '' },
      });
    } catch {
      // ignore
    }
  }

  /**
   * Backfill Product.productType and Product.displayGroup for ASINs missing either field.
   * Catalog API is getCatalogItem(asin) — one request per ASIN; there is no nextToken. We "paginate" by querying the DB in batches and looping until no products need backfill.
   * When no asinList: paginates in batches of at least 50 (or limit) until no products need backfill (no per-run cap).
   * @param asinList - if provided, process all these ASINs; otherwise paginate through all org products that need it
   * @param limit - when no asinList, batch size per DB query (min 50); we keep requesting next batch until none left
   */
  async backfillCatalogCategoriesForNewAsins(
    orgId: string,
    preferredUserId: string,
    asinList?: string[],
    limit = 250,
  ): Promise<{
    requested: number;
    processed: number;
    updated: number;
    noDataCount: number;
    noDataSample: string[];
    errors: Array<{ asin: string; error: string }>;
    hint?: string;
  }> {
    const userIds = await this.getOrgMemberUserIds(orgId);
    if (userIds.length === 0) {
      return { requested: 0, processed: 0, updated: 0, noDataCount: 0, noDataSample: [], errors: [] };
    }
    // Only products that have never been checked: productType or displayGroup is null. Once we set a value or '', do not re-select (avoids re-processing same rows and stopping early).
    const needsBackfill = {
      userId: { in: userIds },
      asin: { not: null },
      OR: [{ productType: null }, { displayGroup: null }],
    };
    // Catalog API is getCatalogItem(asin) — one request per ASIN, no nextToken. We paginate by querying DB in batches.
    const batchSize = Math.max(50, limit);
    let totalRequested = 0;
    let totalProcessed = 0;
    let totalUpdated = 0;
    let noDataCount = 0;
    const noDataSample: string[] = [];
    const errors: Array<{ asin: string; error: string }> = [];
    let batchNumber = 0;

    // 1) If we have an ASIN list (e.g. from inventory sync), process all of them (no per-page cap)
    if (asinList && asinList.length > 0) {
      const asinsToFetch = [...new Set(asinList.filter((a): a is string => typeof a === 'string' && a.trim() !== ''))];
      totalRequested += asinsToFetch.length;
      this.logger.log(
        `[catalog backfill] Processing asinList: ${asinsToFetch.length} ASINs (no pagination; Catalog API is 1 request per ASIN)`,
      );
      for (const asin of asinsToFetch) {
        const result = await this.fetchAndStoreCatalogCategoryForAsin(orgId, preferredUserId, asin);
        totalProcessed += 1;
        totalUpdated += result.updated;
        if (result.updated === 0) {
          noDataCount += 1;
          if (noDataSample.length < 5) noDataSample.push(asin);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // 2) Fallback: paginate through all products needing backfill (batch = batchSize; loop until none left, like nextToken)
    while (true) {
      const products = await (this.prisma as any).product.findMany({
        where: needsBackfill,
        select: { asin: true },
        distinct: ['asin'],
        orderBy: { updatedAt: 'asc' },
        take: batchSize,
      });
      const asinsToFetch = (products as Array<{ asin: string | null }>)
        .map((p) => p.asin)
        .filter((a): a is string => a != null && a.trim() !== '');
      if (asinsToFetch.length === 0) break;
      batchNumber += 1;
      totalRequested += asinsToFetch.length;
      this.logger.log(
        `[catalog backfill] Batch ${batchNumber}: ${asinsToFetch.length} ASINs (total requested this run: ${totalRequested})`,
      );
      for (const asin of asinsToFetch) {
        const result = await this.fetchAndStoreCatalogCategoryForAsin(orgId, preferredUserId, asin);
        totalProcessed += 1;
        totalUpdated += result.updated;
        if (result.updated === 0) {
          noDataCount += 1;
          if (noDataSample.length < 5) noDataSample.push(asin);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    let hint: string | undefined;
    if (totalRequested > 0 && totalUpdated === 0 && errors.length === 0) {
      hint = 'Catalog API returned no productType/displayGroup for these ASINs, or run: npx prisma migrate deploy.';
    } else if (noDataCount > 0) {
      hint = `${noDataCount} ASIN(s) had no productType/displayGroup in Catalog API (e.g. not in UK catalog or empty response). Sample: ${noDataSample.slice(0, 5).join(', ') || '—'}. Use "Debug catalog category" to inspect.`;
    }

    return {
      requested: totalRequested,
      processed: totalProcessed,
      updated: totalUpdated,
      noDataCount,
      noDataSample,
      errors,
      hint,
    };
  }

  /**
   * Example method that calls the SP-API client (sandbox for now).
   * This uses the Sellers API "getMarketplaceParticipations" shape.
   */
  async getSandboxMarketplaceParticipations(userId: string) {
    const credentials = await this.getAmazonCredentialsForUser(userId);
    return this.spApiClient.getMarketplaceParticipations(credentials);
  }

  async getMarketplaceParticipationsForUser(userId: string) {
    const credentials = await this.getAmazonCredentialsForUser(userId);
    const participations = (await this.spApiClient.getMarketplaceParticipations(
      credentials,
    )) as any;
    return {
      region: credentials.region ?? 'eu',
      participations,
    };
  }

  async getOrderCountLast24HoursForMarketplace(
    userId: string,
    marketplaceId: string,
  ): Promise<number> {
    const credentials = await this.getAmazonCredentialsForUser(userId);
    const lastUpdatedAfter = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const response = (await this.spApiClient.getOrders(credentials, {
      lastUpdatedAfter,
      marketplaceIds: [marketplaceId],
      orderStatuses: ['Pending', 'Unshipped', 'PartiallyShipped', 'Shipped', 'InvoiceUnconfirmed'],
    })) as any;
    const payload = response?.payload ?? response;
    const orders = Array.isArray(payload?.Orders)
      ? payload.Orders
      : Array.isArray(payload?.orders)
        ? payload.orders
        : [];
    return orders.length;
  }

  // ----------------------------
  // Purchases / inbound costs
  // ----------------------------

  async listPurchases(
    orgId: string,
    opts?: { query?: string; take?: number; skip?: number },
    marketplaceId?: string,
  ) {
    const userIds = await this.getOrgMemberUserIds(orgId);
    const q = (opts?.query ?? '').trim();
    const take = opts?.take ?? 50;
    const skip = opts?.skip ?? 0;

    const where: any = {
      userId: { in: userIds },
    };

    if (q) {
      // Two-step: find product IDs matching search, then filter purchases (avoids Prisma relation filter quirks)
      const matchingProducts = await (this.prisma as any).product.findMany({
        where: {
          userId: { in: userIds },
          OR: [
            { sku: { contains: q, mode: 'insensitive' } },
            { asin: { contains: q, mode: 'insensitive' } },
            { title: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      const matchingProductIds = (matchingProducts as Array<{ id: string }>).map((p) => p.id);

      where.OR = [
        { productId: { in: matchingProductIds } },
        { shipmentId: { contains: q, mode: 'insensitive' } },
        { supplier: { contains: q, mode: 'insensitive' } },
        { supplierLink: { contains: q, mode: 'insensitive' } },
        { orderNumber: { contains: q, mode: 'insensitive' } },
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

  /**
   * List inventory SKUs that have no cost entries in the DB (no Purchase rows and no/zero Product.costOfGoods).
   * Used for the "Missing" tab so users can add COGS; once they save, the SKU moves to All/Complete.
   */
  async listMissingCostOfGoods(
    orgId: string,
    opts?: { start?: string; end?: string; take?: number; skip?: number },
    marketplaceId?: string,
  ) {
    const userIds = await this.getOrgMemberUserIds(orgId);
    const take = Math.max(1, Math.min(100, opts?.take ?? 10));
    const skip = Math.max(0, opts?.skip ?? 0);

    // All inventory productIds for this org
    const invRows = await this.prisma.inventory.findMany({
      where: { userId: { in: userIds } },
      select: { productId: true },
    });
    const inventoryProductIds = [...new Set(invRows.map((r) => r.productId))];
    if (inventoryProductIds.length === 0) {
      return { missingSkusCount: 0, items: [] };
    }

    // ProductIds that have at least one Purchase (cost entry) in the org
    const purchasedDistinct = await (this.prisma as any).purchase.groupBy({
      by: ['productId'],
      where: { userId: { in: userIds }, productId: { in: inventoryProductIds } },
    });
    const hasPurchaseIds = new Set(
      Array.isArray(purchasedDistinct)
        ? purchasedDistinct.map((r: any) => r.productId).filter(Boolean)
        : [],
    );

    // ProductIds where Product has costOfGoods set (non-null, > 0)
    const toNum = (value: unknown): number => {
      if (value == null) return 0;
      if (typeof value === 'number') return value;
      if (typeof value === 'string') return Number(value);
      if (typeof value === 'bigint') return Number(value);
      if (typeof value === 'object') {
        const anyVal = value as any;
        if (typeof anyVal.toNumber === 'function') return anyVal.toNumber();
        if (typeof anyVal.toString === 'function') return Number(anyVal.toString());
      }
      return Number(value as any);
    };
    const productsWithCogs = await this.prisma.product.findMany({
      where: {
        userId: { in: userIds },
        id: { in: inventoryProductIds },
        costOfGoods: { not: null },
      },
      select: { id: true, costOfGoods: true },
    });
    const hasCogsIds = new Set(
      productsWithCogs
        .filter((p) => toNum(p.costOfGoods) > 0)
        .map((p) => p.id),
    );

    // Missing = in inventory but no Purchase and no/zero costOfGoods
    const missingIds = inventoryProductIds.filter(
      (id) => !hasPurchaseIds.has(id) && !hasCogsIds.has(id),
    );
    const sortedMissingIds = await this.sortProductIdsByStockAndRevenue(userIds, missingIds);

    const missingSkusCount = sortedMissingIds.length;
    const pageIds = sortedMissingIds.slice(skip, skip + take);
    if (pageIds.length === 0) {
      return { missingSkusCount, items: [] };
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: pageIds } },
      select: { id: true, sku: true, asin: true, title: true, imageUrl: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    const items = pageIds.map((id) => {
      const p = byId.get(id);
      if (p) {
        return {
          productId: p.id,
          sku: p.sku,
          asin: p.asin,
          title: p.title,
          imageUrl: p.imageUrl,
          revenue: 0,
          units: 0,
        };
      }
      return {
        productId: id,
        sku: id,
        asin: null as string | null,
        title: null as string | null,
        imageUrl: null as string | null,
        revenue: 0,
        units: 0,
      };
    });

    return { missingSkusCount, items };
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

  /**
   * Disconnect (unlink) the Amazon seller account for the user.
   * Deletes the SellerAccount row so they can reconnect with new permissions.
   */
  async disconnectAmazon(userId: string): Promise<{ ok: boolean }> {
    await this.prisma.sellerAccount.deleteMany({
      where: { userId, marketplace: 'amazon' },
    });
    return { ok: true };
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
   * The user and optional returnOrigin are encoded into the state payload so we can
   * resolve them on callback and redirect the user back to the frontend they started from.
   */
  async getAmazonConnectUrl(
    userId: string,
    regionCode: string,
    returnOrigin?: string,
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
      ...(returnOrigin && { returnOrigin }),
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
   * Returns the origin to redirect the user to after OAuth.
   * If returnOrigin was passed when starting the flow (e.g. from localhost), and it is
   * allowed, use it so the user lands back where they started. Otherwise use defaultFrontendUrl.
   * Note: The callback and sync run on whichever backend received the callback (e.g. production).
   * To run sync locally, point AMAZON_REDIRECT_URI to your local backend (e.g. via ngrok).
   */
  getRedirectOriginAfterOAuth(
    returnOrigin: string | undefined,
    defaultFrontendUrl: string,
  ): string {
    if (!returnOrigin || typeof returnOrigin !== 'string') {
      return defaultFrontendUrl;
    }
    const origin = returnOrigin.trim().replace(/\/$/, '');
    if (!origin) return defaultFrontendUrl;
    try {
      const u = new URL(origin);
      const host = u.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1') {
        return origin;
      }
      const defaultUrl = new URL(defaultFrontendUrl.replace(/\/$/, '') || 'http://localhost:3000');
      if (host === defaultUrl.hostname.toLowerCase()) {
        return origin;
      }
    } catch {
      /* ignore invalid URL */
    }
    return defaultFrontendUrl;
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
