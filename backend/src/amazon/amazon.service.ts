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
import { withPrismaTransientRetry } from '../prisma/database-transient-retry.util';
import { LinkAmazonAccountDto } from './dto/link-amazon-account.dto';
import { UsersService } from '../users/users.service';
import {
  amountExVatFromIncl,
  amountInclVatFromEx,
  vatAmountFromIncl,
  vatAmountFromEx,
} from '../common/vat.util';
import { Prisma } from '@prisma/client';
import { MARKETPLACE_MAP } from '../marketplace/marketplace.constants';
import { resolveDashboardRangeUtc } from '../marketplace/marketplace-timezone';
import { AMAZON_EXTENDED_ORDER_HISTORY_EMAIL } from './amazon-extended-sync.constants';
import {
  parseFinancesShipmentItemFeesBreakdown,
  parseFinancesShipmentItemFeesSignedTotal,
} from './finances-item-fee-parse.util';
import { eligibilityFromListingsRestrictionsBody } from './asin-selling-eligibility.util';

/** When we have no settled fees and no product fee estimate, use this share of revenue as fee so profit/ROI are not overstated. */
const DEFAULT_AMAZON_FEE_RATE_WHEN_UNKNOWN = 0.35;

/**
 * Stored on Order / OrderItem. Do not use SP-API `Order.MarketplaceId` here — that ID is not the same
 * as the literal `"amazon"` used across queries/backfill, so mixing them breaks
 * @@unique([userId, orderId, marketplace]) and creates duplicate order rows for one Amazon order.
 */
const ORDER_MARKETPLACE_CANONICAL = 'amazon';

/** Listings Restrictions checks: UK marketplace only, one row per distinct product ASIN. */
const AMAZON_UK_MARKETPLACE_ID_FOR_LISTINGS_RESTRICTIONS = 'A1F83G8C2ARO7P';

/** Parent `orders.amazon_order_status` values we exclude from Prisma aggregates (exact SP-API spellings + variants). */
const PRISMA_EXCLUDED_AMAZON_ORDER_STATUSES: string[] = [
  'Canceled',
  'Cancelled',
  'Unfulfillable',
  'Returned',
  'Refunded',
  'PendingReturn',
];

type OrderSalesExclusionKind = 'cancelled' | 'returned' | 'unfulfillable';

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

  /**
   * User ids to use for **Amazon-synced** tables (`orders`, `order_items`, products used with those orders, etc.).
   * When several org members link the same Seller Central account (`seller_accounts.seller_id`), each sync
   * duplicates all orders; `userId: { in: allMembers }` multiplies revenue and fees. One canonical user
   * per distinct seller id (latest `ordersLastSyncedAt` / `updatedAt` wins).
   *
   * Do **not** use this for org-wide manual data (e.g. `purchases`) — those stay on {@link getOrgMemberUserIds}.
   */
  private async getOrgAmazonAggregateUserIds(orgId: string): Promise<string[]> {
    const members = await this.usersService.getOrgMemberUserIds(orgId);
    if (members.length <= 1) return members;

    try {
      const accounts = await this.prisma.sellerAccount.findMany({
        where: {
          userId: { in: members },
          marketplace: 'amazon',
          isActive: true,
        },
        select: {
          userId: true,
          sellerId: true,
          ordersLastSyncedAt: true,
          updatedAt: true,
        },
      });
      const accountByUser = new Map(
        accounts.map((a) => [a.userId, a] as const),
      );

      const groups = new Map<string, string[]>();
      for (const uid of members) {
        const acc = accountByUser.get(uid);
        const sidRaw = acc?.sellerId != null ? String(acc.sellerId).trim() : '';
        const sid = sidRaw ? sidRaw.toUpperCase() : '';
        const key = sid || `__user_${uid}`;
        const arr = groups.get(key) ?? [];
        arr.push(uid);
        groups.set(key, arr);
      }

      const out: string[] = [];
      for (const [key, uids] of groups) {
        if (uids.length === 1) {
          out.push(uids[0]!);
          continue;
        }
        let best = uids[0]!;
        let bestTs = -1;
        for (const uid of uids) {
          const acc = accountByUser.get(uid);
          const t1 =
            acc?.ordersLastSyncedAt instanceof Date
              ? acc.ordersLastSyncedAt.getTime()
              : 0;
          const t2 =
            acc?.updatedAt instanceof Date ? acc.updatedAt.getTime() : 0;
          const ts = Math.max(t1, t2);
          if (ts > bestTs || (ts === bestTs && uid < best)) {
            bestTs = ts;
            best = uid;
          }
        }
        out.push(best);
        const sellerLabel = key.startsWith('__user_') ? 'unset seller id' : key;
        this.logger.warn(
          `[orgAggregates] orgId=${orgId} ${uids.length} users share Amazon seller ${sellerLabel}; using canonical userId=${best} for order/fee aggregates (duplicate seller links).`,
        );
      }
      return [...new Set(out)];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[orgAggregates] seller de-dupe failed for orgId=${orgId}: ${msg}; falling back to all member user ids.`,
      );
      return members;
    }
  }

  /**
   * User ids whose historical `orders` / `order_items` rows should be **read** together for org dashboards.
   * When several org members linked the **same** Amazon `seller_id`, {@link getOrgAmazonAggregateUserIds} keeps
   * only one “canonical” writer for sync (avoids double-counting live SP-API pulls). Your DB can still contain
   * months of rows under **another** member’s `user_id` from a laptop sync — include every such user here so
   * Orders / P&L / charts see them; duplicate Amazon lines are merged via {@link dedupeOrderItemsByOrderLine}.
   * Prefer {@link getOrgAmazonAggregateUserIds} for sync/repair paths that must not fan out to duplicate sellers.
   */
  private async getOrgAmazonOrderReadUserIds(orgId: string): Promise<string[]> {
    const members = await this.getOrgMemberUserIds(orgId);
    if (members.length === 0) return [];
    if (members.length === 1) return members;

    const accounts = await this.prisma.sellerAccount.findMany({
      where: {
        userId: { in: members },
        marketplace: 'amazon',
        isActive: true,
      },
      select: { userId: true, sellerId: true },
    });
    const bySid = new Map<string, string[]>();
    const noSidUserIds = new Set<string>();
    for (const a of accounts) {
      const sid = a.sellerId != null ? String(a.sellerId).trim().toUpperCase() : '';
      if (!sid) {
        noSidUserIds.add(a.userId);
        continue;
      }
      const arr = bySid.get(sid) ?? [];
      arr.push(a.userId);
      bySid.set(sid, arr);
    }
    const out = new Set<string>();
    for (const uids of bySid.values()) {
      for (const u of [...new Set(uids)]) out.add(u);
    }
    for (const u of noSidUserIds) out.add(u);
    for (const m of members) {
      if (!out.has(m)) out.add(m);
    }
    return [...out];
  }

  /**
   * Dev: explain which user ids are used for Amazon order reads vs sync canonicalization (same-org mystery data).
   */
  async getOrgAmazonOrdersScopeDiagnostics(orgId: string): Promise<{
    orgId: string;
    memberUserIds: string[];
    memberEmails: Array<{ userId: string; email: string }>;
    sellerAccounts: Array<{
      userId: string;
      sellerId: string | null;
      ordersLastSyncedAt: string | null;
    }>;
    canonicalAggregateUserIds: string[];
    orderReadUserIds: string[];
    orderRowCountsByUserId: Array<{ userId: string; orders: number; orderItems: number }>;
  }> {
    const memberUserIds = await this.getOrgMemberUserIds(orgId);
    const users = await this.prisma.user.findMany({
      where: { id: { in: memberUserIds } },
      select: { id: true, email: true },
    });
    const memberEmails = users.map((u) => ({
      userId: u.id,
      email: String(u.email ?? ''),
    }));
    const accounts = await this.prisma.sellerAccount.findMany({
      where: {
        userId: { in: memberUserIds },
        marketplace: 'amazon',
        isActive: true,
      },
      select: {
        userId: true,
        sellerId: true,
        ordersLastSyncedAt: true,
      },
    });
    const sellerAccounts = accounts.map((a) => ({
      userId: a.userId,
      sellerId: a.sellerId != null ? String(a.sellerId) : null,
      ordersLastSyncedAt:
        a.ordersLastSyncedAt instanceof Date
          ? a.ordersLastSyncedAt.toISOString()
          : a.ordersLastSyncedAt != null
            ? String(a.ordersLastSyncedAt)
            : null,
    }));
    const canonicalAggregateUserIds = await this.getOrgAmazonAggregateUserIds(orgId);
    const orderReadUserIds = await this.getOrgAmazonOrderReadUserIds(orgId);

    const orderRowCountsByUserId: Array<{
      userId: string;
      orders: number;
      orderItems: number;
    }> = [];
    for (const uid of memberUserIds) {
      const [orders, orderItems] = await Promise.all([
        this.prisma.order.count({ where: { userId: uid } }),
        (this.prisma as any).orderItem.count({ where: { userId: uid } }),
      ]);
      if (orders > 0 || orderItems > 0) {
        orderRowCountsByUserId.push({ userId: uid, orders, orderItems });
      }
    }

    return {
      orgId,
      memberUserIds,
      memberEmails,
      sellerAccounts,
      canonicalAggregateUserIds,
      orderReadUserIds,
      orderRowCountsByUserId,
    };
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
   * Cancelled / returned / unfulfillable Amazon orders must not count toward revenue; still listed in UI with zero sale.
   */
  private getOrderSalesExclusionKind(
    amazonOrderStatus: string | null | undefined,
    rawOrder?: unknown,
  ): OrderSalesExclusionKind | null {
    const raw =
      rawOrder && typeof rawOrder === 'object'
        ? (rawOrder as Record<string, unknown>)
        : null;
    const fromApi =
      typeof amazonOrderStatus === 'string' && amazonOrderStatus.trim()
        ? amazonOrderStatus.trim()
        : typeof raw?.OrderStatus === 'string'
          ? String(raw.OrderStatus).trim()
          : typeof raw?.orderStatus === 'string'
            ? String(raw.orderStatus).trim()
            : '';
    if (!fromApi) return null;
    const n = fromApi.toLowerCase();
    if (n === 'unfulfillable') return 'unfulfillable';
    if (n === 'canceled' || n === 'cancelled') return 'cancelled';
    if (n === 'pendingreturn') return 'returned';
    if (n.includes('refund')) return 'returned';
    if (n.includes('return')) return 'returned';
    return null;
  }

  /**
   * When `revenueTotal` is stored as **0**, only reconstruct a positive sale from order splits / list price
   * if the parent order still looks **unfulfilled** (pending*, unshipped, etc.). For **Shipped** and similar,
   * a zero line total usually means the sale was cleared after a refund — do not inflate back to a full sale
   * (avoids overstating revenue and unit counts vs tools like STK).
   */
  private orderParentStatusAllowsReconstructedRevenueForZeroStoredLine(
    amazonOrderStatus: string | null | undefined,
    rawOrder?: unknown,
  ): boolean {
    const fromCol =
      typeof amazonOrderStatus === 'string' && amazonOrderStatus.trim()
        ? amazonOrderStatus.trim()
        : '';
    const raw =
      rawOrder && typeof rawOrder === 'object'
        ? (rawOrder as Record<string, unknown>)
        : null;
    const fromRaw =
      typeof raw?.OrderStatus === 'string'
        ? String(raw.OrderStatus).trim()
        : typeof raw?.orderStatus === 'string'
          ? String(raw.orderStatus).trim()
          : '';
    const s = (fromCol || fromRaw).toLowerCase();
    if (!s) return true;
    if (s.includes('pending')) return true;
    if (s === 'unshipped') return true;
    if (s.includes('partiallyshipped')) return true;
    if (s === 'invoiceunconfirmed') return true;
    return false;
  }

  private orderSalesExclusionDisplayLabel(
    kind: OrderSalesExclusionKind,
  ): 'Cancelled' | 'Returned' | 'Unfulfillable' {
    if (kind === 'returned') return 'Returned';
    if (kind === 'unfulfillable') return 'Unfulfillable';
    return 'Cancelled';
  }

  /**
   * Seller Central counts Amazon orders (parents), not line items. Union parent `orders` in range with
   * line-derived ids so pending orders without synced items still count.
   */
  /**
   * Include a line if either `order_items.order_date` or parent `orders.order_date` is in range.
   * Seller Central ties sales to the order (purchase) date; line dates can drift after backfills/updates.
   */
  private whereOrderItemInUtcDashboardRange(safeStart: Date, safeEnd: Date) {
    return {
      OR: [
        { orderDate: { gte: safeStart, lte: safeEnd } },
        {
          order: {
            orderDate: { gte: safeStart, lte: safeEnd },
          },
        },
      ],
    };
  }

  private countDistinctAmazonOrdersForSummary(
    parentOrdersInRange: Array<{ id: string; orderId: string }>,
    orderItems: Array<{ orderDbId?: unknown; orderId?: string }>,
    exclusionByOrderDbId: Map<string, OrderSalesExclusionKind>,
  ): number {
    const seen = new Set<string>();
    for (const o of parentOrdersInRange) {
      if (exclusionByOrderDbId.get(o.id) === 'cancelled') continue;
      const aid = String(o.orderId ?? '').trim();
      if (aid) seen.add(aid);
    }
    for (const it of orderItems) {
      const dbId = String((it as { orderDbId?: unknown }).orderDbId ?? '').trim();
      if (dbId && exclusionByOrderDbId.get(dbId) === 'cancelled') continue;
      const aid = String((it as { orderId?: string }).orderId ?? '').trim();
      if (aid) seen.add(aid);
    }
    return seen.size;
  }

  private async buildOrderSalesExclusionMap(
    orderDbIds: string[],
  ): Promise<Map<string, OrderSalesExclusionKind>> {
    const out = new Map<string, OrderSalesExclusionKind>();
    const ids = [...new Set(orderDbIds.map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) return out;
    try {
      const rows = await this.prisma.order.findMany({
        where: { id: { in: ids } },
        select: { id: true, amazonOrderStatus: true, rawResponse: true },
      });
      for (const row of rows) {
        const kind = this.getOrderSalesExclusionKind(
          row.amazonOrderStatus,
          row.rawResponse,
        );
        if (kind) out.set(String(row.id), kind);
      }
    } catch {
      // non-fatal
    }
    return out;
  }

  /** Normalize Amazon order id so the same order synced under different rows still dedupes. */
  private normalizeAmazonOrderIdForDedupe(raw: unknown): string {
    return String(raw ?? '')
      .trim()
      .replace(/\s+/g, '')
      .toUpperCase();
  }

  private effectiveOrderItemIdForDedupe(it: {
    orderItemId?: string | null;
    rawResponse?: unknown;
  }): string {
    const direct = String(it.orderItemId ?? '').trim();
    if (direct) return direct;
    const raw = it.rawResponse;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const ro = raw as Record<string, unknown>;
      const v = ro.OrderItemId ?? ro.orderItemId;
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  }

  /**
   * Stable key for the same logical Amazon order line across duplicate DB rows
   * (duplicate parent `orders`, or multiple org members each syncing the same seller account).
   */
  private orderLineDedupeKey<
    T extends {
      id: string;
      orderId: string;
      orderItemId?: string | null;
      marketplace?: string | null;
      rawResponse?: unknown;
      sku?: string | null;
      quantity?: unknown;
      revenueTotal?: unknown;
      asin?: string | null;
    },
  >(it: T): string {
    const mk = String(it.marketplace ?? '')
      .trim()
      .toLowerCase();
    const oid = this.normalizeAmazonOrderIdForDedupe(it.orderId);
    const oiid = this.effectiveOrderItemIdForDedupe(it);
    if (oiid) {
      return `${mk}\0${oid}\0${oiid}`;
    }
    const sku = String(it.sku ?? '').trim();
    const asin = String(it.asin ?? '').trim();
    const qty = Math.max(1, Math.round(Number(it.quantity) || 1));
    const revCent = Math.round(Math.abs(this.safeNumOrderMoney(it.revenueTotal)) * 100);
    return `${mk}\0${oid}\0fb:${sku}\0${asin}\0q:${qty}\0r:${revCent}`;
  }

  /**
   * When duplicate `order_items` exist for the same Amazon order line (e.g. duplicate parent `orders` rows),
   * or the same seller synced under multiple org users, keep one row: prefer settled finances, then newest updatedAt.
   */
  private dedupeOrderItemsByOrderLine<
    T extends {
      id: string;
      orderId: string;
      orderItemId?: string | null;
      feesSource?: string | null;
      updatedAt?: Date | string;
      marketplace?: string | null;
      rawResponse?: unknown;
      sku?: string | null;
      quantity?: unknown;
      revenueTotal?: unknown;
      asin?: string | null;
    },
  >(items: T[]): T[] {
    const rank = (it: T) => {
      const fs = String(it.feesSource ?? '');
      const sourceRank =
        fs === 'finances'
          ? 3e15
          : fs === 'estimate_sold'
            ? 2e15
            : fs === 'estimate'
              ? 1e14
              : 0;
      const u =
        it.updatedAt instanceof Date
          ? it.updatedAt.getTime()
          : typeof it.updatedAt === 'string'
            ? new Date(it.updatedAt).getTime()
            : 0;
      return sourceRank + u;
    };
    const sorted = [...items].sort((a, b) => rank(b) - rank(a));
    const seen = new Set<string>();
    return sorted.filter((it) => {
      const key = this.orderLineDedupeKey(it);
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
    items: Array<{
      revenueTotal?: unknown;
      quantity?: unknown;
      sku?: unknown;
      rawResponse?: unknown;
    }>,
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const it of items) {
      const sku = String(it.sku ?? '').trim();
      if (!sku || map.has(sku)) continue;
      let rev = this.safeNumOrderMoney(it.revenueTotal);
      if (rev <= 0 && it.rawResponse != null && typeof it.rawResponse === 'object') {
        rev = this.parseOrderItemLineRevenueFromRaw(it.rawResponse);
      }
      const qty = this.safeNumOrderMoney(it.quantity);
      if (rev > 0 && qty > 0) map.set(sku, rev / qty);
    }
    return map;
  }

  private async loadOrderParentPricesByDbId(
    orderDbIds: string[],
  ): Promise<
    Map<string, { itemPrice: number; quantity: number; orderTotalAmount: number }>
  > {
    const map = new Map<
      string,
      { itemPrice: number; quantity: number; orderTotalAmount: number }
    >();
    const ids = [...new Set(orderDbIds.map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) return map;
    try {
      const rows = await this.prisma.order.findMany({
        where: { id: { in: ids } },
        select: { id: true, itemPrice: true, quantity: true, rawResponse: true },
      });
      for (const row of rows) {
        map.set(String(row.id), {
          itemPrice: this.safeNumOrderMoney(row.itemPrice),
          quantity: this.safeNumOrderMoney(row.quantity),
          orderTotalAmount: this.parseOrderTotalAmountFromOrderJson(row.rawResponse),
        });
      }
    } catch {
      // non-fatal: fall back to raw revenueTotal only
    }
    return map;
  }

  /** Sum of line quantities per parent order (DB truth; avoids wrong splits when a query omits some lines). */
  private async loadOrderItemQtySumByOrderDbIds(
    orderDbIds: string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const ids = [...new Set(orderDbIds.map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) return map;
    try {
      const rows = await (this.prisma as any).orderItem.groupBy({
        by: ['orderDbId'],
        where: { orderDbId: { in: ids } },
        _sum: { quantity: true },
      });
      for (const r of rows) {
        const q = Number(r._sum?.quantity ?? 0);
        map.set(String(r.orderDbId), Number.isFinite(q) && q > 0 ? q : 0);
      }
    } catch {
      // non-fatal
    }
    return map;
  }

  /**
   * Effective line revenue: stored `revenueTotal` when set; else SP-API line `ItemPrice` from `rawResponse`;
   * else split parent `OrderTotal` by line quantity (matches sync `computeLineRevenueTotals`);
   * else parent `itemPrice × line qty`; else SKU average from other lines in the batch.
   */
  private resolveOrderLineRevenueTotal(
    it: {
      revenueTotal?: unknown;
      quantity?: unknown;
      orderDbId?: unknown;
      sku?: unknown;
      rawResponse?: unknown;
    },
    orderPriceByDbId: Map<
      string,
      { itemPrice: number; quantity: number; orderTotalAmount: number }
    >,
    skuUnitPriceFallback: Map<string, number>,
    orderLineQtySumByOrderDbId: Map<string, number>,
  ): number {
    const rawRevenueTotal = this.safeNumOrderMoney(it.revenueTotal);
    const qty = this.safeNumOrderMoney(it.quantity) || 1;
    const orderDbId = it.orderDbId != null ? String(it.orderDbId) : '';
    const orderFallback = orderDbId ? orderPriceByDbId.get(orderDbId) : undefined;
    const skuKey = String(it.sku ?? '').trim();
    if (rawRevenueTotal > 0) return rawRevenueTotal;

    const linePayload = it.rawResponse;
    if (linePayload != null && typeof linePayload === 'object') {
      const lineRev = this.parseOrderItemLineRevenueFromRaw(linePayload);
      if (lineRev > 0) return lineRev;
    }

    const sumLineQty = orderDbId ? orderLineQtySumByOrderDbId.get(orderDbId) ?? 0 : 0;
    const orderTotalAmt = orderFallback?.orderTotalAmount ?? 0;
    if (orderTotalAmt > 0 && sumLineQty > 0 && qty > 0) {
      return Number(((orderTotalAmt * qty) / sumLineQty).toFixed(2));
    }

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

  /**
   * Same reconstruction as {@link resolveOrderLineRevenueTotal}, but if the DB has a **non-zero**
   * `revenueTotal` (including refunds / chargebacks), return that signed value instead of
   * replacing negatives with positive splits.
   */
  private resolveOrderLineRevenueSigned(
    it: {
      revenueTotal?: unknown;
      quantity?: unknown;
      orderDbId?: unknown;
      sku?: unknown;
      rawResponse?: unknown;
    },
    orderPriceByDbId: Map<
      string,
      { itemPrice: number; quantity: number; orderTotalAmount: number }
    >,
    skuUnitPriceFallback: Map<string, number>,
    orderLineQtySumByOrderDbId: Map<string, number>,
    parentOrder?: { amazonOrderStatus?: string | null; rawOrder?: unknown } | null,
  ): number {
    const stored = this.safeNumOrderMoney(it.revenueTotal);
    if (stored !== 0 && Number.isFinite(stored)) return stored;
    if (
      stored === 0 &&
      parentOrder != null &&
      !this.orderParentStatusAllowsReconstructedRevenueForZeroStoredLine(
        parentOrder.amazonOrderStatus,
        parentOrder.rawOrder,
      )
    ) {
      return 0;
    }
    return this.resolveOrderLineRevenueTotal(
      it,
      orderPriceByDbId,
      skuUnitPriceFallback,
      orderLineQtySumByOrderDbId,
    );
  }

  /**
   * SP-API order line includes `FulfillmentChannel`: **AFN** = Amazon fulfilled (FBA), **MFN** = merchant fulfilled (FBM).
   * Not persisted separately; read from `OrderItem.rawResponse` when present.
   */
  private parseOrderLineFulfillmentLabel(raw: unknown): 'FBA' | 'FBM' | null {
    if (raw == null || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const ch = (r.FulfillmentChannel ?? r.fulfillmentChannel) as string | undefined;
    if (typeof ch !== 'string') return null;
    const u = ch.trim().toUpperCase();
    if (u === 'AFN') return 'FBA';
    if (u === 'MFN') return 'FBM';
    return null;
  }

  private canonicalOrderItemMs(it: {
    orderDate?: Date | string;
    order?: { orderDate?: Date | string | null } | null;
  }): number {
    const p = it.order?.orderDate;
    if (p instanceof Date) return p.getTime();
    if (p != null && p !== '') return new Date(p as string | number).getTime();
    const d = it.orderDate instanceof Date ? it.orderDate : new Date(it.orderDate as string);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  /** Nullable money on order lines (Finances components); null when unset. */
  private orderMoneyNullable(v: unknown): number | null {
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : null;
    }
    const o = v as { toNumber?: () => number; toString?: () => string; value?: unknown };
    if (o?.toNumber && typeof o.toNumber === 'function') {
      const n = o.toNumber();
      return Number.isFinite(n) ? n : null;
    }
    if (o?.toString && typeof o.toString === 'function') {
      const n = parseFloat(o.toString());
      return Number.isFinite(n) ? n : null;
    }
    if (o?.value != null) return this.orderMoneyNullable(o.value);
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private normStoredAmazonFeeComponentForOrderLine(n: number | null): number | null {
    if (n == null || !Number.isFinite(n)) return null;
    if (n === 0) return 0;
    return n > 0 ? -Math.abs(n) : n;
  }

  /** Legacy placeholder: equal ref/FBA each half of total with no digital. */
  private isLikelyLegacyEqualReferralFbaSplit(
    ref: number | null,
    fba: number | null,
    digital: number | null,
    settledTotal: number,
  ): boolean {
    if (ref == null || fba == null) return false;
    if (digital != null && digital !== 0) return false;
    const ar = Math.abs(ref);
    const af = Math.abs(fba);
    const at = Math.abs(settledTotal);
    return (
      ar > 0.009 &&
      Math.abs(ar - af) < 0.02 &&
      at > 0.009 &&
      Math.abs(ar + af - at) < 0.07
    );
  }

  private resolveSpApiMarketplaceIdForProductFees(
    credentialsRegion: string | undefined,
    requestMarketplaceId?: string,
  ): string {
    if (requestMarketplaceId && MARKETPLACE_MAP.has(requestMarketplaceId)) {
      return requestMarketplaceId;
    }
    const r = credentialsRegion === 'na' || credentialsRegion === 'fe' ? credentialsRegion : 'eu';
    const d: Record<string, string> = {
      eu: 'A1F83G8C2ARO7P',
      na: 'ATVPDKIKX0DER',
      fe: 'A1VC38T7YXB528',
    };
    return d[r] ?? d.eu;
  }

  /** Scale signed fee components so r+f+d equals `targetTotal` (all typically ≤ 0). */
  private scaleSignedFeeTripToTarget(
    r: number,
    f: number,
    d: number,
    targetTotal: number,
  ): { r: number; f: number; d: number } | null {
    const sumAbs = Math.abs(r) + Math.abs(f) + Math.abs(d);
    if (sumAbs < 1e-6) return null;
    const scale = Math.abs(targetTotal) / sumAbs;
    let rr = Math.round(r * scale * 100) / 100;
    let ff = Math.round(f * scale * 100) / 100;
    let dd = Math.round(d * scale * 100) / 100;
    const sum = rr + ff + dd;
    const diff = Math.round((targetTotal - sum) * 100) / 100;
    if (Math.abs(diff) >= 0.01) {
      if (Math.abs(rr) >= Math.abs(ff) && Math.abs(rr) >= Math.abs(dd)) {
        rr = Math.round((rr + diff) * 100) / 100;
      } else if (Math.abs(ff) >= Math.abs(dd)) {
        ff = Math.round((ff + diff) * 100) / 100;
      } else {
        dd = Math.round((dd + diff) * 100) / 100;
      }
    }
    return { r: rr, f: ff, d: dd };
  }

  private static readonly LIST_ORDERS_MAX_AT_PRICE_FEE_JOBS = 40;

  /** Order-item rows from Product Fees (listing or sold-unit), not Finances settlement. */
  private isPersistedAmazonFeeEstimateSource(s: string | null | undefined): boolean {
    const fs = String(s ?? '');
    return fs === 'estimate' || fs === 'estimate_sold';
  }
  /** Above this fee/revenue on a settled line, re-shape fees using a prior plausible same-ASIN/SKU sale. */
  private static readonly LIST_ORDERS_MAX_FEE_TO_REVENUE_RATIO = 0.5;

  private buildListOrdersFeeShapeReferenceByAsinAndSku(args: {
    items: ReadonlyArray<any>;
    orderPriceByDbId: Map<
      string,
      { itemPrice: number; quantity: number; orderTotalAmount: number }
    >;
    skuUnitPriceFallback: Map<string, number>;
    orderLineQtySumByOrderDbId: Map<string, number>;
    orderSalesExclusionByDbId: Map<string, OrderSalesExclusionKind>;
  }): {
    byAsin: Map<
      string,
      {
        ref: number;
        fba: number;
        dig: number;
        qty: number;
        revenue: number;
        unitPrice: number;
        feeSumMag: number;
      }
    >;
    bySku: Map<
      string,
      {
        ref: number;
        fba: number;
        dig: number;
        qty: number;
        revenue: number;
        unitPrice: number;
        feeSumMag: number;
      }
    >;
  } {
    type Row = {
      ref: number;
      fba: number;
      dig: number;
      qty: number;
      revenue: number;
      unitPrice: number;
      feeSumMag: number;
    };
    const byAsin = new Map<string, Row>();
    const bySku = new Map<string, Row>();
    const sorted = [...args.items].sort(
      (a, b) => this.canonicalOrderItemMs(a as any) - this.canonicalOrderItemMs(b as any),
    );
    const toNum = (v: unknown) => this.orderMoneyNullable(v);
    for (const it of sorted) {
      const orderDbId = it.orderDbId != null ? String(it.orderDbId) : '';
      if (orderDbId && args.orderSalesExclusionByDbId.get(orderDbId)) continue;
      if (String(it.feesSource ?? '') !== 'finances') continue;
      let settledTotal = this.safeNumOrderMoney(it.amazonFeesTotal);
      if (settledTotal > 0) settledTotal = -Math.abs(settledTotal);
      const normC = (n: number | null) => this.normStoredAmazonFeeComponentForOrderLine(n);
      const sr = normC(toNum(it.settledReferralFeeTotal));
      const sf = normC(toNum(it.settledFbaFeeTotal));
      const sd = normC(toNum(it.settledDigitalServiceFeeTotal));
      if (sr == null && sf == null && sd == null) continue;
      if (this.isLikelyLegacyEqualReferralFbaSplit(sr, sf, sd, settledTotal)) continue;
      const ref = sr ?? 0;
      const fba = sf ?? 0;
      const dig = sd ?? 0;
      const feeSumMag = Math.abs(ref) + Math.abs(fba) + Math.abs(dig);
      if (feeSumMag < 1e-6) continue;
      const qty = this.safeNumOrderMoney(it.quantity) || 1;
      const ord = (it as any).order as
        | { amazonOrderStatus?: string | null; rawResponse?: unknown }
        | undefined;
      const orderCtx = ord
        ? { amazonOrderStatus: ord.amazonOrderStatus, rawOrder: ord.rawResponse }
        : undefined;
      const allowRecon =
        orderCtx == null ||
        this.orderParentStatusAllowsReconstructedRevenueForZeroStoredLine(
          orderCtx.amazonOrderStatus,
          orderCtx.rawOrder,
        );
      const signedRev = this.resolveOrderLineRevenueSigned(
        it as {
          revenueTotal?: unknown;
          quantity?: unknown;
          orderDbId?: unknown;
          sku?: unknown;
          rawResponse?: unknown;
        },
        args.orderPriceByDbId,
        args.skuUnitPriceFallback,
        args.orderLineQtySumByOrderDbId,
        orderCtx,
      );
      let revenue = signedRev;
      if (allowRecon && signedRev === 0) {
        const prod = it.product as { currentListedPrice?: unknown } | undefined;
        const lp = this.safeNumOrderMoney(prod?.currentListedPrice);
        if (lp > 0) revenue = lp * qty;
      }
      if (revenue <= 0.01) continue;
      const ratio = feeSumMag / revenue;
      // Keep references for “elevated but not insane” lines (e.g. ~35–50% fees) so a bad 98% row can still
      // find a same-ASIN peer from an older sane sale. Truly impossible rows stay out of the map.
      if (ratio > 0.92) continue;
      const unitPrice = revenue / qty;
      const row: Row = { ref, fba, dig, qty, revenue, unitPrice, feeSumMag };
      const sku = String(it.sku ?? '').trim();
      if (sku) bySku.set(sku, row);
      const asin = it.asin != null ? String(it.asin).trim() : '';
      if (asin) byAsin.set(asin, row);
    }
    return { byAsin, bySku };
  }

  private collectListOrdersAtPriceFeeJobs(args: {
    items: ReadonlyArray<any>;
    orderPriceByDbId: Map<
      string,
      { itemPrice: number; quantity: number; orderTotalAmount: number }
    >;
    skuUnitPriceFallback: Map<string, number>;
    orderLineQtySumByOrderDbId: Map<string, number>;
    orderSalesExclusionByDbId: Map<string, OrderSalesExclusionKind>;
    productFeesById: Map<
      string,
      {
        referralPerUnit: number | null;
        fbaPerUnit: number | null;
        digitalServicePerUnit: number | null;
        amazonFeePerUnit: number | null;
      }
    >;
    marketplaceRequestId?: string;
  }): Map<
    string,
    {
      userId: string;
      sku: string;
      asinTrim: string | null;
      unitPrice: number;
      isFba: boolean;
      spMarketplaceId: string;
      currency: string;
      lines: Array<{ itemId: string; qty: number; targetTotal: number }>;
    }
  > {
    const jobs = new Map<
      string,
      {
        userId: string;
        sku: string;
        asinTrim: string | null;
        unitPrice: number;
        isFba: boolean;
        spMarketplaceId: string;
        currency: string;
        lines: Array<{ itemId: string; qty: number; targetTotal: number }>;
      }
    >();
    const toNum = (v: unknown): number | null => this.orderMoneyNullable(v);

    for (const it of args.items) {
      const orderDbId = it.orderDbId != null ? String(it.orderDbId) : '';
      if (orderDbId && args.orderSalesExclusionByDbId.get(orderDbId)) continue;

      const userId = String(it.userId ?? '').trim();
      if (!userId) continue;

      const feesSource = String(it.feesSource ?? '');
      let settledFees = this.safeNumOrderMoney(it.amazonFeesTotal);
      if (
        (feesSource === 'finances' ||
          feesSource === 'estimate' ||
          feesSource === 'estimate_sold') &&
        settledFees > 0
      ) {
        settledFees = -Math.abs(settledFees);
      }

      const normC = (n: number | null) => this.normStoredAmazonFeeComponentForOrderLine(n);
      const sr = normC(toNum(it.settledReferralFeeTotal));
      const sf = normC(toNum(it.settledFbaFeeTotal));
      const sd = normC(toNum(it.settledDigitalServiceFeeTotal));
      const hasStoredComponents =
        feesSource === 'finances' && (sr != null || sf != null || sd != null);
      const looksFake =
        hasStoredComponents &&
        this.isLikelyLegacyEqualReferralFbaSplit(sr, sf, sd, settledFees);
      if (feesSource === 'finances' && hasStoredComponents && !looksFake) continue;
      // Pre-sale product estimates drive unsettled rows; do not re-call Product Fees at sold unit price here.
      if (feesSource === 'estimate' || feesSource === 'estimate_sold') continue;

      const qty = this.safeNumOrderMoney(it.quantity) || 1;
      const ord = (it as any).order as
        | { amazonOrderStatus?: string | null; rawResponse?: unknown }
        | undefined;
      const orderCtx = ord
        ? { amazonOrderStatus: ord.amazonOrderStatus, rawOrder: ord.rawResponse }
        : undefined;
      const allowRecon =
        orderCtx == null ||
        this.orderParentStatusAllowsReconstructedRevenueForZeroStoredLine(
          orderCtx.amazonOrderStatus,
          orderCtx.rawOrder,
        );
      const signedRev = this.resolveOrderLineRevenueSigned(
        it as {
          revenueTotal?: unknown;
          quantity?: unknown;
          orderDbId?: unknown;
          sku?: unknown;
          rawResponse?: unknown;
        },
        args.orderPriceByDbId,
        args.skuUnitPriceFallback,
        args.orderLineQtySumByOrderDbId,
        orderCtx,
      );
      let revenueTotal = signedRev;
      const product = it.product as { currentListedPrice?: unknown } | null | undefined;
      if (allowRecon && signedRev === 0 && product?.currentListedPrice != null) {
        const listPx = this.safeNumOrderMoney(product.currentListedPrice);
        if (listPx > 0) revenueTotal = listPx * qty;
      }
      const unitPrice = qty > 0 ? revenueTotal / qty : 0;
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;

      const fees = args.productFeesById.get(it.productId) ?? null;
      const estPerUnit =
        fees?.amazonFeePerUnit ??
        toNum((it.product as any)?.estimatedAmazonFeePerUnit) ??
        null;
      const feesForDisplay =
        settledFees !== 0
          ? settledFees
          : estPerUnit != null && Number.isFinite(estPerUnit)
            ? -Math.abs(estPerUnit * qty)
            : revenueTotal > 0
              ? -Math.abs(revenueTotal * DEFAULT_AMAZON_FEE_RATE_WHEN_UNKNOWN)
              : 0;
      if (Math.abs(feesForDisplay) < 1e-4) continue;

      const sku = String(it.sku ?? '').trim();
      const asinTrim = it.asin != null ? String(it.asin).trim() : '';
      if (!sku && !asinTrim) continue;

      const fulfil = this.parseOrderLineFulfillmentLabel(it.rawResponse);
      const isFba = fulfil !== 'FBM';

      const spMarketplaceId = this.resolveSpApiMarketplaceIdForProductFees(
        undefined,
        args.marketplaceRequestId,
      );
      const currency = this.resolveCurrencyFromMarketplace('GBP', args.marketplaceRequestId);

      const key = `${userId}|${spMarketplaceId}|${sku}|${asinTrim}|${unitPrice.toFixed(2)}|${
        isFba ? 'A' : 'M'
      }`;
      const line = { itemId: String(it.id), qty, targetTotal: feesForDisplay };
      const existing = jobs.get(key);
      if (existing) {
        existing.lines.push(line);
        continue;
      }
      if (jobs.size >= AmazonService.LIST_ORDERS_MAX_AT_PRICE_FEE_JOBS) continue;
      jobs.set(key, {
        userId,
        sku,
        asinTrim: asinTrim || null,
        unitPrice,
        isFba,
        spMarketplaceId,
        currency,
        lines: [line],
      });
    }
    return jobs;
  }

  private async fetchListOrdersPriceBasedFeeBreakdowns(
    jobs: Map<
      string,
      {
        userId: string;
        sku: string;
        asinTrim: string | null;
        unitPrice: number;
        isFba: boolean;
        spMarketplaceId: string;
        currency: string;
        lines: Array<{ itemId: string; qty: number; targetTotal: number }>;
      }
    >,
  ): Promise<Map<string, { r: number; f: number; d: number }>> {
    const out = new Map<string, { r: number; f: number; d: number }>();
    for (const job of jobs.values()) {
      let credentials: SpApiCredentials;
      try {
        credentials = await this.getAmazonCredentialsForUser(job.userId);
      } catch {
        continue;
      }
      const mpId = this.resolveSpApiMarketplaceIdForProductFees(
        credentials.region,
        job.spMarketplaceId,
      );
      const params = {
        marketplaceId: mpId,
        isAmazonFulfilled: job.isFba,
        listingPriceAmount: job.unitPrice,
        listingPriceCurrency: job.currency,
        identifier: `list-orders-${job.sku}-${job.unitPrice}-${Date.now()}`,
      };
      let res: unknown;
      try {
        res =
          job.asinTrim && job.asinTrim.length > 0
            ? await this.spApiClient.getMyFeesEstimateForASIN(
                credentials,
                job.asinTrim,
                params,
              )
            : await this.spApiClient.getMyFeesEstimateForSKU(credentials, job.sku, params);
      } catch (err) {
        this.logger.debug(
          `[listOrders] at-price fee estimate failed userId=${job.userId} sku=${job.sku}`,
          (err as Error)?.message,
        );
        continue;
      }
      const b = this.parseFeesEstimateBreakdown(res as any);
      const refPu = b.referralFee ?? 0;
      const fbaPu = b.fbaFee ?? 0;
      let digPu = b.digitalServiceFee ?? 0;
      if (
        digPu === 0 &&
        (refPu !== 0 || fbaPu !== 0) &&
        (credentials.region ?? 'eu') === 'eu'
      ) {
        digPu = Math.round((refPu + fbaPu) * 0.02 * 100) / 100;
      }
      for (const ln of job.lines) {
        const r = -Math.abs(refPu * ln.qty);
        const f = -Math.abs(fbaPu * ln.qty);
        const d = -Math.abs(digPu * ln.qty);
        const scaled = this.scaleSignedFeeTripToTarget(r, f, d, ln.targetTotal);
        if (scaled) {
          out.set(ln.itemId, { r: scaled.r, f: scaled.f, d: scaled.d });
        }
      }
    }
    return out;
  }

  /** In-memory qty sum for orders in this batch (fallback when DB groupBy fails or returns 0). */
  private buildOrderLineQtySumFromOrderItemsBatch(
    orderItems: Array<{ orderDbId?: unknown; quantity?: unknown }>,
  ): Map<string, number> {
    const m = new Map<string, number>();
    for (const it of orderItems) {
      const oid = it.orderDbId != null ? String(it.orderDbId) : '';
      if (!oid) continue;
      const q = this.safeNumOrderMoney(it.quantity) || 0;
      m.set(oid, (m.get(oid) ?? 0) + q);
    }
    return m;
  }

  /** Load parent order prices for a deduped order-item list (for revenue fallbacks). */
  private async buildRevenueFallbackMapsForOrderItems(
    orderItems: Array<{
      orderDbId?: unknown;
      revenueTotal?: unknown;
      quantity?: unknown;
      sku?: unknown;
      rawResponse?: unknown;
    }>,
  ): Promise<{
    orderPriceByDbId: Map<
      string,
      { itemPrice: number; quantity: number; orderTotalAmount: number }
    >;
    skuUnitPriceFallback: Map<string, number>;
    orderLineQtySumByOrderDbId: Map<string, number>;
  }> {
    const orderDbIds = [
      ...new Set(
        orderItems
          .map((i) => (i.orderDbId != null ? String(i.orderDbId) : ''))
          .filter(Boolean),
      ),
    ];
    const [orderPriceByDbId, dbQtySum] = await Promise.all([
      this.loadOrderParentPricesByDbId(orderDbIds),
      this.loadOrderItemQtySumByOrderDbIds(orderDbIds),
    ]);
    const batchQtySum = this.buildOrderLineQtySumFromOrderItemsBatch(orderItems);
    const orderLineQtySumByOrderDbId = new Map<string, number>();
    for (const id of orderDbIds) {
      const db = dbQtySum.get(id) ?? 0;
      const bat = batchQtySum.get(id) ?? 0;
      orderLineQtySumByOrderDbId.set(id, db > 0 ? db : bat);
    }
    const skuUnitPriceFallback = this.buildSkuUnitPriceFallbackFromOrderItems(orderItems);
    return { orderPriceByDbId, skuUnitPriceFallback, orderLineQtySumByOrderDbId };
  }

  /**
   * Write `order_items.revenue_total` when it is still 0 but parent `OrderTotal` or line `ItemPrice`
   * exists in stored JSON (matches sync `computeLineRevenueTotals`). Small batch per sync run.
   */
  private async backfillZeroRevenueOrderItemsFromStoredTotals(userId: string): Promise<void> {
    const zeroRows = (await (this.prisma as any).orderItem.findMany({
      where: {
        userId,
        marketplace: 'amazon',
        revenueTotal: { lte: 0 },
      },
      select: { orderDbId: true },
      orderBy: { orderDate: 'desc' },
      take: 80,
    })) as Array<{ orderDbId: string }>;
    const orderDbIds = [...new Set(zeroRows.map((r) => r.orderDbId))].slice(0, 25);
    if (orderDbIds.length === 0) return;

    let exclusionMap: Map<string, OrderSalesExclusionKind>;
    try {
      exclusionMap = await this.buildOrderSalesExclusionMap(orderDbIds);
    } catch {
      exclusionMap = new Map();
    }

    for (const orderDbId of orderDbIds) {
      if (exclusionMap.has(orderDbId)) continue;
      const ord = await this.prisma.order.findUnique({
        where: { id: orderDbId },
        select: { id: true, rawResponse: true },
      });
      if (!ord) continue;
      const orderTotalAmt = this.parseOrderTotalAmountFromOrderJson(ord.rawResponse);

      const lines = await (this.prisma as any).orderItem.findMany({
        where: { orderDbId },
        select: {
          id: true,
          orderItemId: true,
          quantity: true,
          revenueTotal: true,
          rawResponse: true,
        },
        orderBy: { orderItemId: 'asc' },
      });
      if (lines.length === 0) continue;

      const sumQty = lines.reduce(
        (s: number, l: { quantity: unknown }) => s + (this.safeNumOrderMoney(l.quantity) || 0),
        0,
      );
      if (sumQty <= 0) continue;

      for (const line of lines) {
        const curRev = this.safeNumOrderMoney(line.revenueTotal);
        if (curRev > 0) continue;
        let rev = 0;
        if (line.rawResponse != null && typeof line.rawResponse === 'object') {
          rev = this.parseOrderItemLineRevenueFromRaw(line.rawResponse);
        }
        if (rev <= 0 && orderTotalAmt > 0) {
          const q = this.safeNumOrderMoney(line.quantity) || 1;
          rev = Number(((orderTotalAmt * q) / sumQty).toFixed(2));
        }
        if (rev <= 0) continue;
        await (this.prisma as any).orderItem.update({
          where: { id: line.id },
          data: { revenueTotal: rev },
        });
      }
    }
  }

  /** Load org VAT settings by organization id (source of truth for API routes scoped with `orgId`). */
  private async getVatSettingsForOrg(orgId: string): Promise<{
    vatRegistrationType: string;
    vatEffectiveDate: Date | null;
    vatRatePct: number;
    vatFlatRatePct: number;
    vatCostsIncludeVat: boolean;
  } | null> {
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
    return this.getVatSettingsForOrg(orgId);
  }

  /** SP-API Money / Decimal-like object → number. */
  private parseMoneyAmountFromMoneyLike(m: any): number {
    if (m == null) return 0;
    if (typeof m === 'number' && Number.isFinite(m)) return m;
    const o = m as { toString?: () => string; toNumber?: () => number };
    if (typeof o?.toNumber === 'function') {
      const n = o.toNumber();
      return Number.isFinite(n) ? n : 0;
    }
    const raw =
      m?.Amount ??
      m?.amount ??
      m?.CurrencyAmount ??
      m?.currencyAmount ??
      (typeof o?.toString === 'function' ? o.toString() : null);
    if (raw == null || raw === '') return 0;
    const n = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
    return Number.isNaN(n) ? 0 : n;
  }

  /**
   * SP-API order line: `ItemPrice` is often missing until shipped; `Amount` may be a string;
   * some payloads expose only `CurrencyAmount`.
   */
  private parseOrderItemItemPriceAmount(it: any): number {
    const ip = it?.ItemPrice ?? it?.itemPrice;
    if (ip == null) return 0;
    return this.parseMoneyAmountFromMoneyLike(ip);
  }

  /**
   * Best-effort line sale amount from getOrderItems payload: ItemPrice total, unitPrice × qty,
   * or ItemChargeList Principal (common when ItemPrice is still zero).
   */
  private parseOrderItemLineRevenueFromRaw(it: any): number {
    if (it == null || typeof it !== 'object') return 0;
    const fromItemPrice = this.parseOrderItemItemPriceAmount(it);
    if (fromItemPrice > 0) return fromItemPrice;
    const ip = it?.ItemPrice ?? it?.itemPrice;
    const unitPrice = ip?.unitPrice ?? ip?.UnitPrice;
    if (unitPrice != null) {
      const up = this.parseMoneyAmountFromMoneyLike(unitPrice);
      const qty = Number(it?.QuantityOrdered ?? it?.quantityOrdered ?? 0);
      const quantityOrdered = qty > 0 ? qty : 1;
      if (up > 0) return Number((up * quantityOrdered).toFixed(2));
    }
    const lists = [
      ...(Array.isArray(it?.ItemChargeList) ? it.ItemChargeList : []),
      ...(Array.isArray(it?.itemChargeList) ? it.itemChargeList : []),
    ];
    let principal = 0;
    for (const ch of lists) {
      const ct = String(ch?.ChargeType ?? ch?.chargeType ?? '').toLowerCase();
      if (!ct.includes('principal')) continue;
      const ca = ch?.ChargeAmount ?? ch?.chargeAmount;
      principal += this.parseMoneyAmountFromMoneyLike(ca);
    }
    if (principal > 0) return Number(principal.toFixed(2));
    return 0;
  }

  /** `OrderTotal` from getOrders payload (stored on Order.rawResponse). */
  private parseOrderTotalAmountFromOrderJson(orderLike: any): number {
    let o = orderLike;
    if (typeof o === 'string') {
      try {
        o = JSON.parse(o);
      } catch {
        return 0;
      }
    }
    if (o == null || typeof o !== 'object') return 0;
    const payload = (o as { payload?: unknown }).payload;
    if (payload != null && typeof payload === 'object') {
      const p = payload as Record<string, unknown>;
      if (p.OrderTotal != null || p.orderTotal != null) {
        o = p;
      }
    }
    const ot = (o as { OrderTotal?: unknown; orderTotal?: unknown }).OrderTotal ?? (o as { orderTotal?: unknown }).orderTotal;
    if (ot == null) return 0;
    if (typeof ot === 'number' && Number.isFinite(ot)) return ot;
    return this.parseMoneyAmountFromMoneyLike(ot);
  }

  /**
   * Per-line revenue from ItemPrice; when missing or zero, split order OrderTotal by line quantity.
   * If OrderTotal is also 0 (pending invoice, etc.), lines stay 0 — there is no reliable total to split.
   */
  private computeLineRevenueTotals(orderItems: any[], orderTotalAmount: number): number[] {
    const itemRevenues = orderItems.map((it) => this.parseOrderItemLineRevenueFromRaw(it));
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
   * Unsettled order lines: **pre-sale** `products` fee estimates (referral + FBA + digital per unit),
   * ex-VAT magnitudes as Seller Central shows before settlement. Line totals are ≤0 for DB math.
   */
  private orderItemFeeEstimateFromPreSaleProduct(
    product: {
      estimatedReferralFeePerUnit?: unknown;
      estimatedFbaFeePerUnit?: unknown;
      estimatedDigitalServiceFeePerUnit?: unknown;
      estimatedAmazonFeePerUnit?: unknown;
    } | null,
    quantityOrdered: number,
  ): {
    itemFees: number;
    referralLine: number | null;
    fbaLine: number | null;
    digitalLine: number | null;
  } | null {
    if (!product) return null;
    const qty = quantityOrdered > 0 ? quantityOrdered : 1;
    const r =
      product.estimatedReferralFeePerUnit != null
        ? Number(product.estimatedReferralFeePerUnit)
        : null;
    const f =
      product.estimatedFbaFeePerUnit != null
        ? Number(product.estimatedFbaFeePerUnit)
        : null;
    const d =
      product.estimatedDigitalServiceFeePerUnit != null
        ? Number(product.estimatedDigitalServiceFeePerUnit)
        : null;
    const t =
      product.estimatedAmazonFeePerUnit != null
        ? Number(product.estimatedAmazonFeePerUnit)
        : null;

    if ((r != null && !Number.isNaN(r)) || (f != null && !Number.isNaN(f)) || (d != null && !Number.isNaN(d))) {
      const rPu = Math.abs(Number(r ?? 0));
      const fPu = Math.abs(Number(f ?? 0));
      let dPu = Math.abs(Number(d ?? 0));
      if (dPu < 1e-9 && (rPu > 0 || fPu > 0)) {
        dPu = Math.round((rPu + fPu) * 0.02 * 100) / 100;
      }
      const perUnit = rPu + fPu + dPu;
      if (perUnit < 1e-9) return null;
      const referralLine = rPu > 1e-9 ? -Math.abs(Number((rPu * qty).toFixed(2))) : null;
      const fbaLine = fPu > 1e-9 ? -Math.abs(Number((fPu * qty).toFixed(2))) : null;
      const digitalLine = dPu > 1e-9 ? -Math.abs(Number((dPu * qty).toFixed(2))) : null;
      const itemFees = -Math.abs(Number((perUnit * qty).toFixed(2)));
      return { itemFees, referralLine, fbaLine, digitalLine };
    }
    if (t != null && !Number.isNaN(t) && t > 0) {
      const itemFees = -Math.abs(Number((t * qty).toFixed(2)));
      return { itemFees, referralLine: null, fbaLine: null, digitalLine: null };
    }
    return null;
  }

  /**
   * Non–VAT-registered (or before VAT effective date): show Amazon fee **including** UK-style VAT on fees.
   * VAT-registered standard/flat after effective date: fee figures stay ex-VAT; fee VAT line hidden in UI.
   */
  private shouldShowAmazonFeesWithVatIncluded(
    vatSettings: {
      vatRegistrationType: string;
      vatEffectiveDate: Date | null;
    } | null,
    orderDate: Date,
  ): boolean {
    if (!vatSettings) return true;
    if (vatSettings.vatRegistrationType === 'NON_VAT_REGISTERED') return true;
    if (
      vatSettings.vatEffectiveDate != null &&
      orderDate < vatSettings.vatEffectiveDate
    ) {
      return true;
    }
    return false;
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

    // Fee VAT: Amazon fee **magnitudes** are ex-VAT; `itemFees` is stored ≤ 0. VAT applies to |fees|, not lost when negative.
    const amazonFeesExVat = Math.round(itemFees * 100) / 100;
    const feeMag = Math.abs(itemFees);
    const amazonFeesVatAmount =
      feeMag > 1e-9 ? Math.round(vatAmountFromEx(feeMag, rate) * 100) / 100 : 0;
    const amazonFeesIncVat = Math.round(
      (itemFees < 0 ? itemFees - amazonFeesVatAmount : itemFees + amazonFeesVatAmount) * 100,
    ) / 100;
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);

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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);

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

    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const { safeStart, safeEnd } = resolveDashboardRangeUtc(
      range,
      marketplaceId,
      nowSafe,
    );

    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);

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

    // Sales / units: sum `order_items` in the range (line revenue is the source of truth).
    // Order *count* matches Seller Central: distinct Amazon order IDs from parent `orders` ∪ line parents (pending
    // orders may exist before order_items are synced).
    const [rawOrderItems, parentOrdersInRange] = await Promise.all([
      (this.prisma as any).orderItem.findMany({
        where: {
          userId: { in: userIds },
          marketplace: marketplaceFilter,
          ...this.whereOrderItemInUtcDashboardRange(safeStart, safeEnd),
        },
        select: {
          id: true,
          orderId: true,
          orderItemId: true,
          orderDbId: true,
          marketplace: true,
          asin: true,
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
          rawResponse: true,
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
      }),
      this.prisma.order.findMany({
        where: {
          userId: { in: userIds },
          marketplace: marketplaceFilter as any,
          orderDate: { gte: safeStart, lte: safeEnd },
        },
        select: { id: true, orderId: true, amazonOrderStatus: true, rawResponse: true },
      }),
    ]);

    if (!rawOrderItems.length && !parentOrdersInRange.length) {
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
        refundsRevenue: 0,
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

    const exclusionIdSet = new Set<string>();
    for (const it of rawOrderItems) {
      const oid = String((it as { orderDbId?: unknown }).orderDbId ?? '').trim();
      if (oid) exclusionIdSet.add(oid);
    }
    for (const o of parentOrdersInRange) {
      exclusionIdSet.add(o.id);
    }
    const exclusionByOrderDbId = await this.buildOrderSalesExclusionMap([
      ...exclusionIdSet,
    ]);
    // Some historical `order_items` rows can have missing `orderDbId`. For unit counts (and revenue),
    // treat lines under a parent **cancelled** order as excluded even without a DB foreign key.
    const cancelledAmazonOrderIds = new Set<string>();
    for (const o of parentOrdersInRange) {
      const kind = this.getOrderSalesExclusionKind(o.amazonOrderStatus, o.rawResponse);
      if (kind !== 'cancelled') continue;
      const aid = String(o.orderId ?? '').trim();
      if (aid) cancelledAmazonOrderIds.add(aid);
    }

    if (!rawOrderItems.length && parentOrdersInRange.length) {
      const currency = this.resolveCurrencyFromMarketplace(
        credentials.region === 'eu' ? 'GBP' : 'USD',
        marketplaceId,
      );
      const totalOrdersOnly = this.countDistinctAmazonOrdersForSummary(
        parentOrdersInRange,
        [],
        exclusionByOrderDbId,
      );
      return {
        marketplace: 'amazon',
        sellerId: 'LIVE-SELLER',
        currency,
        period:
          range?.start || range?.end ? 'custom' : 'last_30_days',
        revenue: 0,
        refundsRevenue: 0,
        profitMargin: 0,
        unitsSold: 0,
        totalOrders: totalOrdersOnly,
        activeSkus: 0,
        unitsInFba: 0,
        openShipments: 0,
        hasCostData: false,
        totalProfit: 0,
        totalCostOfGoods: 0,
        roiPct: null as number | null,
        orderItemsOrdersCount: totalOrdersOnly,
        orderItemsCoveragePct: 1,
        generatedAt: new Date().toISOString(),
      };
    }

    const orderItems = this.dedupeOrderItemsByOrderLine(
      rawOrderItems,
    ) as typeof rawOrderItems;

    const { orderPriceByDbId, skuUnitPriceFallback, orderLineQtySumByOrderDbId } =
      await this.buildRevenueFallbackMapsForOrderItems(orderItems);

    const orderMetaByDbId = new Map<
      string,
      { amazonOrderStatus: string | null; rawResponse: unknown }
    >();
    const metaIds = Array.from(
      new Set(
        orderItems
          .map((it: { orderDbId?: unknown }) => String(it.orderDbId ?? '').trim())
          .filter((id): id is string => Boolean(id)),
      ),
    ) as string[];
    if (metaIds.length > 0) {
      try {
        const orows = await this.prisma.order.findMany({
          where: { id: { in: metaIds } },
          select: { id: true, amazonOrderStatus: true, rawResponse: true },
        });
        for (const o of orows) {
          orderMetaByDbId.set(String(o.id), {
            amazonOrderStatus: o.amazonOrderStatus,
            rawResponse: o.rawResponse,
          });
        }
      } catch {
        // non-fatal
      }
    }
    const parentOrderCtxForSummary = (it: { orderDbId?: unknown }) => {
      const id = String(it.orderDbId ?? '').trim();
      const o = id ? orderMetaByDbId.get(id) : undefined;
      return o
        ? { amazonOrderStatus: o.amazonOrderStatus, rawOrder: o.rawResponse }
        : undefined;
    };

    let salesRevenue = 0;
    let refundsRevenue = 0;
    for (const it of orderItems) {
      const oid = String((it as { orderDbId?: unknown }).orderDbId ?? '');
      if (oid && exclusionByOrderDbId.has(oid)) continue;
      if (!oid) {
        const aid = String((it as { orderId?: unknown }).orderId ?? '').trim();
        if (aid && cancelledAmazonOrderIds.has(aid)) continue;
      }
      const line = this.resolveOrderLineRevenueSigned(
        it as {
          revenueTotal?: unknown;
          quantity?: unknown;
          orderDbId?: unknown;
          sku?: unknown;
          rawResponse?: unknown;
        },
        orderPriceByDbId,
        skuUnitPriceFallback,
        orderLineQtySumByOrderDbId,
        parentOrderCtxForSummary(it),
      );
      if (line > 0) salesRevenue += line;
      else if (line < 0) refundsRevenue += line;
    }
    const revenue = salesRevenue;
    const unitsSold = orderItems.reduce((sum, it) => {
      const oid = String((it as { orderDbId?: unknown }).orderDbId ?? '');
      if (oid && exclusionByOrderDbId.has(oid)) return sum;
      if (!oid) {
        const aid = String((it as { orderId?: unknown }).orderId ?? '').trim();
        if (aid && cancelledAmazonOrderIds.has(aid)) return sum;
      }
      const lineRev = this.resolveOrderLineRevenueSigned(
        it as {
          revenueTotal?: unknown;
          quantity?: unknown;
          orderDbId?: unknown;
          sku?: unknown;
          rawResponse?: unknown;
        },
        orderPriceByDbId,
        skuUnitPriceFallback,
        orderLineQtySumByOrderDbId,
        parentOrderCtxForSummary(it),
      );
      if (lineRev <= 0) return sum;
      return sum + toNumber((it as { quantity?: unknown }).quantity ?? 0);
    }, 0);
    const totalOrders = this.countDistinctAmazonOrdersForSummary(
      parentOrdersInRange,
      orderItems,
      exclusionByOrderDbId,
    );
    const orderItemsOrdersCount = totalOrders;
    const orderItemsCoveragePct = 1;

    // Profit = sale price (revenueTotal) - selling fees (amazonFeesTotal, stored negative) - tax - COGS. ROI = profit / cost of goods.
    let totalProfit = 0;
    let totalCostOfGoods = 0;
    let hasProfitData = false;
    for (const it of orderItems) {
      const oid = String((it as { orderDbId?: unknown }).orderDbId ?? '');
      if (oid && exclusionByOrderDbId.has(oid)) continue;

      const revenueTotal = this.resolveOrderLineRevenueSigned(
        it as {
          revenueTotal?: unknown;
          quantity?: unknown;
          orderDbId?: unknown;
          sku?: unknown;
          rawResponse?: unknown;
        },
        orderPriceByDbId,
        skuUnitPriceFallback,
        orderLineQtySumByOrderDbId,
        parentOrderCtxForSummary(it),
      );
      const taxChargedTotal = toNumber(it.taxChargedTotal ?? 0);
      const amazonFeesTotalRaw = toNumber(it.amazonFeesTotal ?? 0);
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
      const normStoredAmazonFeeComponent = (n: number | null): number | null => {
        if (n == null || !Number.isFinite(n)) return null;
        if (n === 0) return 0;
        return n > 0 ? -Math.abs(n) : n;
      };
      const feesSource = (it as any).feesSource ?? null;
      let settledFees = amazonFeesTotalRaw;
      if (
        (feesSource === 'finances' ||
          feesSource === 'estimate' ||
          feesSource === 'estimate_sold') &&
        settledFees > 0
      ) {
        settledFees = -Math.abs(settledFees);
      }
      // Use order item's stored fees when present (settled or previously saved estimate); otherwise use product's saved estimate so we always pick up fee data from DB.
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
      let referralFeeTotal: number | null = null;
      let fbaFeeTotal: number | null = null;
      let digitalServiceFeeTotal: number | null = null;
      const settledReferral = normStoredAmazonFeeComponent(
        toNumOpt((it as any).settledReferralFeeTotal),
      );
      const settledFba = normStoredAmazonFeeComponent(toNumOpt((it as any).settledFbaFeeTotal));
      const settledDigital = normStoredAmazonFeeComponent(
        toNumOpt((it as any).settledDigitalServiceFeeTotal),
      );
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
          digitalServiceFeeTotal == null &&
          (referralFeeTotal != null || fbaFeeTotal != null)
        ) {
          const sum = Math.abs(referralFeeTotal ?? 0) + Math.abs(fbaFeeTotal ?? 0);
          if (sum > 0) {
            digitalServiceFeeTotal = Math.round(-sum * 0.02 * 100) / 100;
          }
        }
      }
      if (
        feesSource === 'finances' &&
        referralFeeTotal != null &&
        fbaFeeTotal != null &&
        (digitalServiceFeeTotal == null || digitalServiceFeeTotal === 0)
      ) {
        const ar = Math.abs(referralFeeTotal);
        const af = Math.abs(fbaFeeTotal);
        const at = Math.abs(settledFees);
        if (
          ar > 0.009 &&
          Math.abs(ar - af) < 0.02 &&
          at > 0.009 &&
          Math.abs(ar + af - at) < 0.07
        ) {
          referralFeeTotal = null;
          fbaFeeTotal = null;
          digitalServiceFeeTotal = null;
        }
      }
      if (feesSource === 'finances' && Math.abs(feesForDisplay) > 1e-4) {
        const tr = referralFeeTotal ?? 0;
        const tf = fbaFeeTotal ?? 0;
        const td = digitalServiceFeeTotal ?? 0;
        const sumB = tr + tf + td;
        if (
          (referralFeeTotal != null || fbaFeeTotal != null || digitalServiceFeeTotal != null) &&
          Math.abs(sumB) > 1e-4 &&
          Math.abs(sumB - feesForDisplay) > 0.02
        ) {
          const scaled = this.scaleSignedFeeTripToTarget(tr, tf, td, feesForDisplay);
          if (scaled) {
            referralFeeTotal = scaled.r !== 0 ? scaled.r : null;
            fbaFeeTotal = scaled.f !== 0 ? scaled.f : null;
            digitalServiceFeeTotal = scaled.d !== 0 ? scaled.d : null;
          }
        }
      }
      const totalFromBreakdown =
        (referralFeeTotal ?? 0) + (fbaFeeTotal ?? 0) + (digitalServiceFeeTotal ?? 0);
      const useBreakdownSum =
        feesSource !== 'finances' &&
        (referralFeeTotal != null || fbaFeeTotal != null || digitalServiceFeeTotal != null) &&
        totalFromBreakdown !== 0;
      const finalFeesForDisplay = useBreakdownSum
        ? Math.round(totalFromBreakdown * 100) / 100
        : Math.round(feesForDisplay * 100) / 100;

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
    const profitMargin = hasCostData && salesRevenue > 0 ? totalProfit / salesRevenue : 0;
    const roiPct =
      totalCostOfGoods > 0 ? (totalProfit / totalCostOfGoods) * 100 : null;

    return {
      marketplace: 'amazon',
      sellerId: 'LIVE-SELLER',
      currency,
      period: 'last_30_days',
      revenue,
      refundsRevenue,
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

    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const { safeStart, safeEnd } = resolveDashboardRangeUtc(
      range,
      marketplaceId,
      nowSafe,
    );

    const userIds = await this.getOrgAmazonOrderReadUserIds(orgId);
    if (userIds.length === 0) return defaultRes;

    const rawCategoryItems = await (this.prisma as any).orderItem.findMany({
      where: {
        userId: { in: userIds },
        marketplace: marketplaceFilter,
        ...this.whereOrderItemInUtcDashboardRange(safeStart, safeEnd),
      },
      select: {
        id: true,
        orderId: true,
        orderItemId: true,
        orderDbId: true,
        marketplace: true,
        asin: true,
        sku: true,
        feesSource: true,
        updatedAt: true,
        revenueTotal: true,
        profit: true,
        cogsTotal: true,
        quantity: true,
        rawResponse: true,
        product: { select: { displayGroup: true } },
      },
    });
    const orderItems = this.dedupeOrderItemsByOrderLine(
      rawCategoryItems,
    ) as typeof rawCategoryItems;

    const { orderPriceByDbId, skuUnitPriceFallback, orderLineQtySumByOrderDbId } =
      await this.buildRevenueFallbackMapsForOrderItems(orderItems);

    const exclusionByOrderDbId = await this.buildOrderSalesExclusionMap(
      orderItems.map((it: any) => String(it.orderDbId ?? '')).filter(Boolean),
    );

    const catOrderMetaByDbId = new Map<
      string,
      { amazonOrderStatus: string | null; rawResponse: unknown }
    >();
    const catMetaIds = Array.from(
      new Set(
        orderItems
          .map((it: { orderDbId?: unknown }) => String(it.orderDbId ?? '').trim())
          .filter((id): id is string => Boolean(id)),
      ),
    ) as string[];
    if (catMetaIds.length > 0) {
      try {
        const orows = await this.prisma.order.findMany({
          where: { id: { in: catMetaIds } },
          select: { id: true, amazonOrderStatus: true, rawResponse: true },
        });
        for (const o of orows) {
          catOrderMetaByDbId.set(String(o.id), {
            amazonOrderStatus: o.amazonOrderStatus,
            rawResponse: o.rawResponse,
          });
        }
      } catch {
        // non-fatal
      }
    }
    const parentOrderCtxForCategory = (it: { orderDbId?: unknown }) => {
      const id = String(it.orderDbId ?? '').trim();
      const o = id ? catOrderMetaByDbId.get(id) : undefined;
      return o
        ? { amazonOrderStatus: o.amazonOrderStatus, rawOrder: o.rawResponse }
        : undefined;
    };

    const toNum = (v: unknown): number => {
      if (v == null) return 0;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') return parseFloat(v) || 0;
      return Number(v) || 0;
    };

    type Agg = { sales: number; profit: number; cogs: number; units: number };
    const byCategory = new Map<string, Agg>();
    for (const it of orderItems) {
      const oid = String((it as { orderDbId?: unknown }).orderDbId ?? '');
      if (oid && exclusionByOrderDbId.has(oid)) continue;

      const cat = (it.product?.displayGroup ?? '').trim() || 'Uncategorized';
      const cur = byCategory.get(cat) ?? { sales: 0, profit: 0, cogs: 0, units: 0 };
      const lineRev = this.resolveOrderLineRevenueSigned(
        it as {
          revenueTotal?: unknown;
          quantity?: unknown;
          orderDbId?: unknown;
          sku?: unknown;
          rawResponse?: unknown;
        },
        orderPriceByDbId,
        skuUnitPriceFallback,
        orderLineQtySumByOrderDbId,
        parentOrderCtxForCategory(it),
      );
      if (lineRev > 0) cur.sales += lineRev;
      cur.profit += toNum(it.profit);
      cur.cogs += toNum(it.cogsTotal);
      if (lineRev > 0) cur.units += toNum(it.quantity) || 0;
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
    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const { safeStart, safeEnd } = resolveDashboardRangeUtc(
      range,
      marketplaceId,
      nowSafe,
    );

    const userIds = await this.getOrgAmazonOrderReadUserIds(orgId);
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
        ...this.whereOrderItemInUtcDashboardRange(safeStart, safeEnd),
      },
      select: {
        id: true,
        orderId: true,
        orderItemId: true,
        orderDbId: true,
        marketplace: true,
        asin: true,
        sku: true,
        rawResponse: true,
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
        revenueTotal: true,
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

    const costExclusionByOrderDbId = await this.buildOrderSalesExclusionMap(
      orderItems.map((it: any) => String(it.orderDbId ?? '')).filter(Boolean),
    );

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
      const oid = String((it as { orderDbId?: unknown }).orderDbId ?? '');
      if (oid && costExclusionByOrderDbId.has(oid)) continue;

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
      const estReferralC = asCost(estReferral);
      const estFbaC = asCost(estFba);
      const estDsfC = asCost(estDsf);
      const estTotalC = asCost(estTotal);

      let lineReferral = 0;
      let lineFba = 0;
      let lineDigital = 0;
      let lineAmazonTotal = 0;

      if (settledTotal > 0) {
        // Finances lump is authoritative: breakdown rows must sum to it (never add full estimates on top of a lump).
        lineAmazonTotal = settledTotal;
        const sr = settledReferral > 0 ? settledReferral : 0;
        const sf = settledFba > 0 ? settledFba : 0;
        const sd = settledDigital > 0 ? settledDigital : 0;
        const parts = sr + sf + sd;
        if (parts > 1e-6) {
          lineReferral = settledTotal * (sr / parts);
          lineFba = settledTotal * (sf / parts);
          lineDigital = settledTotal * (sd / parts);
        } else {
          const w = estReferralC + estFbaC + estDsfC;
          if (w > 1e-6) {
            lineReferral = settledTotal * (estReferralC / w);
            lineFba = settledTotal * (estFbaC / w);
            lineDigital = settledTotal * (estDsfC / w);
          } else {
            lineFba = settledTotal;
          }
        }
      } else {
        lineReferral = estReferralC;
        lineFba = estFbaC;
        lineDigital = estDsfC;
        lineAmazonTotal = estTotalC > 0 ? estTotalC : estReferralC + estFbaC + estDsfC;
        const cs = lineReferral + lineFba + lineDigital;
        if (lineAmazonTotal > 1e-6 && cs > lineAmazonTotal * 1.02) {
          const scale = lineAmazonTotal / cs;
          lineReferral *= scale;
          lineFba *= scale;
          lineDigital *= scale;
        }
      }

      const storedRev = toNum((it as { revenueTotal?: unknown }).revenueTotal);
      const lineRev = storedRev < 0 ? 0 : Math.max(0, storedRev);
      const feeCap = lineRev > 0 ? lineRev * 0.95 : null;
      if (feeCap != null && lineAmazonTotal > feeCap + 1e-6) {
        const scale = feeCap / lineAmazonTotal;
        lineReferral *= scale;
        lineFba *= scale;
        lineDigital *= scale;
        lineAmazonTotal = feeCap;
      }

      referralFees += lineReferral;
      fbaFees += lineFba;
      digitalServiceFees += lineDigital;
      totalAmazonFees += lineAmazonTotal;
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
   * Profit & Loss for a period: sales revenue (positive lines only) plus refunds (negative, separate field),
   * minus selling unit costs (COGS, prep, fees) and fixed costs.
   * Total profit = sales revenue + refunds revenue + adjustments − selling costs − fixed costs.
   * Promotional discounts come from Orders API line `rawResponse`. Reimbursements and other account
   * adjustments come from Finances v0 `listFinancialEvents` by **posted** date (chunked ≤170d per request).
   * Also returns VAT adjustment: outputVat (on sales), inputVat (on costs), vatBalance = outputVat - inputVat.
   */
  async getProfitAndLoss(
    orgId: string,
    range?: { start?: string; end?: string },
    marketplaceId?: string,
  ): Promise<{
    revenue: number;
    /** Sum of negative line revenues (refunds / clawbacks), ≤ 0. */
    refundsRevenue: number;
    promotionalAdjustments: number;
    reimbursementAdjustments: number;
    otherAdjustments: number;
    totalAdjustments: number;
    totalSellingCosts: number;
    totalCogs: number;
    prepFees: number;
    referralFees: number;
    fbaFees: number;
    digitalServiceFees: number;
    totalAmazonFees: number;
    softwareSubsTotal: number;
    otherSubsTotal: number;
    otherFixedCostsTotal: number;
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
    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const { safeStart, safeEnd } = resolveDashboardRangeUtc(
      range,
      marketplaceId,
      nowSafe,
    );

    const allMemberUserIds = await this.getOrgMemberUserIds(orgId);
    const amazonAggUserIds = await this.getOrgAmazonAggregateUserIds(orgId);
    const amazonOrderReadUserIds = await this.getOrgAmazonOrderReadUserIds(orgId);
    const toNum = (v: unknown): number => {
      if (v == null) return 0;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') return parseFloat(v) || 0;
      return Number((v as any).toString?.() ?? 0) || 0;
    };
    let salesRevenue = 0;
    let refundsRevenue = 0;
    let promotionalAdjustments = 0;
    let reimbursementAdjustments = 0;
    let otherAdjustments = 0;
    let outputVat = 0;
    let inputVat = 0;
    let softwareSubsTotal = 0;
    let otherSubsTotal = 0;
    let otherFixedCostsTotal = 0;

    // VAT settings for computing VAT when not stored on order items
    let vatSettings: Awaited<ReturnType<AmazonService['getVatSettingsForOrg']>> = null;
    try {
      vatSettings = await this.getVatSettingsForOrg(orgId);
    } catch {
      // ignore
    }

    if (amazonOrderReadUserIds.length > 0) {
      const rawPnlItems = await (this.prisma as any).orderItem.findMany({
        where: {
          userId: { in: amazonOrderReadUserIds },
          marketplace: marketplaceFilter,
          ...this.whereOrderItemInUtcDashboardRange(safeStart, safeEnd),
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
          rawResponse: true,
          order: { select: { amazonOrderStatus: true, rawResponse: true } },
        },
      });
      const items = this.dedupeOrderItemsByOrderLine(
        rawPnlItems,
      ) as typeof rawPnlItems;
      const {
        orderPriceByDbId: pnlOrderPrices,
        skuUnitPriceFallback: pnlSkuFallback,
        orderLineQtySumByOrderDbId: pnlOrderLineQtySum,
      } = await this.buildRevenueFallbackMapsForOrderItems(items);
      const pnlExclusionByOrderDbId = await this.buildOrderSalesExclusionMap(
        items.map((it: any) => String(it.orderDbId ?? '')).filter(Boolean),
      );
      const promoFromRaw = (raw: unknown): number => {
        const it = raw as any;
        if (!it || typeof it !== 'object') return 0;
        const readAmt = (obj: any): number => {
          if (!obj) return 0;
          const n = Number(obj?.Amount ?? obj?.amount ?? obj?.CurrencyAmount ?? obj?.currencyAmount ?? 0);
          return Number.isFinite(n) ? n : 0;
        };
        // Orders API fields (usually positive magnitude); treat as a negative adjustment to profit.
        const promo =
          readAmt(it.PromotionDiscount ?? it.promotionDiscount) +
          readAmt(it.PromotionDiscountTax ?? it.promotionDiscountTax) +
          readAmt(it.ShippingDiscount ?? it.shippingDiscount) +
          readAmt(it.ShippingDiscountTax ?? it.shippingDiscountTax);
        return promo;
      };
      for (const it of items) {
        const pnlOid = String((it as { orderDbId?: unknown }).orderDbId ?? '');
        if (pnlOid && pnlExclusionByOrderDbId.has(pnlOid)) continue;

        const ord = (it as any).order as
          | { amazonOrderStatus?: string | null; rawResponse?: unknown }
          | null
          | undefined;
        const pnlParentCtx = ord
          ? { amazonOrderStatus: ord.amazonOrderStatus, rawOrder: ord.rawResponse }
          : undefined;
        const lineRev = this.resolveOrderLineRevenueSigned(
          it as {
            revenueTotal?: unknown;
            quantity?: unknown;
            orderDbId?: unknown;
            sku?: unknown;
            rawResponse?: unknown;
          },
          pnlOrderPrices,
          pnlSkuFallback,
          pnlOrderLineQtySum,
          pnlParentCtx,
        );
        if (lineRev > 0) salesRevenue += lineRev;
        else if (lineRev < 0) refundsRevenue += lineRev;
        const promoAdj = promoFromRaw((it as any).rawResponse);
        if (promoAdj !== 0) promotionalAdjustments -= Math.abs(promoAdj);
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
        if (
          rev > 0 &&
          saleVat === 0 &&
          itemInputVat === 0 &&
          vatSettings &&
          vatSettings.vatRegistrationType !== 'NON_VAT_REGISTERED'
        ) {
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
    }

    // Finances v0 `listFinancialEvents` (posted date): reimbursements / adjustments not represented on order lines.
    if (amazonAggUserIds.length > 0) {
      try {
        const credentials = await this.getAmazonCredentialsForOrg(orgId);
        const rangeStartMs = safeStart.getTime();
        const rangeEndMs = safeEnd.getTime();
        const maxWindowMs = 170 * 24 * 60 * 60 * 1000;
        let windowStartMs = rangeStartMs;
        while (windowStartMs <= rangeEndMs) {
          const windowEndMs = Math.min(windowStartMs + maxWindowMs, rangeEndMs);
          const postedAfter = new Date(windowStartMs).toISOString();
          const postedBefore = new Date(
            Math.max(windowEndMs, windowStartMs + 60_000),
          ).toISOString();
          const range = await this.fetchFinancialEventsPostedRangeAllPages(
            credentials,
            postedAfter,
            postedBefore,
          );
          const bucket = this.getFinancialEventsBucket(range.merged);
          if (bucket) {
            const sums = this.sumProfitAndLossFinancesPostedBucket(bucket);
            reimbursementAdjustments += sums.reimbursementAdjustments;
            otherAdjustments += sums.otherAdjustments;
            // Service fees: subscription belongs in fixed costs; storage + inbound shipping under adjustments.
            otherAdjustments += sums.amazonStorageFees + sums.amazonInboundShippingFees;
            softwareSubsTotal += sums.amazonSubscriptionFees;
          }
          windowStartMs = windowEndMs + 1;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(
          `[getProfitAndLoss] Finances posted-range reimbursements/adjustments skipped: ${msg}`,
        );
      }
    }

    // Input VAT from purchases in the period (all org members — not de-duped by Amazon seller)
    if (allMemberUserIds.length > 0) {
      const purchases = await (this.prisma as any).purchase.findMany({
        where: {
          userId: { in: allMemberUserIds },
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
    if (allMemberUserIds.length > 0) {
      // Fixed costs are stored monthly on the org. Apportion them into the chosen date range.
      const org = await (this.prisma as any).organization.findUnique({
        where: { id: orgId },
        select: { fixedCostsSoftware: true, fixedCostsOtherSubs: true, fixedCostsOther: true },
      });
      const toNum = (v: unknown): number => {
        if (v == null) return 0;
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string') return parseFloat(v) || 0;
        return Number((v as any).toString?.() ?? 0) || 0;
      };
      const monthlySoftware = toNum(org?.fixedCostsSoftware);
      const monthlyOtherSubs = toNum(org?.fixedCostsOtherSubs);
      const monthlyOtherFixed = toNum(org?.fixedCostsOther);
      const dayMs = 24 * 60 * 60 * 1000;
      const days = Math.max(1, Math.round((safeEnd.getTime() - safeStart.getTime()) / dayMs) + 1);
      const monthDays = 30; // simple monthly apportionment
      const factor = days / monthDays;
      softwareSubsTotal = Math.round(monthlySoftware * factor * 100) / 100;
      otherSubsTotal = Math.round(monthlyOtherSubs * factor * 100) / 100;
      otherFixedCostsTotal = Math.round(monthlyOtherFixed * factor * 100) / 100;
    }

    const totalSellingCosts =
      cost.totalCogs +
      cost.prepFees +
      cost.totalAmazonFees;
    const totalFixedCosts = softwareSubsTotal + otherSubsTotal + otherFixedCostsTotal;
    const totalAdjustments =
      promotionalAdjustments + reimbursementAdjustments + otherAdjustments;
    const revenue = salesRevenue;
    const totalProfit =
      salesRevenue +
      refundsRevenue +
      totalAdjustments -
      totalSellingCosts -
      totalFixedCosts;

    return {
      revenue,
      refundsRevenue,
      promotionalAdjustments,
      reimbursementAdjustments,
      otherAdjustments,
      totalAdjustments,
      totalSellingCosts,
      totalCogs: cost.totalCogs,
      prepFees: cost.prepFees,
      referralFees: cost.referralFees,
      fbaFees: cost.fbaFees,
      digitalServiceFees: cost.digitalServiceFees,
      totalAmazonFees: cost.totalAmazonFees,
      softwareSubsTotal,
      otherSubsTotal,
      otherFixedCostsTotal,
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

    const userIds = await this.getOrgAmazonOrderReadUserIds(orgId);
    const rawTsItems = await (this.prisma as any).orderItem.findMany({
      where: {
        userId: { in: userIds },
        marketplace: marketplaceFilter,
        ...this.whereOrderItemInUtcDashboardRange(startDate, endDate),
      },
      select: {
        id: true,
        orderId: true,
        orderItemId: true,
        orderDbId: true,
        marketplace: true,
        asin: true,
        sku: true,
        quantity: true,
        updatedAt: true,
        feesSource: true,
        orderDate: true,
        revenueTotal: true,
        profit: true,
        rawResponse: true,
        order: { select: { orderDate: true, amazonOrderStatus: true, rawResponse: true } },
      },
    });

    const tsItems = this.dedupeOrderItemsByOrderLine(rawTsItems) as typeof rawTsItems;

    const {
      orderPriceByDbId: tsOrderPrices,
      skuUnitPriceFallback: tsSkuFallback,
      orderLineQtySumByOrderDbId: tsOrderLineQtySum,
    } = await this.buildRevenueFallbackMapsForOrderItems(tsItems);

    const tsExclusionByOrderDbId = await this.buildOrderSalesExclusionMap(
      tsItems.map((it: any) => String(it.orderDbId ?? '')).filter(Boolean),
    );

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
      const tsOid = String((it as { orderDbId?: unknown }).orderDbId ?? '');
      const kind = tsOid ? tsExclusionByOrderDbId.get(tsOid) : undefined;
      const tsOrd = (it as any).order as
        | { amazonOrderStatus?: string | null; rawResponse?: unknown }
        | undefined;
      const tsParentCtx = tsOrd
        ? { amazonOrderStatus: tsOrd.amazonOrderStatus, rawOrder: tsOrd.rawResponse }
        : undefined;
      const signedTs = this.resolveOrderLineRevenueSigned(
        it as {
          revenueTotal?: unknown;
          quantity?: unknown;
          orderDbId?: unknown;
          sku?: unknown;
          rawResponse?: unknown;
        },
        tsOrderPrices,
        tsSkuFallback,
        tsOrderLineQtySum,
        tsParentCtx,
      );
      const excludedFromSales = kind != null || signedTs < 0;
      const excludedFromOrderCount = kind === 'cancelled';

      const itAny = it as { orderDate?: unknown; order?: { orderDate?: unknown } };
      const parentDt = itAny.order?.orderDate;
      const bucket =
        parentDt instanceof Date
          ? parentDt
          : parentDt != null
            ? new Date(parentDt as string | number)
            : itAny.orderDate instanceof Date
              ? itAny.orderDate
              : new Date(String(itAny.orderDate ?? ''));
      const key = bucket.toISOString().slice(0, 10); // YYYY-MM-DD (UTC bucket; matches prior behavior)

      const existing = byDate.get(key) ?? {
        revenue: 0,
        orderIds: new Set<string>(),
        profit: 0,
      };

      if (!excludedFromSales) {
        const revenueForLine = Math.max(0, signedTs);
        const profitForLine = it.profit != null ? toNumTs(it.profit) : 0;
        existing.revenue += revenueForLine;
        existing.profit += profitForLine;
      }
      if (!excludedFromOrderCount) {
        existing.orderIds.add(String(it.orderId ?? ''));
      }
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
   * Max calendar days of orders SP-API may pull for this user (30 for everyone except one
   * allowlisted account — see `amazon-extended-sync.constants.ts`).
   */
  async orderSyncMaxDaysForUser(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const em = (user?.email ?? '').trim().toLowerCase();
    return em === AMAZON_EXTENDED_ORDER_HISTORY_EMAIL ? 365 : 30;
  }

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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
    let ordersRemoved = 0;
    for (const uid of userIds) {
      const r = await this.repairDuplicateAmazonOrdersForUser(uid);
      ordersRemoved += r.ordersRemoved;
    }
    return { ordersRemoved, orgUserIds: userIds };
  }

  /**
   * Sync orders from SP-API into DB (including finances per order via listFinancialEventsByOrderId). Call paths:
   * - full-sync (initial): days=30 (or env-extended cap for allowlisted user IDs), no cap → orders + finances.
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
    const maxDaysAllowed = await this.orderSyncMaxDaysForUser(userId);
    const requested =
      Number(opts?.days ?? AmazonService.SYNC_ORDERS_DAYS_DEFAULT) ||
      AmazonService.SYNC_ORDERS_DAYS_DEFAULT;
    const days = Math.max(1, Math.min(maxDaysAllowed, requested));
    if (maxDaysAllowed > 30 && days > 30) {
      this.logger.log(
        `[syncRecentOrdersToDb] extended order window: days=${days} (cap=${maxDaysAllowed}, userId=${userId.slice(0, 8)}…)`,
      );
    }
    const onProgress = opts?.onProgress;
    if (onProgress) await onProgress(1);

    /** Extra delay between Finances calls during order sync (large windows hit strict quotas). */
    const orderFinancesPauseMs = Math.max(
      400,
      Number(this.configService.get<string>('AMAZON_ORDER_FINANCES_PAUSE_MS')) || 2200,
    );

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

      const apiOrderStatusRaw = (order as Record<string, unknown>).OrderStatus;
      const apiOrderStatus =
        typeof apiOrderStatusRaw === 'string' ? apiOrderStatusRaw.trim() : null;

      let totalAmount = this.parseOrderTotalAmountFromOrderJson(order);

      const quantityRaw =
        (order.NumberOfItemsShipped ?? 0) + (order.NumberOfItemsUnshipped ?? 0);
      let quantity = quantityRaw > 0 ? quantityRaw : 1;

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
          // Sequential calls: Finances + Orders in parallel spikes 429s on long backfills.
          itemsRes = (await this.spApiClient.getOrderItems(credentials, amazonOrderId)) as any;
          await new Promise((r) =>
            setTimeout(r, Math.max(300, Math.floor(orderFinancesPauseMs / 2))),
          );
          finRes = (await this.spApiClient.listFinancialEventsByOrderId(
            credentials,
            amazonOrderId,
            { maxResultsPerPage: 100 },
          )) as any;
          orderItems = itemsRes?.payload?.OrderItems ?? [];
          for (const item of orderItems) {
            const itemTaxAmt = Number(item?.ItemTax?.Amount ?? 0);
            if (!Number.isNaN(itemTaxAmt)) taxChargedTotal += itemTaxAmt;
            const shipAmt = Number(item?.ShippingPrice?.Amount ?? 0);
            if (!Number.isNaN(shipAmt)) shippingChargedTotal += shipAmt;
          }
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

      // Reconcile header total + quantities after getOrderItems: OrderTotal is often 0 until shipped;
      // line payloads still carry ItemPrice / Principal. Prevents persisting £0 revenue on new orders.
      if (orderItems.length > 0) {
        const qtyFromItems = orderItems.reduce(
          (sum: number, item: any) => sum + Number(item?.QuantityOrdered ?? 0),
          0,
        );
        if (qtyFromItems > 0) quantity = qtyFromItems;
        if (totalAmount <= 0) {
          const lineSum = orderItems.reduce(
            (s: number, item: any) => s + this.parseOrderItemLineRevenueFromRaw(item),
            0,
          );
          if (lineSum > 0) totalAmount = lineSum;
        }
      }
      const itemPrice =
        quantity > 0
          ? Number((totalAmount / quantity).toFixed(2))
          : totalAmount;

      // When Finances API returns settled fee data we save it per order item (feesSource='finances').
      // Same OrderItemId can appear in Shipment + Settle + refunds. **First** non-zero fee wins (avoid stacking
      // duplicate full fees). **Breakdown** uses last non-zero wins so referral/FBA splits can follow the
      // latest Shipment* row (see shipmentLists order: Settle after ShipmentEvent).
      const feeByOrderItemId = new Map<string, number>();
      const feeBySku = new Map<string, number>();

      const addFee = (
        map: Map<string, number>,
        key: string,
        amount: number,
      ) => {
        if (!key || amount === 0 || !Number.isFinite(amount)) return;
        const prev = map.get(key) ?? 0;
        if (prev !== 0) return;
        map.set(key, amount);
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
        const mag = Math.abs(r) + Math.abs(f) + Math.abs(d);
        if (mag < 1e-9) return;
        map.set(key, { referral: r, fba: f, digital: d });
      };

      if (finRes) {
        const recursiveSigned = sumCurrencyAmountsByKey(finRes, 'FeeAmount');
        amazonFeesTotal = recursiveSigned;
        // Support both PascalCase and camelCase (SP-API can return either).
        const events =
          finRes?.payload?.FinancialEvents ??
          finRes?.payload?.financialEvents ??
          finRes?.FinancialEvents ??
          {};
        const shipmentLists = [
          ...(events?.ShipmentEventList ?? events?.shipmentEventList ?? []),
          ...(events?.ShipmentSettleEventList ?? events?.shipmentSettleEventList ?? []),
          ...(events?.DeferredTransactionEventList ?? events?.deferredTransactionEventList ?? []),
          ...(events?.RefundEventList ?? events?.refundEventList ?? []),
          ...(events?.ChargebackEventList ?? events?.chargebackEventList ?? []),
          ...(events?.GuaranteeClaimEventList ?? events?.guaranteeClaimEventList ?? []),
        ];
        const extractEventItemList = (ev: any): any[] => {
          if (!ev || typeof ev !== 'object') return [];
          const candidates = [
            ev.ShipmentItemList,
            ev.shipmentItemList,
            ev.DeferredTransactionItemList,
            ev.deferredTransactionItemList,
            ev.ItemList,
            ev.itemList,
          ];
          for (const c of candidates) {
            if (Array.isArray(c)) return c;
          }
          return [];
        };
        for (const ev of shipmentLists) {
          const items = extractEventItemList(ev);
          for (const si of items) {
            const fee = parseFinancesShipmentItemFeesSignedTotal(si);
            const orderItemIdRaw = si?.OrderItemId ?? si?.orderItemId;
            const orderItemId = orderItemIdRaw != null ? String(orderItemIdRaw) : '';
            const sku = (si?.SellerSKU ?? si?.sellerSKU) as string | undefined;
            if (fee !== 0) {
              if (orderItemId) addFee(feeByOrderItemId, orderItemId, fee);
              if (sku) addFee(feeBySku, sku, fee);
            }
            const shipBd = parseFinancesShipmentItemFeesBreakdown(si);
            const { referral: r, fba: f, digital: d } = shipBd;
            if (orderItemId) addFeeBreakdown(breakdownByOrderItemId, orderItemId, r, f, d);
            if (sku) addFeeBreakdown(breakdownBySku, sku, r, f, d);
          }
        }
        // Recursive FeeAmount scan sums the whole Finances payload (Principal, nested duplicates, etc.).
        // Shipment `ItemFeeList` + `ItemFeeAdjustmentList` via parseFinancesShipmentItemFeesSignedTotal is authoritative.
        const itemizedSignedSum =
          feeByOrderItemId.size > 0
            ? [...feeByOrderItemId.values()].reduce((a, b) => a + b, 0)
            : [...feeBySku.values()].reduce((a, b) => a + b, 0);
        if (Math.abs(itemizedSignedSum) > 1e-6) {
          amazonFeesTotal = itemizedSignedSum;
        } else if (
          Math.abs(recursiveSigned) > 1e-4 &&
          totalAmount > 0.01 &&
          Math.abs(recursiveSigned) > totalAmount * 0.35
        ) {
          // Per-line parser summed to ~0 but recursive FeeAmount is huge — that scan includes Principal /
          // non-fee rows. Never persist the raw recursive total in that situation.
          amazonFeesTotal = -Math.min(
            Math.abs(recursiveSigned),
            totalAmount * AmazonService.LIST_ORDERS_MAX_FEE_TO_REVENUE_RATIO,
          );
        }
      }

      // When we already have OrderItems for this order, fetch Finances if not yet done and backfill settled fee breakdown.
      if (!financesUnauthorized && existingOrderItemOrderIds.has(amazonOrderId)) {
        if (!finRes) {
          try {
            await new Promise((r) =>
              setTimeout(r, Math.max(300, Math.floor(orderFinancesPauseMs / 2))),
            );
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
              ...(events?.ShipmentEventList ?? events?.shipmentEventList ?? []),
              ...(events?.ShipmentSettleEventList ?? events?.shipmentSettleEventList ?? []),
              ...(events?.DeferredTransactionEventList ?? events?.deferredTransactionEventList ?? []),
              ...(events?.RefundEventList ?? events?.refundEventList ?? []),
              ...(events?.ChargebackEventList ?? events?.chargebackEventList ?? []),
              ...(events?.GuaranteeClaimEventList ?? events?.guaranteeClaimEventList ?? []),
            ];
            const extractEventItemList = (ev: any): any[] => {
              if (!ev || typeof ev !== 'object') return [];
              // Most events use ShipmentItemList. Deferred transactions can use DeferredTransactionItemList.
              const candidates = [
                ev.ShipmentItemList,
                ev.shipmentItemList,
                ev.DeferredTransactionItemList,
                ev.deferredTransactionItemList,
                ev.DeferredTransactionItemListV2,
                ev.deferredTransactionItemListV2,
                ev.ItemList,
                ev.itemList,
              ];
              for (const c of candidates) {
                if (Array.isArray(c)) return c;
              }
              return [];
            };
            for (const ev of shipmentLists) {
              const items = extractEventItemList(ev);
              for (const si of items) {
                const fee = parseFinancesShipmentItemFeesSignedTotal(si);
                const orderItemIdRaw = si?.OrderItemId ?? si?.orderItemId;
                const orderItemId = orderItemIdRaw != null ? String(orderItemIdRaw) : '';
                const sku = (si?.SellerSKU ?? si?.sellerSKU) as string | undefined;
                if (fee !== 0) {
                  if (orderItemId) addFee(feeByOrderItemId, orderItemId, fee);
                  if (sku) addFee(feeBySku, sku, fee);
                }
                const shipBd = parseFinancesShipmentItemFeesBreakdown(si);
                const { referral: r, fba: f, digital: d } = shipBd;
                if (orderItemId) addFeeBreakdown(breakdownByOrderItemId, orderItemId, r, f, d);
                if (sku) addFeeBreakdown(breakdownBySku, sku, r, f, d);
              }
            }

            // Some deferred orders have **zero** Finances v0 events but do appear in Finances 2024-06-19
            // `GET /finances/2024-06-19/transactions` with ORDER_ID. Fill fee maps from that payload so we
            // don't incorrectly copy from a prior same-ASIN sale.
            if (feeByOrderItemId.size === 0 && feeBySku.size === 0) {
              try {
                const mp =
                  credentials.region === 'eu'
                    ? 'A1F83G8C2ARO7P'
                    : credentials.region === 'fe'
                      ? 'A1VC38T7YXB528'
                      : 'ATVPDKIKX0DER';
                const { postedAfter, postedBefore } =
                  this.finances2024ListTransactionsMaxPostedWindowIso();
                const sweepStatuses = ['DEFERRED', 'DEFERRED_RELEASED', 'RELEASED'] as const;
                const txAgg: any[] = [];
                const seen = new Set<string>();
                const push = (arr: any[]) => {
                  for (const t of arr) {
                    const id = String(t?.transactionId ?? t?.TransactionId ?? '');
                    const key = id || JSON.stringify(t).slice(0, 400);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    txAgg.push(t);
                  }
                };
                for (const st of sweepStatuses) {
                  const r = await this.finances2024ListTransactionsFetchAllPages(credentials, {
                    marketplaceId: mp,
                    postedAfter,
                    postedBefore,
                    transactionStatus: st,
                    relatedIdentifierName: 'ORDER_ID',
                    relatedIdentifierValue: amazonOrderId,
                  });
                  push(r.transactions as any[]);
                  await new Promise<void>((r2) => setTimeout(r2, 250));
                }
                {
                  const r = await this.finances2024ListTransactionsFetchAllPages(credentials, {
                    marketplaceId: mp,
                    postedAfter,
                    postedBefore,
                    transactionStatus: null,
                    relatedIdentifierName: 'ORDER_ID',
                    relatedIdentifierValue: amazonOrderId,
                  });
                  push(r.transactions as any[]);
                }

                const readAmt = (node: any): number => {
                  const amtRaw =
                    node?.breakdownAmount?.currencyAmount ??
                    node?.breakdownAmount?.CurrencyAmount ??
                    node?.breakdownAmount?.Amount ??
                    node?.breakdownAmount?.amount ??
                    node?.breakdownAmount ??
                    node?.BreakdownAmount;
                  const amt = Number(amtRaw);
                  return Number.isFinite(amt) ? amt : 0;
                };
                // Avoid double-counting nested breakdown trees: for target types, take the node total and do not
                // descend into its children (the children usually sum to the same total).
                const sumTargetBreakdownTypes = (
                  node: any,
                  targetTypes: Set<string>,
                  out: Record<string, number>,
                ) => {
                  if (!node) return;
                  const t = String(node.breakdownType ?? node.BreakdownType ?? '').trim();
                  if (t && targetTypes.has(t)) {
                    const amt = readAmt(node);
                    if (Math.abs(amt) > 1e-9) out[t] = (out[t] ?? 0) + amt;
                    return;
                  }
                  const kids = node.breakdowns ?? node.Breakdowns;
                  if (Array.isArray(kids)) {
                    for (const k of kids) sumTargetBreakdownTypes(k, targetTypes, out);
                  }
                };

                for (const tx of txAgg) {
                  const items = Array.isArray(tx?.items) ? tx.items : Array.isArray(tx?.Items) ? tx.Items : [];
                  for (const it of items) {
                    const rel = Array.isArray(it?.relatedIdentifiers)
                      ? it.relatedIdentifiers
                      : Array.isArray(it?.RelatedIdentifiers)
                        ? it.RelatedIdentifiers
                        : [];
                    const idRow = rel.find(
                      (r: any) =>
                        String(r?.itemRelatedIdentifierName ?? r?.ItemRelatedIdentifierName ?? '') ===
                        'ORDER_ADJUSTMENT_ITEM_ID',
                    );
                    const orderItemId =
                      idRow?.itemRelatedIdentifierValue ?? idRow?.ItemRelatedIdentifierValue;
                    const ctx0 = Array.isArray(it?.contexts)
                      ? it.contexts[0]
                      : Array.isArray(it?.Contexts)
                        ? it.Contexts[0]
                        : null;
                    const sku = ctx0?.sku ?? ctx0?.Sku ?? null;
                    const breakdowns = Array.isArray(it?.breakdowns)
                      ? it.breakdowns
                      : Array.isArray(it?.Breakdowns)
                        ? it.Breakdowns
                        : [];
                    const targetTypes = new Set<string>([
                      'Commission',
                      'ReferralFee',
                      'FixedClosingFee',
                      'VariableClosingFee',
                      'PerItemFee',
                      'DigitalServicesFee',
                      'FBAPerUnitFulfillmentFee',
                      'FBAWeightBasedFee',
                      'FBAFulfillmentFee',
                    ]);
                    const sums: Record<string, number> = {};
                    for (const b of breakdowns) sumTargetBreakdownTypes(b, targetTypes, sums);
                    const digital = sums.DigitalServicesFee ?? 0;
                    const closing =
                      (sums.FixedClosingFee ?? 0) +
                      (sums.VariableClosingFee ?? 0) +
                      (sums.PerItemFee ?? 0);
                    const referral =
                      (sums.Commission ?? 0) + (sums.ReferralFee ?? 0) + closing;
                    const fba =
                      (sums.FBAPerUnitFulfillmentFee ?? 0) +
                      (sums.FBAWeightBasedFee ?? 0) +
                      (sums.FBAFulfillmentFee ?? 0);
                    const feeTotal = Number((digital + referral + fba).toFixed(2));
                    if (feeTotal === 0) continue;
                    const bid = { referral: Number(referral.toFixed(2)), fba: Number(fba.toFixed(2)), digital: Number(digital.toFixed(2)) };
                    if (orderItemId) {
                      addFee(feeByOrderItemId, String(orderItemId), feeTotal);
                      addFeeBreakdown(
                        breakdownByOrderItemId,
                        String(orderItemId),
                        bid.referral,
                        bid.fba,
                        bid.digital,
                      );
                    }
                    if (sku) {
                      addFee(feeBySku, String(sku), feeTotal);
                      addFeeBreakdown(breakdownBySku, String(sku), bid.referral, bid.fba, bid.digital);
                    }
                  }
                }
              } catch (e) {
                // ignore; we'll fall back to same-ASIN settled below if needed
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
            let inferredFromSameSettled = false;
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
                inferredFromSameSettled = true;
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
              feesSource: inferredFromSameSettled ? 'estimate_sold' : 'finances',
              amazonFeesTotal: Number((fee ?? 0).toFixed(2)),
              profit: vatResult.profit != null ? Number(vatResult.profit.toFixed(2)) : undefined,
            };
            if (bid) {
              if (inferredFromSameSettled) {
                updateData.atSaleEstimateReferralFeeTotal = Number(bid.referral.toFixed(2));
                updateData.atSaleEstimateFbaFeeTotal = Number(bid.fba.toFixed(2));
                updateData.atSaleEstimateDigitalServiceFeeTotal = Number(bid.digital.toFixed(2));
                updateData.settledReferralFeeTotal = null;
                updateData.settledFbaFeeTotal = null;
                updateData.settledDigitalServiceFeeTotal = null;
              } else {
                updateData.settledReferralFeeTotal = Number(bid.referral.toFixed(2));
                updateData.settledFbaFeeTotal = Number(bid.fba.toFixed(2));
                updateData.settledDigitalServiceFeeTotal = Number(bid.digital.toFixed(2));
              }
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
        amazonOrderStatus: apiOrderStatus,
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
        amazonOrderStatus: apiOrderStatus,
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
        ? await withPrismaTransientRetry<{ id: string }>(() =>
            (this.prisma as any).order.update({
              where: { id: existingOrderRow.id },
              data: updateData,
            }),
          )
        : await withPrismaTransientRetry<{ id: string }>(() =>
            (this.prisma as any).order.create({ data: createData }),
          );

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

        const clampOrderItemFeesToRevenue = (rev: number, fees: number): number => {
          if (!Number.isFinite(fees) || fees === 0) return fees;
          if (!Number.isFinite(rev) || rev <= 0) return fees;
          const maxAbs = Math.abs(rev * 0.95);
          if (Math.abs(fees) <= maxAbs) return fees;
          return fees < 0 ? -maxAbs : maxAbs;
        };

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

          let revenueTotal = lineRevenues[idx] ?? 0;
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
          // Attach to a real product for this SKU (needed for pre-sale fee estimates on the row).
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

          if (revenueTotal <= 0 && itemProduct) {
            const lp = (itemProduct as { currentListedPrice?: unknown }).currentListedPrice;
            const listNum = lp != null ? Number(lp) : 0;
            if (listNum > 0) {
              revenueTotal = Number((listNum * quantityOrdered).toFixed(2));
            }
          }

          const existingItem = await this.prisma.orderItem.findUnique({
            where: {
              orderDbId_orderItemId: {
                orderDbId: persistedOrder.id,
                orderItemId,
              },
            },
            select: {
              amazonFeesTotal: true,
              profit: true,
              feesSource: true,
              atSaleEstimateReferralFeeTotal: true,
              atSaleEstimateFbaFeeTotal: true,
              atSaleEstimateDigitalServiceFeeTotal: true,
            },
          });

          const feesFromFinancesForLine =
            (orderItemId && feeByOrderItemId.has(orderItemId)) ||
            (sku && feeBySku.has(sku)) ||
            usedSameAsinSettled ||
            usedOrderLevelFinances;

          const preserveFrozenEstimate =
            !feesFromFinancesForLine &&
            existingItem != null &&
            this.isPersistedAmazonFeeEstimateSource(existingItem.feesSource as string) &&
            existingItem.amazonFeesTotal != null &&
            Math.abs(Number(existingItem.amazonFeesTotal)) > 1e-9;

          let estimateSnapRef: number | null = null;
          let estimateSnapFba: number | null = null;
          let estimateSnapDig: number | null = null;

          if (preserveFrozenEstimate) {
            let preserved = Number(existingItem!.amazonFeesTotal);
            if (preserved > 0) preserved = -Math.abs(preserved);
            itemFees = preserved;
          } else if (itemFees === 0 && !usedSameAsinSettled) {
            const fromProd = this.orderItemFeeEstimateFromPreSaleProduct(
              itemProduct as {
                estimatedReferralFeePerUnit?: unknown;
                estimatedFbaFeePerUnit?: unknown;
                estimatedDigitalServiceFeePerUnit?: unknown;
                estimatedAmazonFeePerUnit?: unknown;
              },
              quantityOrdered,
            );
            if (fromProd != null) {
              itemFees = fromProd.itemFees;
              estimateSnapRef = fromProd.referralLine;
              estimateSnapFba = fromProd.fbaLine;
              estimateSnapDig = fromProd.digitalLine;
            } else if (sku) {
              const productWithEst = await this.prisma.product.findUnique({
                where: { userId_sku: { userId, sku } },
                select: {
                  estimatedReferralFeePerUnit: true,
                  estimatedFbaFeePerUnit: true,
                  estimatedDigitalServiceFeePerUnit: true,
                  estimatedAmazonFeePerUnit: true,
                },
              });
              const fromDb = this.orderItemFeeEstimateFromPreSaleProduct(
                productWithEst,
                quantityOrdered,
              );
              if (fromDb != null) {
                itemFees = fromDb.itemFees;
                estimateSnapRef = fromDb.referralLine;
                estimateSnapFba = fromDb.fbaLine;
                estimateSnapDig = fromDb.digitalLine;
              }
            }
          }

          const cogsPerUnit = itemProduct.costOfGoods
            ? Number(itemProduct.costOfGoods)
            : null;
          const cogsTotal =
            cogsPerUnit != null ? cogsPerUnit * quantityOrdered : null;
          const taxChargedNum = Number.isNaN(taxCharged) ? 0 : taxCharged;
          const feesFromFinances = feesFromFinancesForLine;
          const orderLineFeesSource = feesFromFinances ? 'finances' : 'estimate';
          // Product fee estimates are positive magnitudes; Finances totals are negative. Profit math always
          // expects fees ≤ 0 (`revenue - tax - cogs + fees`). Coerce any stray positive estimate before VAT.
          if (!feesFromFinances && itemFees > 0) {
            itemFees = -Math.abs(itemFees);
          }
          itemFees = clampOrderItemFeesToRevenue(revenueTotal, itemFees);
          let vatResult = this.computeOrderItemVatAndProfit(
            revenueTotal,
            cogsTotal,
            quantityOrdered,
            orderDate,
            itemFees,
            taxChargedNum,
            vatSettings,
          );
          const settledBreakdown =
            (orderItemId && breakdownByOrderItemId.get(orderItemId)) ??
            (sku && breakdownBySku.get(sku)) ??
            null;
          let finalFees = Number.isNaN(itemFees) ? 0 : Number(itemFees.toFixed(2));
          // Never overwrite a saved estimate with 0: keep existing order-item estimate until settled fees arrive.
          if (
            finalFees === 0 &&
            existingItem &&
            existingItem.amazonFeesTotal != null &&
            Number(existingItem.amazonFeesTotal) !== 0 &&
            this.isPersistedAmazonFeeEstimateSource(existingItem.feesSource as string)
          ) {
            finalFees = Number(existingItem.amazonFeesTotal);
            if (this.isPersistedAmazonFeeEstimateSource(existingItem.feesSource as string) && finalFees > 0) {
              finalFees = -Math.abs(finalFees);
            }
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
          // Finances: keep `amazonFeesTotal` identical to Ref+FBA+Dig so the UI and DB never disagree
          // (shipment signed total vs breakdown bucket sum can drift on odd fee types).
          if (
            feesFromFinances &&
            settledBreakdown &&
            Math.abs(
              settledBreakdown.referral +
                settledBreakdown.fba +
                settledBreakdown.digital,
            ) > 1e-6
          ) {
            const sumBd =
              settledBreakdown.referral +
              settledBreakdown.fba +
              settledBreakdown.digital;
            finalFees = Number(sumBd.toFixed(2));
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
          const updateFeeColumns =
            feesFromFinances || (existingItem?.feesSource as string) !== 'finances';
          const shouldUpdateFeeColumns = updateFeeColumns && !preserveFrozenEstimate;
          const breakdownSum = settledBreakdown
            ? settledBreakdown.referral + settledBreakdown.fba + settledBreakdown.digital
            : 0;
          const hasBreakdown = settledBreakdown && breakdownSum !== 0;
          const settledFeeFields =
            feesFromFinances && hasBreakdown && Math.abs(breakdownSum) > 1e-9
              ? {
                  settledReferralFeeTotal: Number(settledBreakdown!.referral.toFixed(2)),
                  settledFbaFeeTotal: Number(settledBreakdown!.fba.toFixed(2)),
                  settledDigitalServiceFeeTotal: Number(settledBreakdown!.digital.toFixed(2)),
                }
              : feesFromFinances
                ? {
                    settledReferralFeeTotal: null,
                    settledFbaFeeTotal: null,
                    settledDigitalServiceFeeTotal: null,
                  }
                : {};
          let estimateSnapshotPayload: Record<string, number | null> = {};
          if (shouldUpdateFeeColumns) {
            if (feesFromFinancesForLine) {
              estimateSnapshotPayload = {
                atSaleEstimateReferralFeeTotal: null,
                atSaleEstimateFbaFeeTotal: null,
                atSaleEstimateDigitalServiceFeeTotal: null,
              };
            } else if (orderLineFeesSource === 'estimate') {
              estimateSnapshotPayload = {
                atSaleEstimateReferralFeeTotal: estimateSnapRef,
                atSaleEstimateFbaFeeTotal: estimateSnapFba,
                atSaleEstimateDigitalServiceFeeTotal: estimateSnapDig,
              };
            }
          }
          const createEstimateSnapshots =
            orderLineFeesSource === 'estimate' && !feesFromFinancesForLine
              ? {
                  atSaleEstimateReferralFeeTotal: estimateSnapRef,
                  atSaleEstimateFbaFeeTotal: estimateSnapFba,
                  atSaleEstimateDigitalServiceFeeTotal: estimateSnapDig,
                }
              : feesFromFinancesForLine
                ? {
                    atSaleEstimateReferralFeeTotal: null,
                    atSaleEstimateFbaFeeTotal: null,
                    atSaleEstimateDigitalServiceFeeTotal: null,
                  }
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
            profit: finalProfit,
            ...(shouldUpdateFeeColumns
              ? {
                  amazonFeesTotal: finalFees,
                  feesSource: orderLineFeesSource,
                  ...settledFeeFields,
                  ...estimateSnapshotPayload,
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
              feesSource: orderLineFeesSource,
              ...settledFeeFields,
              ...createEstimateSnapshots,
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

      if (!financesUnauthorized) {
        const paceMs =
          days > 30
            ? orderFinancesPauseMs
            : shouldFetchFinances
              ? Math.max(200, Math.floor(orderFinancesPauseMs / 5))
              : 0;
        if (paceMs > 0) {
          await new Promise((r) => setTimeout(r, paceMs));
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

          let orderTotalAmt = this.parseOrderTotalAmountFromOrderJson(ord.rawResponse);
          if (orderTotalAmt <= 0) {
            orderTotalAmt = items.reduce(
              (s, item) => s + this.parseOrderItemLineRevenueFromRaw(item),
              0,
            );
          }
          const lineRevenues = this.computeLineRevenueTotals(items, orderTotalAmt);

          for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
            const it = items[itemIdx];
            const orderItemId = String(it?.OrderItemId ?? '');
            const sku = String(it?.SellerSKU ?? '');
            const asin = (it?.ASIN as string | undefined) ?? null;
            const qty = Number(it?.QuantityOrdered ?? 0);
            const quantityOrdered = qty > 0 ? qty : 1;
            let revenueTotal = lineRevenues[itemIdx] ?? 0;
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

            if (revenueTotal <= 0 && itemProduct) {
              const lp = (itemProduct as { currentListedPrice?: unknown }).currentListedPrice;
              const listNum = lp != null ? Number(lp) : 0;
              if (listNum > 0) {
                revenueTotal = Number((listNum * quantityOrdered).toFixed(2));
              }
            }

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

    try {
      await this.backfillZeroRevenueOrderItemsFromStoredTotals(userId);
    } catch {
      // non-fatal
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
        NOT: {
          amazonOrderStatus: { in: PRISMA_EXCLUDED_AMAZON_ORDER_STATUSES },
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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

    const notExcludedParentOrder = {
      NOT: {
        order: {
          amazonOrderStatus: { in: PRISMA_EXCLUDED_AMAZON_ORDER_STATUSES },
        },
      },
    };

    // 1) OrderItem: top by profit, then fill by units (exclude generic so real products + images show)
    const byProfit = await (this.prisma as any).orderItem.groupBy({
      by: ['productId'],
      where: {
        userId: { in: userIds },
        marketplace: 'amazon',
        ...dateFilter,
        profit: { not: null },
        ...notExcludedParentOrder,
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
          ...notExcludedParentOrder,
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
          ...notExcludedParentOrder,
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
            ...notExcludedParentOrder,
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
            NOT: {
              amazonOrderStatus: { in: PRISMA_EXCLUDED_AMAZON_ORDER_STATUSES },
            },
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);

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

  async getSmartReplenishmentSuggestions(
    orgId: string,
    opts: {
      take: number;
      marketplaceId?: string;
      velocityShortDays?: number;
      velocityLongDays?: number;
      profitDays?: number;
      targetDaysOfCover?: number;
      safetyDays?: number;
      minGrossProfitPerUnit?: number;
      minRoi?: number;
      casePack?: number;
      minOrderQty?: number;
      maxBuyUnits?: number;
      unknownDemandFloorPerDay?: number;
    },
  ): Promise<
    Array<{
      productId: string;
      sku: string;
      asin: string | null;
      title: string | null;
      imageUrl: string | null;
      fulfillableQty: number;
      inboundQty: number;
      effectiveStock: number;
      avgDailyUnitsShort: number;
      avgDailyUnitsLong: number;
      avgDailyUnits: number;
      daysOfCover: number | null;
      avgGrossProfitPerUnit: number | null;
      avgCogsPerUnit: number | null;
      roi: number | null;
      suggestedBuyQty: number;
      score: number;
      lastSold: string | null;
      /** Break-even max unit buy cost (sell - amazon fees). */
      maxBuyPriceBreakEvenPerUnit: number | null;
      /** Max unit buy cost to still satisfy profit+ROI gates. */
      maxBuyPriceForTargetsPerUnit: number | null;
      supplier: string | null;
      supplierLink: string | null;
      latestCogsEntry:
        | {
            purchaseDate: string;
            currency: string;
            vatRatePct: number;
            bundleSize: number;
            qtyPurchased: number;
            qtyDelivered: number;
            unitCostIncVat: number;
            deliveryCostIncVat: number;
            prepCostIncVat: number;
            totalCostIncVat: number;
          }
        | null;
      lastBuyUnitCostIncVat: number | null;
      expectedProfitPerUnitAtLastBuy: number | null;
      expectedProfitTotalAtLastBuy: number | null;
      rationale: string;
    }>
  > {
    const marketplaceFilter = this.resolveMarketplaceFilter(opts.marketplaceId);
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);

    const take = Math.max(1, Math.min(200, Number(opts.take) || 20));
    const velocityShortDays = Math.max(
      7,
      Math.min(180, Number(opts.velocityShortDays) || 30),
    );
    const velocityLongDays = Math.max(
      30,
      Math.min(730, Number(opts.velocityLongDays) || 365),
    );
    const profitDays = Math.max(7, Math.min(730, Number(opts.profitDays) || 365));
    const targetDaysOfCover = Math.max(
      7,
      Math.min(180, Number(opts.targetDaysOfCover) || 45),
    );
    const safetyDays = Math.max(0, Math.min(60, Number(opts.safetyDays) || 7));
    const minGrossProfitPerUnit = Number.isFinite(opts.minGrossProfitPerUnit)
      ? Number(opts.minGrossProfitPerUnit)
      : 0;
    const minRoi = Number.isFinite(opts.minRoi) ? Number(opts.minRoi) : 0;
    const casePack = Math.max(1, Number(opts.casePack) || 1);
    const minOrderQty = Math.max(1, Number(opts.minOrderQty) || 1);
    const maxBuyUnits = Math.max(1, Math.min(5000, Number(opts.maxBuyUnits) || 60));
    const unknownDemandFloorPerDay = Math.max(
      0,
      Number(opts.unknownDemandFloorPerDay) || 0.05,
    );

    const sinceShort = new Date(Date.now() - velocityShortDays * 24 * 60 * 60 * 1000);
    const sinceLong = new Date(Date.now() - velocityLongDays * 24 * 60 * 60 * 1000);
    const sinceProfit = new Date(Date.now() - profitDays * 24 * 60 * 60 * 1000);

    const [shortStats, longStats, profitStats] = await Promise.all([
      (this.prisma as any).orderItem.groupBy({
        by: ['asin'],
        where: {
          userId: { in: userIds },
          marketplace: marketplaceFilter,
          orderDate: { gte: sinceShort },
          asin: { not: null },
        },
        _sum: { quantity: true },
      }),
      (this.prisma as any).orderItem.groupBy({
        by: ['asin'],
        where: {
          userId: { in: userIds },
          marketplace: marketplaceFilter,
          orderDate: { gte: sinceLong },
          asin: { not: null },
        },
        _sum: { quantity: true },
      }),
      (this.prisma as any).orderItem.groupBy({
        by: ['asin'],
        where: {
          userId: { in: userIds },
          marketplace: marketplaceFilter,
          orderDate: { gte: sinceProfit },
          asin: { not: null },
        },
        _max: { orderDate: true },
        _sum: {
          quantity: true,
          profit: true,
          cogsTotal: true,
          revenueTotal: true,
          amazonFeesTotal: true,
        },
      }),
    ]);

    const mapSum = (rows: any[], field: string) => {
      const m = new Map<string, number>();
      for (const r of rows ?? []) {
        const asin = String(r.asin ?? '').trim();
        if (!asin) continue;
        m.set(asin, Number(r._sum?.[field] ?? 0));
      }
      return m;
    };
    const unitsShortByAsin = mapSum(shortStats, 'quantity');
    const unitsLongByAsin = mapSum(longStats, 'quantity');

    const profitByAsin = new Map<
      string,
      {
        units: number;
        profit: number;
        cogs: number;
        revenue: number;
        fees: number;
        lastSold: Date | null;
      }
    >();
    for (const r of profitStats ?? []) {
      const asin = String(r.asin ?? '').trim();
      if (!asin) continue;
      profitByAsin.set(asin, {
        units: Number(r._sum?.quantity ?? 0),
        profit: Number(r._sum?.profit ?? 0),
        cogs: Number(r._sum?.cogsTotal ?? 0),
        revenue: Number(r._sum?.revenueTotal ?? 0),
        fees: Number(r._sum?.amazonFeesTotal ?? 0),
        lastSold: (r as any)._max?.orderDate ?? null,
      });
    }

    const allAsins = new Set<string>();
    for (const a of unitsShortByAsin.keys()) allAsins.add(a);
    for (const a of unitsLongByAsin.keys()) allAsins.add(a);
    for (const a of profitByAsin.keys()) allAsins.add(a);
    if (allAsins.size === 0) return [];

    const asins = [...allAsins.values()];

    const products = await this.prisma.product.findMany({
      where: { userId: { in: userIds }, asin: { in: asins } },
      select: {
        id: true,
        sku: true,
        asin: true,
        title: true,
        imageUrl: true,
        costOfGoods: true,
      },
    });

    const productByAsin = new Map<
      string,
      { id: string; sku: string; asin: string; title: string | null; imageUrl: string | null; costOfGoods: number | null }
    >();
    for (const p of products) {
      const asin = String(p.asin ?? '').trim();
      if (!asin) continue;
      if (!productByAsin.has(asin)) {
        productByAsin.set(asin, {
          id: p.id,
          sku: p.sku,
          asin,
          title: p.title ?? null,
          imageUrl: p.imageUrl ?? null,
          costOfGoods: p.costOfGoods != null ? Number(p.costOfGoods) : null,
        });
      }
    }

    const ibmRows = await this.prisma.inventoryByMarketplace.findMany({
      where: {
        userId: { in: userIds },
        marketplaceId: opts.marketplaceId ?? undefined,
      },
      include: { product: { select: { asin: true } } },
    });
    const invByAsin = new Map<
      string,
      { fulfillable: number; inboundWorking: number; inboundShipped: number; inboundReceiving: number; inboundStored: number }
    >();
    for (const r of ibmRows ?? []) {
      const asin = String(r.product?.asin ?? '').trim();
      if (!asin) continue;
      const prev = invByAsin.get(asin) ?? {
        fulfillable: 0,
        inboundWorking: 0,
        inboundShipped: 0,
        inboundReceiving: 0,
        inboundStored: 0,
      };
      invByAsin.set(asin, {
        fulfillable: prev.fulfillable + Number((r as any).fulfillableQty ?? 0),
        inboundWorking: prev.inboundWorking + Number((r as any).inboundWorkingQty ?? 0),
        inboundShipped: prev.inboundShipped + Number((r as any).inboundShippedQty ?? 0),
        inboundReceiving: prev.inboundReceiving + Number((r as any).inboundReceivingQty ?? 0),
        inboundStored: prev.inboundStored + Number((r as any).inboundQty ?? 0),
      });
    }

    // Latest purchase per ASIN (supplier + unit cost).
    const purchaseRows = await this.prisma.purchase.findMany({
      where: {
        userId: { in: userIds },
        product: { asin: { in: asins } },
      },
      orderBy: [{ purchaseDate: 'desc' }, { updatedAt: 'desc' }],
      select: {
        supplier: true,
        supplierLink: true,
        bundleSize: true,
        qtyPurchased: true,
        qtyDelivered: true,
        currency: true,
        vatRatePct: true,
        unitCostIncVat: true,
        deliveryCostIncVat: true,
        prepCostIncVat: true,
        totalCostIncVat: true,
        purchaseDate: true,
        product: { select: { asin: true } },
      },
      take: 5000,
    });
    const latestPurchaseByAsin = new Map<
      string,
      {
        supplier: string | null;
        supplierLink: string | null;
        bundleSize: number;
        qtyPurchased: number;
        qtyDelivered: number;
        currency: string;
        vatRatePct: number;
        unitCostIncVat: number;
        deliveryCostIncVat: number;
        prepCostIncVat: number;
        totalCostIncVat: number;
        purchaseDateIso: string;
      }
    >();
    for (const pr of purchaseRows ?? []) {
      const asin = String(pr.product?.asin ?? '').trim();
      if (!asin) continue;
      if (latestPurchaseByAsin.has(asin)) continue;
      latestPurchaseByAsin.set(asin, {
        supplier: pr.supplier ? String(pr.supplier) : null,
        supplierLink: pr.supplierLink ? String(pr.supplierLink) : null,
        bundleSize: Math.max(1, Number(pr.bundleSize ?? 1)),
        qtyPurchased: Math.max(0, Number(pr.qtyPurchased ?? 0)),
        qtyDelivered: Math.max(0, Number(pr.qtyDelivered ?? 0)),
        currency: String(pr.currency ?? 'GBP'),
        vatRatePct: Number(pr.vatRatePct ?? 0),
        unitCostIncVat: Number(pr.unitCostIncVat ?? 0),
        deliveryCostIncVat: Number(pr.deliveryCostIncVat ?? 0),
        prepCostIncVat: Number(pr.prepCostIncVat ?? 0),
        totalCostIncVat: Number(pr.totalCostIncVat ?? 0),
        purchaseDateIso:
          pr.purchaseDate instanceof Date
            ? pr.purchaseDate.toISOString()
            : new Date(pr.purchaseDate as any).toISOString(),
      });
    }

    const out: Array<any> = [];
    for (const asin of asins) {
      const prod = productByAsin.get(asin);
      if (!prod) continue;

      const unitsVShort = Number(unitsShortByAsin.get(asin) ?? 0);
      const unitsVLong = Number(unitsLongByAsin.get(asin) ?? 0);
      const avgDailyShort = unitsVShort / Math.max(1, velocityShortDays);
      const avgDailyLong = unitsVLong / Math.max(1, velocityLongDays);
      let avgDaily = Math.max(avgDailyShort, avgDailyLong);
      if (avgDaily === 0) avgDaily = unknownDemandFloorPerDay;

      const inv = invByAsin.get(asin) ?? {
        fulfillable: 0,
        inboundWorking: 0,
        inboundShipped: 0,
        inboundReceiving: 0,
        inboundStored: 0,
      };
      const inboundStages =
        inv.inboundWorking + inv.inboundShipped + inv.inboundReceiving;
      const inboundQty = inboundStages > 0 ? inboundStages : inv.inboundStored;
      const effectiveStock = Math.max(0, inv.fulfillable + inboundQty);
      const coverDays = avgDaily > 0 ? effectiveStock / avgDaily : null;

      const p = (profitByAsin.get(asin) ?? {
        units: 0,
        profit: 0,
        cogs: 0,
        revenue: 0,
        fees: 0,
        lastSold: null as Date | null,
      }) as {
        units: number;
        profit: number;
        cogs: number;
        revenue: number;
        fees: number;
        lastSold: Date | null;
      };
      const unitsP = Number(p.units ?? 0);
      const avgProfitPerUnit = unitsP > 0 ? Number(p.profit ?? 0) / unitsP : 0;
      const avgCogsPerUnit = unitsP > 0 ? Number(p.cogs ?? 0) / unitsP : 0;
      const roi = avgCogsPerUnit > 0 ? avgProfitPerUnit / avgCogsPerUnit : null;

      const passesProfit = avgProfitPerUnit >= minGrossProfitPerUnit;
      const passesRoi = roi == null ? true : roi >= minRoi;
      if (!passesProfit || !passesRoi) continue;

      const targetStockUnits = avgDaily * (targetDaysOfCover + safetyDays);
      const netNeed = Math.max(0, targetStockUnits - effectiveStock);
      const rawBuy = Math.ceil(netNeed);
      let buyQty = 0;
      if (rawBuy > 0) {
        buyQty = Math.ceil(rawBuy / casePack) * casePack;
        buyQty = Math.max(minOrderQty, Math.min(maxBuyUnits, Math.round(buyQty)));
      }
      if (buyQty <= 0) continue;

      const coverScore = coverDays == null ? 0 : 1 / (1 + coverDays);
      const score = avgDaily * (1 + 3 * coverScore) * Math.max(0.01, avgProfitPerUnit);

      const avgRevenuePerUnit = unitsP > 0 ? Number(p.revenue ?? 0) / unitsP : null;
      const avgFeesPerUnitRaw = unitsP > 0 ? Number(p.fees ?? 0) / unitsP : null;
      // Some historical rows store amazonFeesTotal as NEGATIVE (common) while others store it POSITIVE.
      // Normalize to a signed "fees" value where fees are negative, so:
      // netAfterFees = revenue + feesSigned
      const feesSignedPerUnit =
        avgFeesPerUnitRaw == null
          ? null
          : avgFeesPerUnitRaw > 0
            ? -Math.abs(avgFeesPerUnitRaw)
            : avgFeesPerUnitRaw;
      const netAfterAmazonFeesPerUnit =
        avgRevenuePerUnit != null && feesSignedPerUnit != null
          ? avgRevenuePerUnit + feesSignedPerUnit
          : null;
      const maxBuyPriceBreakEvenPerUnit =
        netAfterAmazonFeesPerUnit != null
          ? Math.max(0, netAfterAmazonFeesPerUnit)
          : null;
      const maxBuyForMinProfit =
        netAfterAmazonFeesPerUnit != null
          ? netAfterAmazonFeesPerUnit - minGrossProfitPerUnit
          : null;
      const maxBuyForRoi =
        netAfterAmazonFeesPerUnit != null
          ? netAfterAmazonFeesPerUnit / (1 + Math.max(0, minRoi))
          : null;
      const maxBuyPriceForTargetsPerUnit =
        netAfterAmazonFeesPerUnit == null
          ? null
          : Math.max(
              0,
              Math.min(
                maxBuyForMinProfit ?? Infinity,
                maxBuyForRoi ?? Infinity,
              ),
            );

      const purchase = latestPurchaseByAsin.get(asin) ?? null;
      const lastBuyUnitCostIncVat =
        purchase && purchase.unitCostIncVat > 0
          ? purchase.unitCostIncVat + purchase.deliveryCostIncVat + purchase.prepCostIncVat
          : null;
      const expectedProfitPerUnitAtLastBuy =
        netAfterAmazonFeesPerUnit != null && lastBuyUnitCostIncVat != null
          ? netAfterAmazonFeesPerUnit - lastBuyUnitCostIncVat
          : null;
      const expectedProfitTotalAtLastBuy =
        expectedProfitPerUnitAtLastBuy != null
          ? Math.round(expectedProfitPerUnitAtLastBuy * buyQty * 100) / 100
          : null;

      const rationaleParts: string[] = [];
      rationaleParts.push(
        `demand=${(Math.round(avgDaily * 100) / 100).toFixed(2)}/day`,
      );
      rationaleParts.push(`stock=${inv.fulfillable} fulfillable + ${inboundQty} inbound`);
      if (coverDays != null) rationaleParts.push(`cover≈${Math.round(coverDays)}d`);

      out.push({
        productId: prod.id,
        sku: prod.sku,
        asin,
        title: prod.title,
        imageUrl: prod.imageUrl,
        fulfillableQty: inv.fulfillable,
        inboundQty,
        effectiveStock,
        avgDailyUnitsShort: Math.round(avgDailyShort * 1000) / 1000,
        avgDailyUnitsLong: Math.round(avgDailyLong * 1000) / 1000,
        avgDailyUnits: Math.round(avgDaily * 1000) / 1000,
        daysOfCover: coverDays != null ? Math.round(coverDays * 10) / 10 : null,
        avgGrossProfitPerUnit: unitsP > 0 ? Math.round(avgProfitPerUnit * 100) / 100 : null,
        avgCogsPerUnit:
          avgCogsPerUnit > 0 ? Math.round(avgCogsPerUnit * 100) / 100 : (prod.costOfGoods ?? null),
        roi: roi != null && Number.isFinite(roi) ? Math.round(roi * 100) / 100 : null,
        suggestedBuyQty: buyQty,
        score,
        lastSold: p.lastSold ? (p.lastSold as Date).toISOString() : null,
        maxBuyPriceBreakEvenPerUnit:
          maxBuyPriceBreakEvenPerUnit != null && Number.isFinite(maxBuyPriceBreakEvenPerUnit)
            ? Math.round(maxBuyPriceBreakEvenPerUnit * 100) / 100
            : null,
        maxBuyPriceForTargetsPerUnit:
          maxBuyPriceForTargetsPerUnit != null && Number.isFinite(maxBuyPriceForTargetsPerUnit)
            ? Math.round(maxBuyPriceForTargetsPerUnit * 100) / 100
            : null,
        supplier: purchase?.supplier ?? null,
        supplierLink: purchase?.supplierLink ?? null,
        latestCogsEntry: purchase
          ? {
              purchaseDate: purchase.purchaseDateIso,
              currency: purchase.currency,
              vatRatePct: purchase.vatRatePct,
              bundleSize: purchase.bundleSize,
              qtyPurchased: purchase.qtyPurchased,
              qtyDelivered: purchase.qtyDelivered,
              unitCostIncVat: purchase.unitCostIncVat,
              deliveryCostIncVat: purchase.deliveryCostIncVat,
              prepCostIncVat: purchase.prepCostIncVat,
              totalCostIncVat: purchase.totalCostIncVat,
            }
          : null,
        lastBuyUnitCostIncVat:
          lastBuyUnitCostIncVat != null && Number.isFinite(lastBuyUnitCostIncVat)
            ? Math.round(lastBuyUnitCostIncVat * 100) / 100
            : null,
        expectedProfitPerUnitAtLastBuy:
          expectedProfitPerUnitAtLastBuy != null && Number.isFinite(expectedProfitPerUnitAtLastBuy)
            ? Math.round(expectedProfitPerUnitAtLastBuy * 100) / 100
            : null,
        expectedProfitTotalAtLastBuy,
        rationale: rationaleParts.join(' • '),
      });
    }

    out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return out.slice(0, take);
  }

  /**
   * UK-only (`A1F83G8C2ARO7P`): one Listings Restrictions call per **distinct ASIN** for this user.
   * ASINs come from `products` and from `inventory_by_marketplace` → product (same ASIN deduped).
   * Does not change inventory, pricing, or fees — eligibility refresh only.
   */
  private async collectUkSellingEligibilityPairsFromUserListings(
    userId: string,
  ): Promise<Array<{ asin: string; marketplaceId: string }>> {
    const uk = AMAZON_UK_MARKETPLACE_ID_FOR_LISTINGS_RESTRICTIONS;
    const normAsin = (a: string | null | undefined) => {
      const t = String(a ?? '').trim().toUpperCase();
      return t.length > 0 ? t : null;
    };
    const byAsin = new Map<string, { asin: string; marketplaceId: string }>();
    const add = (asinRaw: string | null | undefined) => {
      const asin = normAsin(asinRaw);
      if (!asin) return;
      if (!byAsin.has(asin)) byAsin.set(asin, { asin, marketplaceId: uk });
    };

    const productRows = await this.prisma.product.findMany({
      where: { userId, asin: { not: null } },
      select: { asin: true },
    });
    for (const r of productRows) {
      add(r.asin);
    }

    const ibmRows = await this.prisma.inventoryByMarketplace.findMany({
      where: { userId },
      include: { product: { select: { asin: true } } },
    });
    for (const r of ibmRows) {
      add(r.product?.asin ?? null);
    }

    return [...byAsin.values()].sort((a, b) => a.asin.localeCompare(b.asin));
  }

  /**
   * Stored ASIN selling eligibility (Listings Restrictions). Optional filters for buyer bots (TTL, canRestock).
   */
  async listAsinSellingEligibilityForUser(
    userId: string,
    opts?: {
      canRestock?: boolean;
      maxAgeHours?: number;
      take?: number;
      /** When set, only rows for this marketplace id (e.g. UK `A1F83G8C2ARO7P`). */
      marketplaceId?: string;
    },
  ) {
    const take = Math.max(1, Math.min(5000, opts?.take ?? 2000));
    const where: Prisma.AsinSellingEligibilityWhereInput = { userId };
    const mpRaw = opts?.marketplaceId?.trim();
    where.marketplaceId =
      mpRaw && mpRaw.length > 0 ? mpRaw : AMAZON_UK_MARKETPLACE_ID_FOR_LISTINGS_RESTRICTIONS;
    if (opts?.canRestock === true) where.canRestock = true;
    if (opts?.canRestock === false) where.canRestock = false;
    if (opts?.maxAgeHours != null && Number.isFinite(opts.maxAgeHours)) {
      const minDate = new Date(Date.now() - Math.max(1, opts.maxAgeHours) * 3600000);
      where.checkedAt = { gte: minDate };
    }
    const rows = await this.prisma.asinSellingEligibility.findMany({
      where,
      orderBy: [{ checkedAt: 'desc' }, { asin: 'asc' }],
      take,
    });
    return rows.map((r) => ({
      id: r.id,
      asin: r.asin,
      marketplaceId: r.marketplaceId,
      canRestock: r.canRestock,
      checkedAt: r.checkedAt.toISOString(),
      source: r.source,
      notes: r.notes,
      hasRawJson: r.rawJson != null,
    }));
  }

  /**
   * Calls SP-API `getListingsRestrictions` per **distinct ASIN** on **Amazon.co.uk only**
   * (`A1F83G8C2ARO7P`), then upserts `asin_selling_eligibility`. Drops non-UK rows previously stored for this user.
   * Rate-limit friendly: uses a small delay between calls (override with `delayMs`).
   */
  async refreshAsinSellingEligibilityForUser(
    userId: string,
    opts?: {
      /** Max ASINs to refresh this run (default 5000, max 5000). If you have more distinct ASINs, run again after we add paging. */
      limit?: number;
      delayMs?: number;
      conditionType?: string;
    },
  ): Promise<{
    sellerId: string | null;
    pairsConsidered: number;
    successCount: number;
    errorCount: number;
    canRestockCount: number;
    blockedCount: number;
    samples: Array<{ asin: string; marketplaceId: string; canRestock: boolean; notes: string | null }>;
  }> {
    const limit = Math.max(1, Math.min(5000, opts?.limit ?? 5000));
    const delayMs = Math.max(0, Math.min(5000, opts?.delayMs ?? 250));
    const conditionType = opts?.conditionType ?? 'new_new';
    const uk = AMAZON_UK_MARKETPLACE_ID_FOR_LISTINGS_RESTRICTIONS;

    const account = await this.prisma.sellerAccount.findUnique({
      where: { userId_marketplace: { userId, marketplace: 'amazon' } },
      select: { sellerId: true },
    });
    if (!account?.sellerId?.trim()) {
      throw new NotFoundException('Amazon seller id missing; complete Amazon link first.');
    }
    const credentials = await this.getAmazonCredentialsForUser(userId);

    await this.prisma.asinSellingEligibility.deleteMany({
      where: { userId, marketplaceId: { not: uk } },
    });

    let pairs = await this.collectUkSellingEligibilityPairsFromUserListings(userId);
    pairs = pairs.slice(0, limit);

    const source = 'spapi_listings_restrictions_v2021_08_01';
    let errorCount = 0;
    let canRestockCount = 0;
    let blockedCount = 0;
    const samples: Array<{ asin: string; marketplaceId: string; canRestock: boolean; notes: string | null }> =
      [];

    for (let i = 0; i < pairs.length; i++) {
      const { asin, marketplaceId } = pairs[i];
      if (delayMs > 0 && i > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      try {
        const raw = await this.spApiClient.getListingsRestrictions(credentials, {
          asin,
          sellerId: account.sellerId,
          marketplaceIds: [marketplaceId],
          conditionType,
        });
        const { canRestock, notes } = eligibilityFromListingsRestrictionsBody(raw);
        if (canRestock) canRestockCount++;
        else blockedCount++;
        await this.prisma.asinSellingEligibility.upsert({
          where: {
            userId_marketplaceId_asin: { userId, marketplaceId, asin },
          },
          create: {
            userId,
            marketplaceId,
            asin,
            canRestock,
            checkedAt: new Date(),
            source,
            rawJson: raw as Prisma.InputJsonValue,
            notes,
          },
          update: {
            canRestock,
            checkedAt: new Date(),
            source,
            rawJson: raw as Prisma.InputJsonValue,
            notes,
          },
        });
        if (samples.length < 25) {
          samples.push({ asin, marketplaceId, canRestock, notes });
        }
      } catch (e) {
        errorCount++;
        const msg = e instanceof Error ? e.message : String(e);
        await this.prisma.asinSellingEligibility.upsert({
          where: {
            userId_marketplaceId_asin: { userId, marketplaceId, asin },
          },
          create: {
            userId,
            marketplaceId,
            asin,
            canRestock: false,
            checkedAt: new Date(),
            source: 'spapi_error',
            notes: `API error: ${msg.slice(0, 900)}`,
          },
          update: {
            canRestock: false,
            checkedAt: new Date(),
            source: 'spapi_error',
            notes: `API error: ${msg.slice(0, 900)}`,
          },
        });
        if (samples.length < 25) {
          samples.push({ asin, marketplaceId, canRestock: false, notes: `error: ${msg.slice(0, 120)}` });
        }
      }
    }

    return {
      sellerId: account.sellerId,
      pairsConsidered: pairs.length,
      successCount: pairs.length - errorCount,
      errorCount,
      canRestockCount,
      blockedCount,
      samples,
    };
  }

  async findUserIdByEmailForLocal(email: string): Promise<string | null> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;
    const u = await this.prisma.user.findFirst({
      where: { email: { equals: normalized, mode: 'insensitive' } },
      select: { id: true },
    });
    return u?.id ?? null;
  }

  async listProducts(orgId: string) {
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
    // Controller allows up to 500 for these list endpoints; keep service in sync.
    const take = Math.max(1, Math.min(500, opts?.take ?? 10));
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
   * Cost of Goods "All" tab: list every inventory SKU, enriched with:
   * - latestCostEntry (latest Purchase row per product, if any)
   * - productFallbackUnitCost (Product.costOfGoods when set but there is no Purchase row)
   *
   * Sorted by available stock (desc) then sales revenue (desc), paginated.
   */
  async listProductsWithCostInfoFromInventory(
    orgId: string,
    opts?: { take?: number; skip?: number },
    marketplaceId?: string,
  ): Promise<{
    total: number;
    items: Array<{
      id: string;
      sku: string;
      asin: string | null;
      title: string | null;
      imageUrl: string | null;
      latestCostEntry: {
        id: string;
        fulfilment: string;
        supplier: string | null;
        supplierLink: string | null;
        bundleSize: number;
        purchaseDate: string;
        orderNumber: string | null;
        shipmentId: string | null;
        qtyPurchased: number;
        qtyDelivered: number;
        currency: string;
        vatRatePct: number;
        unitCostIncVat: number;
        deliveryCostIncVat: number;
        prepCostIncVat: number;
        totalCostIncVat: number;
        product: {
          id: string;
          sku: string;
          asin: string | null;
          title: string | null;
          imageUrl: string | null;
        };
      } | null;
      productFallbackUnitCost: number | null;
    }>;
  }> {
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
    const total = inventoryProductIds.length;
    if (total === 0) return { total: 0, items: [] };

    const sortedIds = await this.sortProductIdsByStockAndRevenue(userIds, inventoryProductIds);
    const pageIds = sortedIds.slice(skip, skip + take);
    if (pageIds.length === 0) return { total, items: [] };

    const products = await this.prisma.product.findMany({
      where: { id: { in: pageIds } },
      select: { id: true, sku: true, asin: true, title: true, imageUrl: true, costOfGoods: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

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

    type LatestPurRow = {
      id: string;
      product_id: string;
      fulfilment: string;
      supplier: string | null;
      supplier_link: string | null;
      bundle_size: number;
      purchase_date: Date;
      order_number: string | null;
      shipment_id: string | null;
      qty_purchased: number;
      qty_delivered: number;
      currency: string;
      vat_rate_pct: unknown;
      unit_cost_inc_vat: unknown;
      delivery_cost_inc_vat: unknown;
      prep_cost_inc_vat: unknown;
      total_cost_inc_vat: unknown;
    };

    const latestRows =
      pageIds.length > 0 && userIds.length > 0
        ? await this.prisma.$queryRaw<LatestPurRow[]>(Prisma.sql`
            SELECT DISTINCT ON (p.product_id)
              p.id,
              p.product_id,
              p.fulfilment,
              p.supplier,
              p.supplier_link,
              p.bundle_size,
              p.purchase_date,
              p.order_number,
              p.shipment_id,
              p.qty_purchased,
              p.qty_delivered,
              p.currency,
              p.vat_rate_pct,
              p.unit_cost_inc_vat,
              p.delivery_cost_inc_vat,
              p.prep_cost_inc_vat,
              p.total_cost_inc_vat
            FROM purchases p
            WHERE p.product_id IN (${Prisma.join(pageIds)})
              AND p.user_id IN (${Prisma.join(userIds)})
            ORDER BY p.product_id, p.purchase_date DESC, p.updated_at DESC
          `)
        : [];

    const latestByProduct = new Map<string, LatestPurRow>();
    for (const r of latestRows) {
      latestByProduct.set(r.product_id, r);
    }

    const items = pageIds.map((id) => {
      const p = byId.get(id);
      const base = p ?? {
        id,
        sku: id,
        asin: null as string | null,
        title: null as string | null,
        imageUrl: null as string | null,
        costOfGoods: null as any,
      };

      const row = latestByProduct.get(id);
      if (row) {
        return {
          id: base.id,
          sku: base.sku,
          asin: base.asin,
          title: base.title,
          imageUrl: base.imageUrl,
          latestCostEntry: {
            id: row.id,
            fulfilment: row.fulfilment,
            supplier: row.supplier,
            supplierLink: row.supplier_link,
            bundleSize: row.bundle_size,
            purchaseDate: row.purchase_date.toISOString(),
            orderNumber: row.order_number,
            shipmentId: row.shipment_id,
            qtyPurchased: row.qty_purchased,
            qtyDelivered: row.qty_delivered,
            currency: row.currency,
            vatRatePct: toNum(row.vat_rate_pct),
            unitCostIncVat: toNum(row.unit_cost_inc_vat),
            deliveryCostIncVat: toNum(row.delivery_cost_inc_vat),
            prepCostIncVat: toNum(row.prep_cost_inc_vat),
            totalCostIncVat: toNum(row.total_cost_inc_vat),
            product: {
              id: base.id,
              sku: base.sku,
              asin: base.asin,
              title: base.title,
              imageUrl: base.imageUrl,
            },
          },
          productFallbackUnitCost: null as number | null,
        };
      }

      const fb = toNum((base as any).costOfGoods);
      return {
        id: base.id,
        sku: base.sku,
        asin: base.asin,
        title: base.title,
        imageUrl: base.imageUrl,
        latestCostEntry: null,
        productFallbackUnitCost: fb != null && fb > 0 ? Number(fb.toFixed(2)) : null,
      };
    });

    return { total, items };
  }

  /**
   * List inventory SKUs that have at least one cost entry (Purchase row or Product.costOfGoods > 0).
   * Paginated for the "Complete" tab. Includes latest purchase row per SKU when present (for UI).
   */
  async listProductsWithCostFromInventory(
    orgId: string,
    opts?: { take?: number; skip?: number },
    marketplaceId?: string,
  ): Promise<{
    total: number;
    items: Array<{
      id: string;
      sku: string;
      asin: string | null;
      title: string | null;
      imageUrl: string | null;
      latestCostEntry: {
        id: string;
        fulfilment: string;
        supplier: string | null;
        supplierLink: string | null;
        bundleSize: number;
        purchaseDate: string;
        orderNumber: string | null;
        shipmentId: string | null;
        qtyPurchased: number;
        qtyDelivered: number;
        currency: string;
        vatRatePct: number;
        unitCostIncVat: number;
        deliveryCostIncVat: number;
        prepCostIncVat: number;
        totalCostIncVat: number;
        product: {
          id: string;
          sku: string;
          asin: string | null;
          title: string | null;
          imageUrl: string | null;
        };
      } | null;
      /** When there is no purchase row but Product.costOfGoods is set */
      productFallbackUnitCost: number | null;
    }>;
  }> {
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
    // Controller allows up to 500 for these list endpoints; keep service in sync.
    const take = Math.max(1, Math.min(500, opts?.take ?? 10));
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

    const cogsByProductId = new Map<string, number>();
    for (const row of productsWithCogs) {
      if (pageIds.includes(row.id)) {
        cogsByProductId.set(row.id, toNum(row.costOfGoods));
      }
    }

    type LatestPurRow = {
      id: string;
      product_id: string;
      fulfilment: string;
      supplier: string | null;
      supplier_link: string | null;
      bundle_size: number;
      purchase_date: Date;
      order_number: string | null;
      shipment_id: string | null;
      qty_purchased: number;
      qty_delivered: number;
      currency: string;
      vat_rate_pct: unknown;
      unit_cost_inc_vat: unknown;
      delivery_cost_inc_vat: unknown;
      prep_cost_inc_vat: unknown;
      total_cost_inc_vat: unknown;
    };

    const latestRows =
      pageIds.length > 0 && userIds.length > 0
        ? await this.prisma.$queryRaw<LatestPurRow[]>(Prisma.sql`
            SELECT DISTINCT ON (p.product_id)
              p.id,
              p.product_id,
              p.fulfilment,
              p.supplier,
              p.supplier_link,
              p.bundle_size,
              p.purchase_date,
              p.order_number,
              p.shipment_id,
              p.qty_purchased,
              p.qty_delivered,
              p.currency,
              p.vat_rate_pct,
              p.unit_cost_inc_vat,
              p.delivery_cost_inc_vat,
              p.prep_cost_inc_vat,
              p.total_cost_inc_vat
            FROM purchases p
            WHERE p.product_id IN (${Prisma.join(pageIds)})
              AND p.user_id IN (${Prisma.join(userIds)})
            ORDER BY p.product_id, p.purchase_date DESC, p.updated_at DESC
          `)
        : [];

    const latestByProduct = new Map<string, LatestPurRow>();
    for (const r of latestRows) {
      latestByProduct.set(r.product_id, r);
    }

    const items = pageIds.map((id) => {
      const p = byId.get(id);
      const base = p ?? {
        id,
        sku: id,
        asin: null as string | null,
        title: null as string | null,
        imageUrl: null as string | null,
      };
      const row = latestByProduct.get(id);
      if (row) {
        return {
          id: base.id,
          sku: base.sku,
          asin: base.asin,
          title: base.title,
          imageUrl: base.imageUrl,
          latestCostEntry: {
            id: row.id,
            fulfilment: row.fulfilment,
            supplier: row.supplier,
            supplierLink: row.supplier_link,
            bundleSize: row.bundle_size,
            purchaseDate: row.purchase_date.toISOString(),
            orderNumber: row.order_number,
            shipmentId: row.shipment_id,
            qtyPurchased: row.qty_purchased,
            qtyDelivered: row.qty_delivered,
            currency: row.currency,
            vatRatePct: toNum(row.vat_rate_pct),
            unitCostIncVat: toNum(row.unit_cost_inc_vat),
            deliveryCostIncVat: toNum(row.delivery_cost_inc_vat),
            prepCostIncVat: toNum(row.prep_cost_inc_vat),
            totalCostIncVat: toNum(row.total_cost_inc_vat),
            product: {
              id: base.id,
              sku: base.sku,
              asin: base.asin,
              title: base.title,
              imageUrl: base.imageUrl,
            },
          },
          productFallbackUnitCost: null as number | null,
        };
      }
      const fb = cogsByProductId.get(id);
      return {
        id: base.id,
        sku: base.sku,
        asin: base.asin,
        title: base.title,
        imageUrl: base.imageUrl,
        latestCostEntry: null,
        productFallbackUnitCost:
          fb != null && fb > 0 ? Number(fb.toFixed(2)) : null,
      };
    });
    return { total, items };
  }

  async updateProductCostOfGoods(
    orgId: string,
    productId: string,
    costOfGoods: number | null,
  ) {
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
          feesSource: true,
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
        let amazonFeesTotal = Number(it.amazonFeesTotal ?? 0);
        let correctedEstimateFees: number | undefined;
        if (
          this.isPersistedAmazonFeeEstimateSource(it.feesSource as string) &&
          amazonFeesTotal > 0
        ) {
          amazonFeesTotal = -Math.abs(amazonFeesTotal);
          correctedEstimateFees = amazonFeesTotal;
        }

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
            ...(correctedEstimateFees != null
              ? { amazonFeesTotal: correctedEstimateFees }
              : {}),
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
      const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
   * Dev-only: call SP-API Orders `getOrders` for ~N months, sum `OrderTotal` and compare to DB revenue totals.
   * No persistence; intended for “does DB roughly match Amazon?” checks.
   */
  async getAmazonRevenueComparisonLive(
    orgId: string,
    userId: string,
    months: number = 13,
  ): Promise<{
    window: { start: string; end: string; months: number };
    amazon: {
      orderCount: number;
      orderCountNonCanceled: number;
      currencyCounts: Record<string, number>;
      orderTotalSum: number;
      orderTotalSumNonCanceled: number;
      sampleOrderIds: string[];
    };
    db: {
      aggregateUserIds: string[];
      orderItemCount: number;
      revenueSumSigned: number;
      revenueSumPositiveOnly: number;
      distinctOrderIds: number;
    };
  }> {
    const monthsSafe = Math.min(18, Math.max(1, Math.floor(Number(months) || 13)));
    const end = new Date(Date.now() - 5 * 60 * 1000);
    const start = new Date(end);
    start.setMonth(start.getMonth() - monthsSafe);
    const startIso = start.toISOString().split('.')[0] + 'Z';
    const endIso = end.toISOString().split('.')[0] + 'Z';

    const credentials = await this.getAmazonCredentialsForUser(userId);
    // Match the test fetch: keep it single-marketplace for EU so totals are stable.
    const marketplaceIds =
      credentials.region === 'eu'
        ? ['A1F83G8C2ARO7P']
        : credentials.region === 'na'
          ? ['ATVPDKIKX0DER']
          : ['A1VC38T7YXB528'];

    const parseOrders = (d: any): any[] => {
      const p = d?.payload ?? d?.Payload ?? d;
      const list = p?.Orders ?? p?.orders;
      return Array.isArray(list) ? list : [];
    };
    const getNextToken = (d: any): string | undefined => {
      const p = d?.payload ?? d?.Payload ?? d;
      return p?.NextToken ?? undefined;
    };
    const readOrderTotal = (o: any): { amt: number; ccy: string } | null => {
      const ot = o?.OrderTotal ?? o?.orderTotal;
      if (!ot) return null;
      const raw = ot?.Amount ?? ot?.amount ?? ot?.CurrencyAmount ?? ot?.currencyAmount;
      const ccy = String(ot?.CurrencyCode ?? ot?.currencyCode ?? '').trim();
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      return { amt: n, ccy: ccy || 'UNKNOWN' };
    };

    // Pull pages with CreatedAfter/CreatedBefore. Keep pacing to avoid 429 in local runs.
    const orders: any[] = [];
    let next: string | undefined;
    do {
      const res = await this.spApiClient.getOrders(credentials, next ? { nextToken: next } : {
        createdAfter: startIso,
        createdBefore: endIso,
        marketplaceIds,
      });
      const page = parseOrders(res);
      orders.push(...page);
      next = getNextToken(res);
      if (next) await new Promise((r) => setTimeout(r, 450));
    } while (next);

    let orderTotalSum = 0;
    let orderTotalSumNonCanceled = 0;
    let orderCountNonCanceled = 0;
    const currencyCounts: Record<string, number> = {};
    for (const o of orders) {
      const t = readOrderTotal(o);
      if (t) {
        orderTotalSum += t.amt;
        currencyCounts[t.ccy] = (currencyCounts[t.ccy] ?? 0) + 1;
        const st = String(o?.OrderStatus ?? o?.orderStatus ?? '').trim().toLowerCase();
        if (st !== 'canceled' && st !== 'cancelled') {
          orderTotalSumNonCanceled += t.amt;
          orderCountNonCanceled += 1;
        }
      }
    }

    // DB side: sum revenueTotal on order_items within the same window for org aggregate users.
    const aggUserIds = await this.getOrgAmazonAggregateUserIds(orgId);
    const dbRows = await this.prisma.orderItem.findMany({
      where: {
        userId: { in: aggUserIds },
        marketplace: 'amazon',
        orderDate: { gte: start, lte: end },
      },
      select: { revenueTotal: true, orderId: true },
    });
    let revenueSumSigned = 0;
    let revenueSumPositiveOnly = 0;
    const distinctOrderIds = new Set<string>();
    for (const r of dbRows) {
      const v = Number((r as any).revenueTotal ?? 0);
      if (Number.isFinite(v)) {
        revenueSumSigned += v;
        if (v > 0) revenueSumPositiveOnly += v;
      }
      const oid = String((r as any).orderId ?? '').trim();
      if (oid) distinctOrderIds.add(oid);
    }

    return {
      window: { start: startIso, end: endIso, months: monthsSafe },
      amazon: {
        orderCount: orders.length,
        orderCountNonCanceled,
        currencyCounts,
        orderTotalSum: Number(orderTotalSum.toFixed(2)),
        orderTotalSumNonCanceled: Number(orderTotalSumNonCanceled.toFixed(2)),
        sampleOrderIds: orders
          .slice(0, 8)
          .map((o) => String(o?.AmazonOrderId ?? '').trim())
          .filter(Boolean),
      },
      db: {
        aggregateUserIds: aggUserIds,
        orderItemCount: dbRows.length,
        revenueSumSigned: Number(revenueSumSigned.toFixed(2)),
        revenueSumPositiveOnly: Number(revenueSumPositiveOnly.toFixed(2)),
        distinctOrderIds: distinctOrderIds.size,
      },
    };
  }

  /**
   * Dev-only helper for local debugging when auth headers are inconvenient:
   * picks a linked Amazon user under the org and runs {@link getAmazonRevenueComparisonLive}.
   */
  async getAmazonRevenueComparisonLiveForOrg(
    orgId: string,
    months: number = 13,
    preferredUserId?: string,
  ) {
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
    const withAccount = await this.prisma.sellerAccount.findFirst({
      where: {
        userId:
          userIds.length && preferredUserId && userIds.includes(preferredUserId)
            ? preferredUserId
            : { in: userIds },
        marketplace: 'amazon',
        isActive: true,
      },
      select: { userId: true },
    });
    if (!withAccount?.userId) {
      return {
        error:
          'No linked Amazon seller account found for this org. Use an orgId that has Amazon linked, or pass userId=... for a linked user.',
        window: { start: '', end: '', months: Math.min(18, Math.max(1, Math.floor(Number(months) || 13))) },
        amazon: {
          orderCount: 0,
          orderCountNonCanceled: 0,
          currencyCounts: {},
          orderTotalSum: 0,
          orderTotalSumNonCanceled: 0,
          sampleOrderIds: [],
        },
        db: {
          aggregateUserIds: userIds,
          orderItemCount: 0,
          revenueSumSigned: 0,
          revenueSumPositiveOnly: 0,
          distinctOrderIds: 0,
        },
      };
    }
    return this.getAmazonRevenueComparisonLive(orgId, withAccount.userId, months);
  }

  /** Dev-only helper: which org members have linked Amazon accounts (for localhost debug endpoints). */
  async getLinkedAmazonAccountsLocal(): Promise<
    Array<{
      orgId: string;
      userId: string;
      email: string;
      sellerId: string | null;
      ordersLastSyncedAt: string | null;
    }>
  > {
    const accounts = await this.prisma.sellerAccount.findMany({
      where: { marketplace: 'amazon', isActive: true },
      select: {
        userId: true,
        sellerId: true,
        ordersLastSyncedAt: true,
        user: {
          select: {
            email: true,
            orgMemberships: { select: { orgId: true } },
          },
        },
      },
    });
    const out: Array<{
      orgId: string;
      userId: string;
      email: string;
      sellerId: string | null;
      ordersLastSyncedAt: string | null;
    }> = [];
    for (const a of accounts as any[]) {
      const email = String(a?.user?.email ?? '');
      const orgIds: string[] = Array.isArray(a?.user?.orgMemberships)
        ? a.user.orgMemberships.map((m: any) => String(m?.orgId ?? '')).filter(Boolean)
        : [];
      for (const orgId of orgIds.length ? orgIds : ['']) {
        out.push({
          orgId,
          userId: String(a.userId),
          email,
          sellerId: a.sellerId != null ? String(a.sellerId) : null,
          ordersLastSyncedAt:
            a.ordersLastSyncedAt instanceof Date
              ? a.ordersLastSyncedAt.toISOString()
              : a.ordersLastSyncedAt != null
                ? String(a.ordersLastSyncedAt)
                : null,
        });
      }
    }
    return out
      .filter((r) => r.orgId)
      .sort((a, b) => (a.orgId + a.userId).localeCompare(b.orgId + b.userId));
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
      userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
   * Dev-only: one Amazon order — raw `order_items` fee columns vs `listOrders` mapping (what the UI uses).
   * Call while logged in (same session as the app). No SP-API call; pure DB + in-app mapping.
   */
  async getOrderFeeSanityDebug(
    orgId: string,
    amazonOrderId: string,
    marketplaceId?: string,
  ): Promise<{
    orgId: string;
    amazonOrderId: string;
    aggregateUserIds: string[];
    summary: { ok: boolean; message: string };
    dbLines: Array<Record<string, unknown>>;
    listOrdersLines: Array<Record<string, unknown>>;
    checks: string[];
  }> {
    const checks: string[] = [];
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
    const oid = String(amazonOrderId || '').trim();
    if (!oid) {
      return {
        orgId,
        amazonOrderId: oid,
        aggregateUserIds: userIds,
        summary: { ok: false, message: 'Missing amazonOrderId' },
        dbLines: [],
        listOrdersLines: [],
        checks: ['Pass amazonOrderId query, e.g. 204-9599325-7606713'],
      };
    }
    const items = await this.prisma.orderItem.findMany({
      where: {
        userId: { in: userIds },
        marketplace: 'amazon',
        orderId: oid,
      },
      select: {
        id: true,
        userId: true,
        orderItemId: true,
        sku: true,
        asin: true,
        revenueTotal: true,
        amazonFeesTotal: true,
        feesSource: true,
        settledReferralFeeTotal: true,
        settledFbaFeeTotal: true,
        settledDigitalServiceFeeTotal: true,
        quantity: true,
        orderDate: true,
      },
      orderBy: { orderDate: 'desc' },
    });
    if (items.length === 0) {
      checks.push(
        'No order_items for this orderId under org aggregate user(s). Sync/backfill may not have written this order yet.',
      );
    }
    const normNeg = (v: unknown): number => {
      const n = Number(v ?? 0);
      if (!Number.isFinite(n)) return 0;
      if (n === 0) return 0;
      return n > 0 ? -Math.abs(n) : n;
    };
    const dbLines = items.map((it) => {
      const fee = normNeg(it.amazonFeesTotal);
      const r = normNeg(it.settledReferralFeeTotal);
      const f = normNeg(it.settledFbaFeeTotal);
      const d = normNeg(it.settledDigitalServiceFeeTotal);
      const sum = r + f + d;
      const delta = Math.abs(sum - fee);
      if (it.feesSource === 'finances' && delta > 0.05 && Math.abs(sum) > 1e-4) {
        checks.push(
          `DB line ${it.id}: breakdown sum ${sum.toFixed(2)} vs amazonFeesTotal ${fee.toFixed(2)} (Δ ${delta.toFixed(2)})`,
        );
      }
      return {
        id: it.id,
        orderItemId: it.orderItemId,
        userId: it.userId,
        sku: it.sku,
        asin: it.asin,
        revenueTotal: it.revenueTotal != null ? Number(it.revenueTotal) : null,
        amazonFeesTotal: it.amazonFeesTotal != null ? Number(it.amazonFeesTotal) : null,
        feesSource: it.feesSource,
        settledReferralFeeTotal: it.settledReferralFeeTotal,
        settledFbaFeeTotal: it.settledFbaFeeTotal,
        settledDigitalServiceFeeTotal: it.settledDigitalServiceFeeTotal,
        dbBreakdownSumSigned: Number(sum.toFixed(2)),
        dbBreakdownVsTotalDelta: Number(delta.toFixed(4)),
      };
    });

    let listOrdersLines: Array<Record<string, unknown>> = [];
    try {
      const all = await this.listOrders(orgId, marketplaceId);
      listOrdersLines = all
        .filter((row) => row.orderId === oid)
        .map((row) => ({
          id: row.id,
          orderId: row.orderId,
          sku: row.sku,
          amazonFeesTotal: row.amazonFeesTotal,
          referralFeeTotal: row.referralFeeTotal,
          fbaFeeTotal: row.fbaFeeTotal,
          digitalServiceFeeTotal: row.digitalServiceFeeTotal,
          feesSource: row.feesSource,
          salePrice: row.salePrice,
        }));
      if (listOrdersLines.length === 0 && items.length > 0) {
        checks.push(
          'listOrders returned no rows for this orderId (marketplace filter, dedupe, or data user mismatch).',
        );
      }
      for (const it of items) {
        const lo = listOrdersLines.find((r) => String(r.id) === String(it.id));
        if (!lo) {
          checks.push(`DB order_item id=${it.id} missing from listOrders output for this order.`);
          continue;
        }
        const dbFee = normNeg(it.amazonFeesTotal);
        const loFee = Number((lo as { amazonFeesTotal?: unknown }).amazonFeesTotal ?? 0);
        if (Math.abs(dbFee - loFee) > 0.05) {
          checks.push(
            `Line id=${it.id}: DB amazonFeesTotal ${dbFee} vs listOrders ${loFee}`,
          );
        }
      }
    } catch (e) {
      checks.push(`listOrders failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const ok = checks.length === 0;
    return {
      orgId,
      amazonOrderId: oid,
      aggregateUserIds: userIds,
      summary: {
        ok,
        message: ok
          ? 'Checks passed (≤£0.05 drift): DB breakdown vs total, listOrders vs DB fee.'
          : checks.slice(0, 10).join(' | ') + (checks.length > 10 ? ' …' : ''),
      },
      dbLines,
      listOrdersLines,
      checks,
    };
  }

  private extractFinancesListNextToken(res: unknown): string | undefined {
    if (!res || typeof res !== 'object') return undefined;
    const r = res as Record<string, unknown>;
    const p = (r.payload ?? r.Payload ?? r) as Record<string, unknown>;
    if (p && typeof p === 'object') {
      const nt = p.NextToken ?? p.nextToken;
      if (typeof nt === 'string' && nt.length > 0) return nt;
    }
    const top = r.NextToken ?? r.nextToken;
    if (typeof top === 'string' && top.length > 0) return top;
    return undefined;
  }

  private getFinancialEventsBucket(res: unknown): Record<string, unknown> | null {
    if (!res || typeof res !== 'object') return null;
    const r = res as Record<string, unknown>;
    const p = (r.payload ?? r.Payload ?? r) as Record<string, unknown>;
    if (!p || typeof p !== 'object') return null;
    const fe = p.FinancialEvents ?? p.financialEvents;
    if (!fe || typeof fe !== 'object' || Array.isArray(fe)) return null;
    return fe as Record<string, unknown>;
  }

  /** Concatenate `FinancialEvents.*EventList` arrays across Finances pages (same order id). */
  private mergeFinancesPagesFinancialEvents(accum: unknown, page: unknown): void {
    const accFe = this.getFinancialEventsBucket(accum);
    const pageFe = this.getFinancialEventsBucket(page);
    if (!accFe || !pageFe) return;
    for (const [k, v] of Object.entries(pageFe)) {
      if (!Array.isArray(v) || v.length === 0) continue;
      if (!Array.isArray(accFe[k])) accFe[k] = [];
      (accFe[k] as unknown[]).push(...v);
    }
  }

  /**
   * Finances v0 listFinancialEventsByOrderId — all pages merged into one payload-shaped object.
   * Adds `__debugFigure` on objects that carry FeeAmount / Principal / ChargeAmount so humans see figures inline.
   */
  private injectFinancesMoneyDebugFigures(node: unknown): unknown {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((x) => this.injectFinancesMoneyDebugFigures(x));
    const o = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = this.injectFinancesMoneyDebugFigures(v);
    }
    const fig = this.readFinancesLeafMoneyLabel(out);
    if (fig) out.__debugFigure = fig;
    return out;
  }

  private readFinancesLeafMoneyLabel(o: Record<string, unknown>): string | null {
    const pack = (block: unknown): string | null => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
      const b = block as Record<string, unknown>;
      const raw = b.CurrencyAmount ?? b.currencyAmount ?? b.Amount ?? b.amount;
      const ccy = String(b.CurrencyCode ?? b.currencyCode ?? '').trim();
      const n = Number(raw);
      if (!Number.isFinite(n) || Math.abs(n) < 1e-9) return null;
      return ccy ? `${n.toFixed(2)} ${ccy}` : String(n.toFixed(2));
    };
    const ft = o.FeeType ?? o.feeType ?? o.ChargeType ?? o.chargeType ?? o.Type ?? o.type;
    const fa = pack(o.FeeAmount ?? o.feeAmount);
    if (fa) return ft ? `${fa} (${String(ft)})` : fa;
    const pr = pack(o.Principal ?? o.principal);
    if (pr) return `Principal ${pr}`;
    const ch = pack(o.ChargeAmount ?? o.chargeAmount);
    if (ch) return ft ? `${ch} (${String(ft)})` : ch;
    const ship = pack(o.ShippingCharge ?? o.shippingCharge);
    if (ship) return `ShippingCharge ${ship}`;
    const top = pack(o);
    if (top) return ft ? `${top} (${String(ft)})` : top;
    return null;
  }

  /** Read a Finances v0 `Currency` block (or plain number) as a scalar amount. */
  private readFinancesCurrencyAmount(block: unknown): number {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return 0;
    const b = block as Record<string, unknown>;
    let raw: unknown =
      b.CurrencyAmount ??
      b.currencyAmount ??
      b.Amount ??
      b.amount;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const nested = raw as Record<string, unknown>;
      raw =
        nested.Amount ??
        nested.amount ??
        nested.CurrencyAmount ??
        nested.currencyAmount;
    }
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
    const n = parseFloat(String(raw ?? '').replace(/[,£$€\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Finances `AdjustmentType` values we bucket as **reimbursements** on the P&amp;L row (signed;
   * clawbacks are negative). Other adjustment types go to `otherAdjustments`.
   */
  private pnlFinancesAdjustmentTypeIsReimbursementBucket(adjustmentType: string): boolean {
    const t = String(adjustmentType ?? '').trim();
    if (!t) return false;
    const bucket = new Set<string>([
      'FBAInventoryReimbursement',
      'PostageRefund',
      'LostOrDamagedReimbursement',
      'CanceledButPickedUpReimbursement',
      'ReimbursementClawback',
      'SellerRewards',
    ]);
    if (bucket.has(t)) return true;
    return /reimbursement/i.test(t);
  }

  /**
   * Sums Finances v0 `listFinancialEvents` **posted-range** payloads for P&amp;L adjustment lines.
   * Order-line revenue/fees in our DB do not include these; they must be added separately.
   */
  private sumProfitAndLossFinancesPostedBucket(fe: Record<string, unknown>): {
    reimbursementAdjustments: number;
    otherAdjustments: number;
    amazonSubscriptionFees: number;
    amazonStorageFees: number;
    amazonInboundShippingFees: number;
  } {
    let reimbursementAdjustments = 0;
    let otherAdjustments = 0;
    let amazonSubscriptionFees = 0;
    let amazonStorageFees = 0;
    let amazonInboundShippingFees = 0;

    const addReimbList = (list: unknown, amountKeys: string[]) => {
      if (!Array.isArray(list)) return;
      for (const ev of list) {
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
        const o = ev as Record<string, unknown>;
        for (const k of amountKeys) {
          const snake = k.charAt(0).toLowerCase() + k.slice(1);
          const amt = this.readFinancesCurrencyAmount(o[k] ?? o[snake]);
          if (amt !== 0) {
            reimbursementAdjustments += amt;
            break;
          }
        }
      }
    };

    addReimbList(fe.SAFETReimbursementEventList ?? fe.safetReimbursementEventList, [
      'ReimbursedAmount',
    ]);
    addReimbList(fe.TDSReimbursementEventList ?? fe.tdsReimbursementEventList, [
      'ReimbursedAmount',
    ]);
    addReimbList(
      fe.EBTRefundReimbursementOnlyEventList ?? fe.ebtRefundReimbursementOnlyEventList,
      ['Amount'],
    );

    const adjList = fe.AdjustmentEventList ?? fe.adjustmentEventList ?? [];
    if (Array.isArray(adjList)) {
      for (const ev of adjList) {
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
        const o = ev as Record<string, unknown>;
        const typ = String(o.AdjustmentType ?? o.adjustmentType ?? '');
        const amt = this.readFinancesCurrencyAmount(
          o.AdjustmentAmount ?? o.adjustmentAmount,
        );
        if (this.pnlFinancesAdjustmentTypeIsReimbursementBucket(typ)) {
          reimbursementAdjustments += amt;
        } else {
          otherAdjustments += amt;
        }
      }
    }

    const serviceFees = fe.ServiceFeeEventList ?? fe.serviceFeeEventList ?? [];
    if (Array.isArray(serviceFees)) {
      for (const ev of serviceFees) {
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
        const o = ev as Record<string, unknown>;
        const desc = String(o.FeeReason ?? o.feeReason ?? o.FeeDescription ?? o.feeDescription ?? '').trim();
        const amt = this.readFinancesCurrencyAmount(o.FeeAmount ?? o.feeAmount ?? o.Amount ?? o.amount);
        if (amt === 0) continue;
        const d = desc.toLowerCase();
        if (d.includes('subscription')) {
          amazonSubscriptionFees += amt;
        } else if (d.includes('storage')) {
          amazonStorageFees += amt;
        } else if (d.includes('inbound') || d.includes('transport') || (d.includes('shipping') && d.includes('fba'))) {
          amazonInboundShippingFees += amt;
        } else {
          otherAdjustments += amt;
        }
      }
    }

    return {
      reimbursementAdjustments:
        Math.round(reimbursementAdjustments * 100) / 100,
      otherAdjustments: Math.round(otherAdjustments * 100) / 100,
      amazonSubscriptionFees: Math.round(amazonSubscriptionFees * 100) / 100,
      amazonStorageFees: Math.round(amazonStorageFees * 100) / 100,
      amazonInboundShippingFees: Math.round(amazonInboundShippingFees * 100) / 100,
    };
  }

  private async fetchFinancialEventsByOrderIdAllPages(
    credentials: SpApiCredentials,
    amazonOrderId: string,
  ): Promise<{ merged: unknown; pagesFetched: number }> {
    let page = (await this.spApiClient.listFinancialEventsByOrderId(credentials, amazonOrderId, {
      maxResultsPerPage: 100,
    })) as unknown;
    const merged = JSON.parse(JSON.stringify(page)) as Record<string, unknown>;
    let pagesFetched = 1;
    let next = this.extractFinancesListNextToken(page);
    while (next && pagesFetched < 80) {
      await new Promise<void>((r) => setTimeout(r, 400));
      const nextPage = (await this.spApiClient.listFinancialEventsByOrderId(credentials, amazonOrderId, {
        maxResultsPerPage: 100,
        nextToken: next,
      })) as unknown;
      this.mergeFinancesPagesFinancialEvents(merged, nextPage);
      pagesFetched += 1;
      next = this.extractFinancesListNextToken(nextPage);
    }
    const p = merged.payload ?? merged.Payload;
    if (p && typeof p === 'object') {
      delete (p as Record<string, unknown>).NextToken;
      delete (p as Record<string, unknown>).nextToken;
    }
    return { merged, pagesFetched };
  }

  private countFinancialEventListItems(res: unknown): number {
    const fe = this.getFinancialEventsBucket(res);
    if (!fe) return 0;
    let n = 0;
    for (const v of Object.values(fe)) {
      if (Array.isArray(v)) n += v.length;
    }
    return n;
  }

  /** Keep only events whose JSON mentions this Amazon order id (coarse filter on range-wide Finances). */
  private filterFinancialEventsByAmazonOrderId(
    fe: Record<string, unknown>,
    amazonOrderId: string,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...fe };
    for (const key of Object.keys(out)) {
      const arr = out[key];
      if (!Array.isArray(arr)) continue;
      try {
        out[key] = arr.filter((ev) => JSON.stringify(ev).includes(amazonOrderId));
      } catch {
        out[key] = [];
      }
    }
    return out;
  }

  private async fetchFinancialEventsPostedRangeAllPages(
    credentials: SpApiCredentials,
    postedAfter: string,
    postedBefore: string,
  ): Promise<{ merged: unknown; pagesFetched: number }> {
    let page = (await this.spApiClient.listFinancialEvents(credentials, {
      postedAfter,
      postedBefore,
      maxResultsPerPage: 100,
    })) as unknown;
    const merged = JSON.parse(JSON.stringify(page)) as Record<string, unknown>;
    let pagesFetched = 1;
    let next = this.extractFinancesListNextToken(page);
    while (next && pagesFetched < 80) {
      await new Promise<void>((r) => setTimeout(r, 400));
      const nextPage = (await this.spApiClient.listFinancialEvents(credentials, {
        postedAfter,
        postedBefore,
        maxResultsPerPage: 100,
        nextToken: next,
      })) as unknown;
      this.mergeFinancesPagesFinancialEvents(merged, nextPage);
      pagesFetched += 1;
      next = this.extractFinancesListNextToken(nextPage);
    }
    const p = merged.payload ?? merged.Payload;
    if (p && typeof p === 'object') {
      delete (p as Record<string, unknown>).NextToken;
      delete (p as Record<string, unknown>).nextToken;
    }
    return { merged, pagesFetched };
  }

  /**
   * Amazon: if postedAfter/postedBefore are **more than 180 days** apart, `listTransactions` returns **empty**.
   * Use the widest safe window ending shortly before "now" so deferred rows posted months ago still match.
   */
  private finances2024ListTransactionsMaxPostedWindowIso(nowMs = Date.now()): {
    postedAfter: string;
    postedBefore: string;
  } {
    const postedBeforeMs = nowMs - 2.5 * 60 * 1000;
    const postedAfterMs = postedBeforeMs - 179 * 24 * 60 * 60 * 1000;
    return {
      postedAfter: new Date(postedAfterMs).toISOString(),
      postedBefore: new Date(postedBeforeMs).toISOString(),
    };
  }

  private async finances2024ListTransactionsFetchAllPages(
    credentials: SpApiCredentials,
    args: {
      marketplaceId: string;
      postedAfter: string;
      postedBefore: string;
      transactionStatus?: 'DEFERRED' | 'RELEASED' | 'DEFERRED_RELEASED' | null;
      relatedIdentifierName: 'ORDER_ID' | 'FINANCIAL_EVENT_GROUP_ID';
      relatedIdentifierValue: string;
    },
  ): Promise<{ pagesFetched: number; transactions: unknown[] }> {
    const transactions: unknown[] = [];
    let next: string | undefined;
    let pagesFetched = 0;
    while (pagesFetched < 40) {
      pagesFetched += 1;
      const page = (await this.spApiClient.listFinancesTransactions20240619(credentials, {
        marketplaceId: args.marketplaceId,
        postedAfter: args.postedAfter,
        postedBefore: args.postedBefore,
        ...(args.transactionStatus != null
          ? { transactionStatus: args.transactionStatus }
          : {}),
        relatedIdentifierName: args.relatedIdentifierName,
        relatedIdentifierValue: args.relatedIdentifierValue,
        nextToken: next,
      })) as Record<string, unknown>;
      const payload = (page?.payload ?? page?.Payload) as Record<string, unknown> | undefined;
      const txs = payload?.transactions ?? payload?.Transactions;
      if (Array.isArray(txs)) transactions.push(...txs);
      const nt = payload?.nextToken ?? payload?.NextToken;
      next = typeof nt === 'string' && nt.length > 0 ? nt : undefined;
      if (!next) break;
      await new Promise<void>((r) => setTimeout(r, 400));
    }
    return { pagesFetched, transactions };
  }

  /** Prefer SP-API marketplace id from Orders `getOrderItems` payload (UK vs DE etc.). */
  private extractMarketplaceIdFromOrdersGetOrderItemsPayload(res: unknown): string | null {
    const root = res as Record<string, unknown> | null;
    if (!root) return null;
    const p = (root.payload ?? root.Payload) as Record<string, unknown> | undefined;
    const items = (p?.OrderItems ?? p?.orderItems) as unknown[] | undefined;
    if (!Array.isArray(items) || items.length === 0) return null;
    const first = items[0] as Record<string, unknown>;
    const id = first?.MarketplaceId ?? first?.marketplaceId;
    return typeof id === 'string' && id.length >= 10 && id.startsWith('A') ? id : null;
  }

  /**
   * Dev-only: raw SP-API `GET /finances/v0/orders/{orderId}/financialEvents` for mapping fee rows.
   * If `amazonOrderId` is omitted, uses the most recent DB `order_item` with `feesSource === 'finances'`.
   * Follows **NextToken** until exhausted, merges all `FinancialEvents` event lists, then adds `__debugFigure`
   * on each money-bearing object so JSON is self-describing.
   *
   * When **by-order** returns empty event lists (common: settlement delay / events only on posted-range API),
   * also calls `GET /finances/v0/financialEvents` for a window around the line’s `orderDate`, merges pages,
   * filters to this `amazonOrderId`, and returns that as `financesPostedRangeFilteredResponse`.
   */
  async getOrderFinancesRawDebug(
    orgId: string,
    query: { amazonOrderId?: string },
    preferredUserId: string,
  ): Promise<{
    amazonOrderId: string;
    resolvedBy: 'query' | 'latest_finances_db';
    financesPagesFetched: number;
    financesResponse: unknown;
    financialEventsByOrderIdItemCount: number;
    amazonNote: string | null;
    /** Why Seller Central can show fees while v0 Finances is empty (deferred / not in API yet). */
    sellerCentralFinancesGap: string | null;
    /** Raw `getOrderItems` response (line ItemPrice, tax, etc.) — always present when call succeeds. */
    ordersApiGetOrderItems: unknown | null;
    financesPostedRange: { postedAfter: string; postedBefore: string } | null;
    financesPostedRangePagesFetched: number | null;
    financesPostedRangeFilteredResponse: unknown | null;
    /** Total event objects across all `*EventList` keys after posted-range filter to this order id. */
    financesPostedRangeFilteredEventItemCount: number | null;
    /** Finances API 2024-06-19 `listTransactions` by ORDER_ID (merged sweeps; see `sweeps` inside). */
    finances2024ListTransactionsDeferred: unknown | null;
    finances2024ListTransactionsError: string | null;
    finances2024ListTransactionsPagesFetched: number | null;
    /** Per-status sweep counts (DEFERRED / DEFERRED_RELEASED / RELEASED / any). */
    finances2024ListTransactionsSweeps: Array<{
      transactionStatus: string | null;
      pagesFetched: number;
      transactionCount: number;
    }>;
    finances2024ListTransactionsMarketplaceId: string;
    finances2024ListTransactionsPostedWindow: { postedAfter: string; postedBefore: string };
  }> {
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
    const trimmed = query.amazonOrderId?.trim();
    let amazonOrderId: string;
    let resolvedBy: 'query' | 'latest_finances_db';
    if (trimmed) {
      amazonOrderId = trimmed;
      resolvedBy = 'query';
    } else {
      const hit = await this.prisma.orderItem.findFirst({
        where: { userId: { in: userIds }, marketplace: 'amazon', feesSource: 'finances' },
        orderBy: { orderDate: 'desc' },
        select: { orderId: true },
      });
      if (!hit?.orderId) {
        throw new NotFoundException(
          'No order_item with feesSource=finances in this org; pass amazonOrderId=… explicitly.',
        );
      }
      amazonOrderId = hit.orderId;
      resolvedBy = 'latest_finances_db';
    }
    const credentials = await this.getAmazonCredentialsForOrg(orgId, preferredUserId);
    const { merged, pagesFetched } = await this.fetchFinancialEventsByOrderIdAllPages(
      credentials,
      amazonOrderId,
    );
    const itemCount = this.countFinancialEventListItems(merged);
    const financesResponse = this.injectFinancesMoneyDebugFigures(merged);

    let amazonNote: string | null = null;
    let financesPostedRange: { postedAfter: string; postedBefore: string } | null = null;
    let financesPostedRangePagesFetched: number | null = null;
    let financesPostedRangeFilteredResponse: unknown | null = null;

    let financesPostedRangeFilteredEventItemCount: number | null = null;

    if (itemCount === 0) {
      amazonNote =
        'listFinancialEventsByOrderId: zero events in FinancialEvents. Posted-range fallback may still be empty for deferred orders — see sellerCentralFinancesGap.';

      const line = await this.prisma.orderItem.findFirst({
        where: {
          userId: { in: userIds },
          marketplace: 'amazon',
          orderId: amazonOrderId,
        },
        orderBy: { orderDate: 'desc' },
        select: { orderDate: true },
      });

      if (line?.orderDate) {
        const beforeBoundMs = Date.now() - 2.5 * 60 * 1000;
        const orderMs = new Date(line.orderDate).getTime();
        let postedBeforeMs = Math.min(beforeBoundMs, orderMs + 45 * 24 * 60 * 60 * 1000);
        let postedAfterMs = orderMs - 5 * 24 * 60 * 60 * 1000;
        const maxSpanMs = 179 * 24 * 60 * 60 * 1000;
        if (postedBeforeMs - postedAfterMs > maxSpanMs) {
          postedAfterMs = postedBeforeMs - maxSpanMs;
        }
        if (postedAfterMs >= postedBeforeMs) {
          postedAfterMs = postedBeforeMs - 48 * 60 * 60 * 1000;
        }
        const postedAfter = new Date(postedAfterMs).toISOString();
        const postedBefore = new Date(postedBeforeMs).toISOString();

        try {
          const range = await this.fetchFinancialEventsPostedRangeAllPages(
            credentials,
            postedAfter,
            postedBefore,
          );
          const bucket = this.getFinancialEventsBucket(range.merged);
          if (bucket) {
            const filtered = this.filterFinancialEventsByAmazonOrderId(bucket, amazonOrderId);
            financesPostedRangeFilteredEventItemCount = 0;
            for (const v of Object.values(filtered)) {
              if (Array.isArray(v)) financesPostedRangeFilteredEventItemCount += v.length;
            }
            const wrapped = JSON.parse(JSON.stringify(range.merged)) as Record<string, unknown>;
            const p = (wrapped.payload ?? wrapped.Payload) as Record<string, unknown>;
            if (p && typeof p === 'object') {
              p.FinancialEvents = filtered;
            }
            financesPostedRange = { postedAfter, postedBefore };
            financesPostedRangePagesFetched = range.pagesFetched;
            financesPostedRangeFilteredResponse = this.injectFinancesMoneyDebugFigures(wrapped);
          }
        } catch (err) {
          this.logger.warn('[getOrderFinancesRawDebug] listFinancialEvents fallback failed', {
            amazonOrderId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    let ordersApiGetOrderItems: unknown | null = null;
    try {
      ordersApiGetOrderItems = await this.spApiClient.getOrderItems(credentials, amazonOrderId);
    } catch (err) {
      this.logger.warn('[getOrderFinancesRawDebug] getOrderItems failed', {
        amazonOrderId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    const mpFromOrderItems =
      this.extractMarketplaceIdFromOrdersGetOrderItemsPayload(ordersApiGetOrderItems);
    const marketplaceIdFor2024 =
      mpFromOrderItems ??
      (credentials.region === 'eu'
        ? 'A1F83G8C2ARO7P'
        : credentials.region === 'fe'
          ? 'A1VC38T7YXB528'
          : 'ATVPDKIKX0DER');
    const { postedAfter: postedAfter2024, postedBefore: postedBefore2024 } =
      this.finances2024ListTransactionsMaxPostedWindowIso();

    const transactions2024Agg: unknown[] = [];
    const finances2024ListTransactionsSweeps: Array<{
      transactionStatus: string | null;
      pagesFetched: number;
      transactionCount: number;
    }> = [];
    let finances2024ListTransactionsDeferred: unknown | null = null;
    let finances2024ListTransactionsError: string | null = null;
    let finances2024ListTransactionsPagesFetched: number | null = null;

    const seenTx = new Set<string>();
    const dedupePush = (list: unknown[]) => {
      for (const t of list) {
        const rec = t as Record<string, unknown>;
        const tid = rec?.transactionId ?? rec?.TransactionId;
        const key =
          typeof tid === 'string' && tid.length > 0
            ? tid
            : `hash:${JSON.stringify(rec).slice(0, 400)}`;
        if (seenTx.has(key)) continue;
        seenTx.add(key);
        transactions2024Agg.push(t);
      }
    };

    const sweepStatuses = ['DEFERRED', 'DEFERRED_RELEASED', 'RELEASED'] as const;
    try {
      let totalPages = 0;
      for (const st of sweepStatuses) {
        const { pagesFetched, transactions } =
          await this.finances2024ListTransactionsFetchAllPages(credentials, {
            marketplaceId: marketplaceIdFor2024,
            postedAfter: postedAfter2024,
            postedBefore: postedBefore2024,
            transactionStatus: st,
            relatedIdentifierName: 'ORDER_ID',
            relatedIdentifierValue: amazonOrderId,
          });
        totalPages += pagesFetched;
        finances2024ListTransactionsSweeps.push({
          transactionStatus: st,
          pagesFetched,
          transactionCount: transactions.length,
        });
        dedupePush(transactions);
        await new Promise<void>((r) => setTimeout(r, 350));
      }
      {
        const { pagesFetched, transactions } =
          await this.finances2024ListTransactionsFetchAllPages(credentials, {
            marketplaceId: marketplaceIdFor2024,
            postedAfter: postedAfter2024,
            postedBefore: postedBefore2024,
            transactionStatus: null,
            relatedIdentifierName: 'ORDER_ID',
            relatedIdentifierValue: amazonOrderId,
          });
        totalPages += pagesFetched;
        finances2024ListTransactionsSweeps.push({
          transactionStatus: null,
          pagesFetched,
          transactionCount: transactions.length,
        });
        dedupePush(transactions);
      }
      finances2024ListTransactionsPagesFetched = totalPages;
      finances2024ListTransactionsDeferred = this.injectFinancesMoneyDebugFigures({
        api: 'GET /finances/2024-06-19/transactions',
        note:
          'Sweeps: DEFERRED, DEFERRED_RELEASED, RELEASED, then no transactionStatus (Amazon may still filter by ORDER_ID). ' +
          'Posted window is max span **179 days** ending now−2.5m (Amazon returns **empty** if postedAfter/postedBefore are >180 days apart; a 120-day rolling window can miss older postedDate rows). ' +
          'marketplaceId prefers getOrderItems line MarketplaceId when present.',
        marketplaceIdUsed: marketplaceIdFor2024,
        marketplaceIdFromOrderItems: mpFromOrderItems,
        postedWindow: { postedAfter: postedAfter2024, postedBefore: postedBefore2024 },
        sweeps: finances2024ListTransactionsSweeps,
        transactions: transactions2024Agg,
      });
    } catch (e) {
      finances2024ListTransactionsError = e instanceof Error ? e.message : String(e);
    }

    const rangeEmpty =
      financesPostedRangeFilteredEventItemCount == null ||
      financesPostedRangeFilteredEventItemCount === 0;
    const v2024HasRows = transactions2024Agg.length > 0;
    const sellerCentralFinancesGap =
      v2024HasRows
        ? `Finances v0 was empty for this order, but Finances 2024-06-19 listTransactions (ORDER_ID sweeps) returned ${transactions2024Agg.length} merged transaction object(s). See finances2024ListTransactionsDeferred (includes sweeps + posted window).`
        : itemCount === 0 && rangeEmpty
          ? 'Seller Central can show deferred rows that still do not appear in SP-API for this order: we sweep GET /finances/2024-06-19/transactions with ORDER_ID for DEFERRED, DEFERRED_RELEASED, RELEASED, and once without transactionStatus, using a **179-day** posted window (Amazon returns empty if postedAfter/postedBefore span >180 days; a short rolling window can miss rows by postedDate). Inspect `finances2024ListTransactionsSweeps`, `marketplaceIdUsed` vs `ordersApiGetOrderItems` MarketplaceId, and `finances2024ListTransactionsError` (403 → Finance and Accounting role). If all sweeps are zero, sync/order profit uses **pre-sale** `products` fee estimates until Finances settlement.'
          : itemCount === 0
            ? 'Finances by order id returned zero events; posted-range fallback returned some events — inspect financesPostedRangeFilteredResponse for fee rows.'
            : null;

    return {
      amazonOrderId,
      resolvedBy,
      financesPagesFetched: pagesFetched,
      financesResponse,
      financialEventsByOrderIdItemCount: itemCount,
      amazonNote,
      sellerCentralFinancesGap,
      ordersApiGetOrderItems,
      financesPostedRange,
      financesPostedRangePagesFetched,
      financesPostedRangeFilteredResponse,
      financesPostedRangeFilteredEventItemCount,
      finances2024ListTransactionsDeferred,
      finances2024ListTransactionsError,
      finances2024ListTransactionsPagesFetched,
      finances2024ListTransactionsSweeps,
      finances2024ListTransactionsMarketplaceId: marketplaceIdFor2024,
      finances2024ListTransactionsPostedWindow: {
        postedAfter: postedAfter2024,
        postedBefore: postedBefore2024,
      },
    };
  }

  /**
   * List order items for the org (most recent first). Fee totals use stored `amazonFeesTotal` (Finances
   * convention: negative = cost). Referral/FBA/digital: Finances breakdown when present; for `feesSource`
   * `estimate` / `estimate_sold` prefer frozen **at-sale** snapshot columns when set (sync), else **pre-sale**
   * per-unit columns on `products`. For other non-finances rows, optional batched Product Fees at **sold unit
   * price** may still refine splits.
   * Settled lines whose fee/revenue is implausible vs a **prior same-ASIN/SKU** sale with sane Finances data
   * get Ref/FBA/Dig (and the shown fee total) re-shaped using that sale’s fee % of revenue, scaled by
   * current unit price vs the reference (same price → qty-only scale).
   */
  async listOrders(orgId: string, marketplaceId?: string) {
    const marketplaceFilter = this.resolveMarketplaceFilter(marketplaceId);
    let userIds: string[];
    try {
      userIds = await this.getOrgAmazonOrderReadUserIds(orgId);
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
    let items: any[] = [];
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
          marketplace: true,
          sku: true,
          asin: true,
          quantity: true,
            orderDbId: true,
            revenueTotal: true,
            rawResponse: true,
            taxChargedTotal: true,
            amazonFeesTotal: true,
            feesSource: true,
            settledReferralFeeTotal: true,
            settledFbaFeeTotal: true,
            settledDigitalServiceFeeTotal: true,
            atSaleEstimateReferralFeeTotal: true,
            atSaleEstimateFbaFeeTotal: true,
            atSaleEstimateDigitalServiceFeeTotal: true,
            amazonFeesVatAmount: true,
            profit: true,
            cogsTotal: true,
            productId: true,
            userId: true,
            product: {
              select: {
                title: true,
                imageUrl: true,
                id: true,
                currentListedPrice: true,
                estimatedReferralFeePerUnit: true,
                estimatedFbaFeePerUnit: true,
                estimatedDigitalServiceFeePerUnit: true,
                estimatedAmazonFeePerUnit: true,
                feeEstimateRawJson: true,
              },
            },
            order: { select: { orderDate: true, amazonOrderStatus: true, rawResponse: true } },
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

    items = [...items].sort(
      (a, b) => this.canonicalOrderItemMs(b as any) - this.canonicalOrderItemMs(a as any),
    ) as typeof items;

    this.logger.log(`[listOrders] orgId=${orgId} orderItemCount=${items.length}`);
    let listOrdersVatSettings: Awaited<
      ReturnType<AmazonService['getVatSettingsForOrg']>
    > = null;
    try {
      listOrdersVatSettings = await this.getVatSettingsForOrg(orgId);
    } catch {
      listOrdersVatSettings = null;
    }
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
        // Raw query or product columns may fail; order rows still show fee totals from order line / product total
      }
    }
    const { orderPriceByDbId, skuUnitPriceFallback, orderLineQtySumByOrderDbId } =
      await this.buildRevenueFallbackMapsForOrderItems(items as any);
    const orderSalesExclusionByDbId =
      orderDbIds.length > 0
        ? await this.buildOrderSalesExclusionMap(orderDbIds)
        : new Map<string, OrderSalesExclusionKind>();

    let atPriceBreakdownByItemId = new Map<string, { r: number; f: number; d: number }>();
    try {
      const feeJobs = this.collectListOrdersAtPriceFeeJobs({
        items: items as any,
        orderPriceByDbId,
        skuUnitPriceFallback,
        orderLineQtySumByOrderDbId,
        orderSalesExclusionByDbId,
        productFeesById,
        marketplaceRequestId: marketplaceId,
      });
      atPriceBreakdownByItemId = await this.fetchListOrdersPriceBasedFeeBreakdowns(feeJobs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[listOrders] at-price Product Fees batch failed: ${msg}`);
    }

    const feeShapeRefs = this.buildListOrdersFeeShapeReferenceByAsinAndSku({
      items: items as any,
      orderPriceByDbId,
      skuUnitPriceFallback,
      orderLineQtySumByOrderDbId,
      orderSalesExclusionByDbId,
    });

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
      const fbaUkVatSplitByProductId = new Map<
        string,
        { rawCoreMag: number; rawAddonMag: number; rawTaxMag: number } | null
      >();
      const mappedRows = items.map((it) => {
      const productRaw = (it as any).product ?? null;
      const product = productRaw as {
        title?: string | null;
        imageUrl?: string | null;
        currentListedPrice?: unknown;
        estimatedReferralFeePerUnit?: unknown;
        estimatedFbaFeePerUnit?: unknown;
        estimatedDigitalServiceFeePerUnit?: unknown;
        estimatedAmazonFeePerUnit?: unknown;
        feeEstimateRawJson?: unknown;
      } | null;
      const inv = inventoryByProductId.get(it.productId) ?? null;
      const fees = productFeesById.get(it.productId) ?? null;
      const qty = safeNum(it.quantity) || 1;
      const orderDbId = (it as any).orderDbId != null ? String((it as any).orderDbId) : '';
      const exclusionKind = orderDbId
        ? orderSalesExclusionByDbId.get(orderDbId) ?? null
        : null;
      const ord = (it as any).order as
        | { amazonOrderStatus?: string | null; rawResponse?: unknown }
        | undefined;
      const orderCtx = ord
        ? { amazonOrderStatus: ord.amazonOrderStatus, rawOrder: ord.rawResponse }
        : undefined;
      const allowRecon =
        orderCtx == null ||
        this.orderParentStatusAllowsReconstructedRevenueForZeroStoredLine(
          orderCtx.amazonOrderStatus,
          orderCtx.rawOrder,
        );
      const signedRev = this.resolveOrderLineRevenueSigned(
        it as {
          revenueTotal?: unknown;
          quantity?: unknown;
          orderDbId?: unknown;
          sku?: unknown;
          rawResponse?: unknown;
        },
        orderPriceByDbId,
        skuUnitPriceFallback,
        orderLineQtySumByOrderDbId,
        orderCtx,
      );
      let revenueTotal = signedRev;
      if (!exclusionKind && allowRecon && signedRev === 0) {
        const listPx = safeNum(product?.currentListedPrice);
        if (listPx > 0) revenueTotal = listPx * qty;
      }
      const taxChargedTotal = safeNum(it.taxChargedTotal);
      const feesSource = (it as any).feesSource ?? null;
      const orderDateForVat =
        (it as { order?: { orderDate?: unknown } }).order?.orderDate instanceof Date
          ? ((it as any).order.orderDate as Date)
          : (it as any).order?.orderDate != null && String((it as any).order.orderDate) !== ''
            ? new Date((it as any).order.orderDate as string | number)
            : it.orderDate instanceof Date
              ? (it.orderDate as Date)
              : new Date(String((it as any).orderDate ?? Date.now()));
      let settledFees = safeNum(it.amazonFeesTotal);
      // Line totals and Finances breakdown components are stored ≤ 0. Legacy rows (and bad estimate writes)
      // sometimes have positive magnitudes; using them as-is makes `revenue - tax - cogs + fees` ADD fees → impossible profit.
      if (
        (feesSource === 'finances' ||
          feesSource === 'estimate' ||
          feesSource === 'estimate_sold') &&
        settledFees > 0
      ) {
        settledFees = -Math.abs(settledFees);
      }
      const normStoredAmazonFeeComponent = (n: number | null): number | null => {
        if (n == null || !Number.isFinite(n)) return null;
        if (n === 0) return 0;
        return n > 0 ? -Math.abs(n) : n;
      };
      // Use order item stored fees when present; else product's saved estimate (so we always pick up estimates from DB).
      const estPerUnit = fees?.amazonFeePerUnit ?? toNum(product?.estimatedAmazonFeePerUnit) ?? null;
      const estReferral = fees?.referralPerUnit ?? toNum(product?.estimatedReferralFeePerUnit) ?? null;
      const estFba = fees?.fbaPerUnit ?? toNum(product?.estimatedFbaFeePerUnit) ?? null;
      const estDigital = fees?.digitalServicePerUnit ?? toNum(product?.estimatedDigitalServiceFeePerUnit) ?? null;
      // Use settled total when we have it (finances); otherwise use estimated total (estimated per unit × qty); else conservative fallback so ROI isn't overstated.
      let feesForDisplay =
        settledFees !== 0
          ? settledFees
          : estPerUnit != null && Number.isFinite(estPerUnit)
            ? -Math.abs(estPerUnit * qty)
            : revenueTotal > 0
              ? -Math.abs(revenueTotal * DEFAULT_AMAZON_FEE_RATE_WHEN_UNKNOWN)
              : 0;
      let referralFeeTotal: number | null = null;
      let fbaFeeTotal: number | null = null;
      let digitalServiceFeeTotal: number | null = null;
      // Use settled breakdown from Finances API when available (orders that have settled).
      const settledReferral = normStoredAmazonFeeComponent(
        toNum((it as any).settledReferralFeeTotal),
      );
      const settledFba = normStoredAmazonFeeComponent(toNum((it as any).settledFbaFeeTotal));
      const settledDigital = normStoredAmazonFeeComponent(
        toNum((it as any).settledDigitalServiceFeeTotal),
      );
      const hasSettledBreakdown =
        feesSource === 'finances' &&
        (settledReferral != null || settledFba != null || settledDigital != null);
      if (hasSettledBreakdown) {
        referralFeeTotal = settledReferral;
        fbaFeeTotal = settledFba;
        digitalServiceFeeTotal = settledDigital;
      }
      if (
        feesSource === 'finances' &&
        referralFeeTotal != null &&
        fbaFeeTotal != null &&
        (digitalServiceFeeTotal == null || digitalServiceFeeTotal === 0)
      ) {
        if (
          this.isLikelyLegacyEqualReferralFbaSplit(
            referralFeeTotal,
            fbaFeeTotal,
            digitalServiceFeeTotal,
            settledFees,
          )
        ) {
          referralFeeTotal = null;
          fbaFeeTotal = null;
          digitalServiceFeeTotal = null;
        }
      }
      const snapReferralEst = normStoredAmazonFeeComponent(
        toNum((it as any).atSaleEstimateReferralFeeTotal),
      );
      const snapFbaEst = normStoredAmazonFeeComponent(
        toNum((it as any).atSaleEstimateFbaFeeTotal),
      );
      const snapDigEst = normStoredAmazonFeeComponent(
        toNum((it as any).atSaleEstimateDigitalServiceFeeTotal),
      );
      const hasSaleEstimateSnap =
        (feesSource === 'estimate' || feesSource === 'estimate_sold') &&
        (snapReferralEst != null || snapFbaEst != null || snapDigEst != null);
      if (!hasSettledBreakdown && hasSaleEstimateSnap) {
        referralFeeTotal = snapReferralEst;
        fbaFeeTotal = snapFbaEst;
        digitalServiceFeeTotal = snapDigEst;
        if (
          digitalServiceFeeTotal == null &&
          (referralFeeTotal != null || fbaFeeTotal != null)
        ) {
          const sumRf = Math.abs(referralFeeTotal ?? 0) + Math.abs(fbaFeeTotal ?? 0);
          if (sumRf > 0) {
            digitalServiceFeeTotal = Math.round(-sumRf * 0.02 * 100) / 100;
          }
        }
        if (Math.abs(settledFees) > 1e-4) {
          const scaled = this.scaleSignedFeeTripToTarget(
            referralFeeTotal ?? 0,
            fbaFeeTotal ?? 0,
            digitalServiceFeeTotal ?? 0,
            settledFees,
          );
          if (scaled) {
            referralFeeTotal = scaled.r !== 0 ? scaled.r : null;
            fbaFeeTotal = scaled.f !== 0 ? scaled.f : null;
            digitalServiceFeeTotal = scaled.d !== 0 ? scaled.d : null;
          }
        }
      }
      const atBd = atPriceBreakdownByItemId.get(String(it.id));
      // Product Fees "at sold price" batch is not used for `estimate` / `estimate_sold` rows — those use
      // pre-sale `products` per-unit columns (same as sync). Never replace Finances-settled lines.
      if (
        atBd &&
        feesSource !== 'finances' &&
        feesSource !== 'estimate' &&
        feesSource !== 'estimate_sold'
      ) {
        referralFeeTotal = atBd.r !== 0 ? atBd.r : null;
        fbaFeeTotal = atBd.f !== 0 ? atBd.f : null;
        digitalServiceFeeTotal = atBd.d !== 0 ? atBd.d : null;
      } else if (!hasSettledBreakdown && feesSource !== 'finances') {
        if (estReferral != null && Number.isFinite(estReferral)) {
          referralFeeTotal = Math.round(-Math.abs(estReferral * qty) * 100) / 100;
        }
        if (estFba != null && Number.isFinite(estFba)) {
          fbaFeeTotal = Math.round(-Math.abs(estFba * qty) * 100) / 100;
        }
        if (estDigital != null && Number.isFinite(estDigital)) {
          digitalServiceFeeTotal = Math.round(-Math.abs(estDigital * qty) * 100) / 100;
        }
        if (digitalServiceFeeTotal == null && (referralFeeTotal != null || fbaFeeTotal != null)) {
          const sum = Math.abs(referralFeeTotal ?? 0) + Math.abs(fbaFeeTotal ?? 0);
          if (sum > 0) digitalServiceFeeTotal = Math.round(-sum * 0.02 * 100) / 100;
        }
      } else if (
        feesSource === 'finances' &&
        referralFeeTotal == null &&
        fbaFeeTotal == null &&
        digitalServiceFeeTotal == null &&
        Math.abs(feesForDisplay) > 0.0005
      ) {
        let r =
          estReferral != null && Number.isFinite(estReferral)
            ? -Math.abs(estReferral * qty)
            : 0;
        let f =
          estFba != null && Number.isFinite(estFba) ? -Math.abs(estFba * qty) : 0;
        let d =
          estDigital != null && Number.isFinite(estDigital)
            ? -Math.abs(estDigital * qty)
            : 0;
        if (d === 0 && (r !== 0 || f !== 0)) {
          const sumRf = Math.abs(r) + Math.abs(f);
          if (sumRf > 0) {
            d = Math.round(-sumRf * 0.02 * 100) / 100;
          }
        }
        const scaled = this.scaleSignedFeeTripToTarget(r, f, d, feesForDisplay);
        if (scaled) {
          referralFeeTotal = scaled.r !== 0 ? scaled.r : null;
          fbaFeeTotal = scaled.f !== 0 ? scaled.f : null;
          digitalServiceFeeTotal = scaled.d !== 0 ? scaled.d : null;
        }
      }
      // Implausible fee/revenue on a settled line (e.g. components scaled to a wrong total): re-shape from a
      // prior **same ASIN/SKU** sale with sane fee %, scaling by sold unit price (and qty) vs that reference.
      if (
        feesSource === 'finances' &&
        revenueTotal > 0.01 &&
        !exclusionKind
      ) {
        const sumMag =
          Math.abs(referralFeeTotal ?? 0) +
          Math.abs(fbaFeeTotal ?? 0) +
          Math.abs(digitalServiceFeeTotal ?? 0);
        const ratio =
          sumMag > 1e-4
            ? sumMag / revenueTotal
            : Math.abs(settledFees) / revenueTotal;
        if (ratio > AmazonService.LIST_ORDERS_MAX_FEE_TO_REVENUE_RATIO) {
          const skuK = String(it.sku ?? '').trim();
          const asinK = it.asin != null ? String(it.asin).trim() : '';
          const peer =
            (asinK && feeShapeRefs.byAsin.get(asinK)) ??
            (skuK && feeShapeRefs.bySku.get(skuK)) ??
            null;
          if (peer && peer.revenue > 0.01 && peer.feeSumMag > 1e-6) {
            const pCur = revenueTotal / qty;
            const priceScale =
              Math.abs(pCur - peer.unitPrice) < 0.015 ? 1 : pCur / peer.unitPrice;
            const qtyScale = qty / peer.qty;
            const r0 = peer.ref * priceScale * qtyScale;
            const f0 = peer.fba * priceScale * qtyScale;
            const d0 = peer.dig * priceScale * qtyScale;
            const feeRevPeer = peer.feeSumMag / peer.revenue;
            const targetCap = -Math.min(
              feeRevPeer * revenueTotal,
              revenueTotal * AmazonService.LIST_ORDERS_MAX_FEE_TO_REVENUE_RATIO,
            );
            const scaled = this.scaleSignedFeeTripToTarget(r0, f0, d0, targetCap);
            if (scaled) {
              referralFeeTotal = scaled.r !== 0 ? scaled.r : null;
              fbaFeeTotal = scaled.f !== 0 ? scaled.f : null;
              digitalServiceFeeTotal = scaled.d !== 0 ? scaled.d : null;
              settledFees = targetCap;
              feesForDisplay = settledFees;
            }
          } else {
            // Every recent finances line for this ASIN/SKU was already bad (ratio > cap), so the peer map
            // is empty. Re-shape from Product Fees estimates, capped at LIST_ORDERS_MAX_FEE_TO_REVENUE_RATIO.
            const capMag = revenueTotal * AmazonService.LIST_ORDERS_MAX_FEE_TO_REVENUE_RATIO;
            let r =
              estReferral != null && Number.isFinite(estReferral)
                ? -Math.abs(estReferral * qty)
                : 0;
            let f = estFba != null && Number.isFinite(estFba) ? -Math.abs(estFba * qty) : 0;
            let d =
              estDigital != null && Number.isFinite(estDigital)
                ? -Math.abs(estDigital * qty)
                : 0;
            if (d === 0 && (r !== 0 || f !== 0)) {
              const sumRf = Math.abs(r) + Math.abs(f);
              if (sumRf > 0) {
                d = Math.round(-sumRf * 0.02 * 100) / 100;
              }
            }
            let mag = Math.abs(r) + Math.abs(f) + Math.abs(d);
            if (mag < 1e-4) {
              r = -capMag * 0.72;
              f = -capMag * 0.23;
              d = Math.round(-(capMag - Math.abs(r) - Math.abs(f)) * 100) / 100;
              mag = capMag;
            }
            const targetCap = -Math.min(capMag, mag);
            const scaled = this.scaleSignedFeeTripToTarget(r, f, d, targetCap);
            if (scaled) {
              referralFeeTotal = scaled.r !== 0 ? scaled.r : null;
              fbaFeeTotal = scaled.f !== 0 ? scaled.f : null;
              digitalServiceFeeTotal = scaled.d !== 0 ? scaled.d : null;
              settledFees = targetCap;
              feesForDisplay = settledFees;
            }
          }
        }
      }
      if (feesSource === 'finances' && Math.abs(feesForDisplay) > 1e-4) {
        const tr = referralFeeTotal ?? 0;
        const tf = fbaFeeTotal ?? 0;
        const td = digitalServiceFeeTotal ?? 0;
        const sumB = tr + tf + td;
        if (
          (referralFeeTotal != null || fbaFeeTotal != null || digitalServiceFeeTotal != null) &&
          Math.abs(sumB) > 1e-4 &&
          Math.abs(sumB - feesForDisplay) > 0.02
        ) {
          // If breakdown is *more negative* than the persisted line total, do not adopt it (double-counted VAT).
          if (sumB < feesForDisplay - 0.02) {
            feesForDisplay = settledFees;
          } else {
            feesForDisplay = sumB;
          }
        }
      }
      // Prefer the sum of Ref+FBA+Dig whenever those components exist — including Finances — so the
      // headline fee always matches the three lines the user reads.
      const totalFromBreakdown =
        (referralFeeTotal ?? 0) + (fbaFeeTotal ?? 0) + (digitalServiceFeeTotal ?? 0);
      const useBreakdownSum =
        (referralFeeTotal != null || fbaFeeTotal != null || digitalServiceFeeTotal != null) &&
        Math.abs(totalFromBreakdown) > 1e-6;
      const finalFeesForDisplay = useBreakdownSum
        ? Math.round(totalFromBreakdown * 100) / 100
        : Math.round(feesForDisplay * 100) / 100;
      const showFeesIncVat = this.shouldShowAmazonFeesWithVatIncluded(
        listOrdersVatSettings,
        orderDateForVat,
      );
      const feeVatRatePct = listOrdersVatSettings?.vatRatePct ?? 20;
      const grossUpSignedFeeExVat = (exSigned: number): number => {
        if (!Number.isFinite(exSigned) || exSigned === 0) return exSigned;
        const incMag = amountInclVatFromEx(Math.abs(exSigned), feeVatRatePct);
        return exSigned < 0 ? -incMag : incMag;
      };
      const grossUpNullable = (x: number | null): number | null => {
        if (x == null || !Number.isFinite(x)) return x;
        if (x === 0) return 0;
        return grossUpSignedFeeExVat(x);
      };
      let displayRef = referralFeeTotal;
      let displayFba = fbaFeeTotal;
      let displayDig = digitalServiceFeeTotal;
      let displayFeesTotal = finalFeesForDisplay;
      let displayAmazonFeesVat: number | null = null;
      // Seller Central–style inc-VAT display for non–VAT-registered orgs (and pre-registration dates).
      // **FBA** (and headline total from components): apply UK rules for `finances` too — Finances stores ex-VAT FBA
      // while SC shows inc-VAT. **Referral / digital**: only gross up ex→inc for `estimate` / `estimate_sold`
      // (Product Fees); settled Finances referral already reflects SC-style commission + fee VAT — do not ×1.2 again.
      if (showFeesIncVat) {
        // As of our Finances parsing, stored `settled*` components already match Seller Central-style VAT-inclusive
        // magnitudes (CommissionTax / FulfillmentFeeTax included in the bucket). Do NOT gross-up again.
        if (feesSource === 'finances') {
          displayRef = referralFeeTotal;
          displayFba = fbaFeeTotal;
          displayDig = digitalServiceFeeTotal;
          displayFeesTotal = finalFeesForDisplay;
          displayAmazonFeesVat = null;
        } else {
        const grossUpReferralAndDigitalForDisplay =
          feesSource === 'estimate' || feesSource === 'estimate_sold';
        const pid = String((it as any).productId ?? '');
        const rawFeeJson = product?.feeEstimateRawJson;
        if (pid && !fbaUkVatSplitByProductId.has(pid)) {
          fbaUkVatSplitByProductId.set(
            pid,
            this.parseProductFeesFbaUkVatSplitMags(rawFeeJson),
          );
        }
        const fbaSplit = pid ? fbaUkVatSplitByProductId.get(pid) ?? null : null;
        // UK FBA inc-VAT display (core vs fuel vs Product Fees tax line).
        if (
          fbaFeeTotal != null &&
          Number.isFinite(fbaFeeTotal) &&
          fbaSplit &&
          Math.abs(fbaFeeTotal) > 1e-6
        ) {
          const mag = Math.abs(fbaFeeTotal);
          const rc = fbaSplit.rawCoreMag;
          const ra = fbaSplit.rawAddonMag;
          const rt = fbaSplit.rawTaxMag;
          const rawNoTax = rc + ra;
          const rawFull = rc + ra + rt;
          const eps = Math.max(0.02 * Math.max(mag, rawFull, rawNoTax), 0.01);
          const close = (a: number, b: number) =>
            b > 1e-9 && Math.abs(a - b) <= Math.max(eps, 0.02 * b);
          /** Only treat DB magnitude as all-in when it actually carries ~VAT+core+add-ons, not a false `close` to a noisy rawFull. */
          const storedLineLooksTaxInclusive =
            rt > 1e-6 &&
            rawFull > 1e-9 &&
            close(mag, rawFull) &&
            mag + eps >= rawNoTax + rt * 0.72;
          let incMag: number;
          if (rawNoTax < 1e-9) {
            incMag = amountInclVatFromEx(mag, feeVatRatePct);
          } else if (rt < 1e-6) {
            const coreFrac = rc / rawNoTax;
            const addonFrac = ra / rawNoTax;
            incMag = amountInclVatFromEx(mag * coreFrac, feeVatRatePct) + mag * addonFrac;
          } else if (storedLineLooksTaxInclusive) {
            // Line total already matches Product Fees tree including FulfillmentFeeTax (all-in).
            incMag = mag;
          } else if (close(mag, rawNoTax) || mag < rawFull - eps) {
            // Common: DB line is core+add-ons ex-VAT only while API lists VAT separately — do not shrink the VAT base.
            const coreFrac = rc / rawNoTax;
            const addonFrac = ra / rawNoTax;
            incMag = amountInclVatFromEx(mag * coreFrac, feeVatRatePct) + mag * addonFrac;
          } else {
            // Fallback: same VAT-on-core split (avoids double-counting API tax + computed VAT).
            const coreFrac = rc / rawNoTax;
            const addonFrac = ra / rawNoTax;
            incMag = amountInclVatFromEx(mag * coreFrac, feeVatRatePct) + mag * addonFrac;
          }
          const rounded = Math.round(incMag * 100) / 100;
          displayFba = fbaFeeTotal <= 0 ? -rounded : rounded;
        } else {
          displayFba = grossUpNullable(fbaFeeTotal);
        }

        if (grossUpReferralAndDigitalForDisplay) {
          displayRef = grossUpNullable(referralFeeTotal);
          displayDig = grossUpNullable(digitalServiceFeeTotal);
        } else {
          displayRef = referralFeeTotal;
          displayDig = digitalServiceFeeTotal;
        }

        const sumIncComponents =
          (displayRef ?? 0) + (displayFba ?? 0) + (displayDig ?? 0);
        const hadAnyExVatComponent =
          referralFeeTotal != null ||
          fbaFeeTotal != null ||
          digitalServiceFeeTotal != null;
        if (hadAnyExVatComponent && Math.abs(sumIncComponents) > 1e-6) {
          displayFeesTotal = Math.round(sumIncComponents * 100) / 100;
        } else {
          displayFeesTotal = grossUpSignedFeeExVat(finalFeesForDisplay);
        }

        const refExMag = referralFeeTotal != null ? Math.abs(referralFeeTotal) : 0;
        const digExMag = digitalServiceFeeTotal != null ? Math.abs(digitalServiceFeeTotal) : 0;
        const fbaExMag = fbaFeeTotal != null ? Math.abs(fbaFeeTotal) : 0;
        const rc = fbaSplit?.rawCoreMag ?? 0;
        const ra = fbaSplit?.rawAddonMag ?? 0;
        const rt = fbaSplit?.rawTaxMag ?? 0;
        const rawNoTax = rc + ra;
        const rawFull = rc + ra + rt;
        const epsV =
          fbaExMag > 1e-6
            ? Math.max(0.02 * Math.max(fbaExMag, rawFull, rawNoTax), 0.01)
            : 0;
        const closeV = (a: number, b: number) =>
          b > 1e-9 && Math.abs(a - b) <= Math.max(epsV, 0.02 * b);
        let fbaVatForDisplay = 0;
        if (fbaExMag > 1e-6 && fbaSplit && rawNoTax > 1e-9) {
          if (rt < 1e-6) {
            const coreFrac = rc / rawNoTax;
            fbaVatForDisplay = vatAmountFromEx(fbaExMag * coreFrac, feeVatRatePct);
          } else if (
            rt > 1e-6 &&
            rawFull > 1e-9 &&
            closeV(fbaExMag, rawFull) &&
            fbaExMag + epsV >= rawNoTax + rt * 0.72
          ) {
            fbaVatForDisplay = fbaExMag * (rt / rawFull);
          } else if (closeV(fbaExMag, rawNoTax) || fbaExMag < rawFull - epsV) {
            const coreFrac = rc / rawNoTax;
            fbaVatForDisplay = vatAmountFromEx(fbaExMag * coreFrac, feeVatRatePct);
          } else {
            const coreFrac = rc / rawNoTax;
            fbaVatForDisplay = vatAmountFromEx(fbaExMag * coreFrac, feeVatRatePct);
          }
        } else if (fbaExMag > 1e-6) {
          fbaVatForDisplay = vatAmountFromEx(fbaExMag, feeVatRatePct);
        }
        const vatSum =
          (grossUpReferralAndDigitalForDisplay && refExMag > 1e-6
            ? vatAmountFromEx(refExMag, feeVatRatePct)
            : 0) +
          (grossUpReferralAndDigitalForDisplay && digExMag > 1e-6
            ? vatAmountFromEx(digExMag, feeVatRatePct)
            : 0) +
          (fbaVatForDisplay > 1e-6 ? fbaVatForDisplay : 0);
        displayAmazonFeesVat =
          vatSum > 1e-6 ? Math.round(vatSum * 100) / 100 : null;
        }
      }
      const cogsTotal = it.cogsTotal != null ? safeNum(it.cogsTotal) : null;
      const profitFeesBasis = showFeesIncVat ? displayFeesTotal : finalFeesForDisplay;
      // Profit = revenue - tax - COGS + fees (fees are negative, so + fees subtracts the cost)
      const profit =
        cogsTotal != null
          ? revenueTotal - taxChargedTotal - cogsTotal + profitFeesBasis
          : null;
      const salePrice = qty > 0 ? revenueTotal / qty : revenueTotal;
      const roiPct =
        profit != null && cogsTotal != null && cogsTotal > 0
          ? (profit / cogsTotal) * 100
          : null;
      const parentDt = (it as { order?: { orderDate?: unknown } }).order?.orderDate;
      const orderDate =
        parentDt instanceof Date
          ? parentDt.toISOString()
          : parentDt != null && parentDt !== ''
            ? new Date(parentDt as string | number).toISOString()
            : it.orderDate instanceof Date
              ? it.orderDate.toISOString()
              : String(it.orderDate ?? '');
      const isRefundLine = !exclusionKind && revenueTotal < 0;
      const isClearedNotPending =
        !exclusionKind && Math.abs(revenueTotal) < 1e-9 && !allowRecon;
      const excludedFromSales =
        exclusionKind != null || isRefundLine || isClearedNotPending;
      /** Seller Central–style “orders” count: exclude cancelled only; Pending, Shipped, PendingReturn, returns, etc. still count as an order. */
      const excludedFromOrderCount = exclusionKind === 'cancelled';
      const excludedFromProfitMetrics = exclusionKind != null;
      const orderStatusLabel = exclusionKind
        ? this.orderSalesExclusionDisplayLabel(exclusionKind)
        : isRefundLine
          ? 'Refund'
          : null;
      let outSalePrice = Math.round(salePrice * 100) / 100;
      let outProfit = profit != null ? Math.round(profit * 100) / 100 : null;
      let outRoi = roiPct != null ? Math.round(roiPct * 10) / 10 : null;
      let outFees = Number.isFinite(
        showFeesIncVat ? displayFeesTotal : finalFeesForDisplay,
      )
        ? Math.round(
            (showFeesIncVat ? displayFeesTotal : finalFeesForDisplay) * 100,
          ) / 100
        : 0;
      // Referral: Product-fee estimates get ex→inc gross-up; settled Finances values stay as stored (already SC-shaped).
      let outRef =
        (showFeesIncVat ? displayRef : referralFeeTotal) ?? null;
      let outFba =
        (showFeesIncVat ? displayFba : fbaFeeTotal) ?? null;
      let outDig =
        (showFeesIncVat ? displayDig : digitalServiceFeeTotal) ?? null;
      if (exclusionKind != null) {
        outSalePrice = 0;
        outProfit = null;
        outRoi = null;
        outFees = 0;
        outRef = null;
        outFba = null;
        outDig = null;
      } else if (isRefundLine) {
        outSalePrice = 0;
        outRoi = null;
      }
      const fulfillmentType =
        exclusionKind != null
          ? null
          : this.parseOrderLineFulfillmentLabel((it as { rawResponse?: unknown }).rawResponse);
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
        salePrice: outSalePrice,
        profit: outProfit,
        roiPct: outRoi,
        amazonFeesTotal: outFees,
        referralFeeTotal: outRef,
        fbaFeeTotal: outFba,
        digitalServiceFeeTotal: outDig,
        feesSource: feesSource != null ? String(feesSource) : null,
        amazonFeesVatAmount:
          excludedFromSales
            ? null
            : showFeesIncVat
              ? displayAmazonFeesVat
              : null,
        /** AFN → FBA, MFN → FBM from SP-API line payload when present. */
        fulfillmentType,
        availableStock: inv?.availableQty ?? null,
        totalStock: inv?.totalQty ?? null,
        orderStatusLabel,
        excludedFromSales,
        excludedFromProfitMetrics,
        excludedFromOrderCount,
      };
    });
      // Show a realistic stock progression across recent rows for the same product:
      // newest row uses current available stock, older rows step up by sold qty.
      const soldSoFarByProduct = new Map<string, number>();
      for (const row of mappedRows) {
        const pid = row.__productId;
        if (!pid) continue;
        if ((row as { excludedFromSales?: boolean }).excludedFromSales) continue;
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
        currentListedPriceUpdatedAt: true,
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

    const numOrNaN = (v: unknown): number => {
      if (v == null) return NaN;
      if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
      if (typeof v === 'object' && v !== null && 'toNumber' in v && typeof (v as { toNumber: () => number }).toNumber === 'function') {
        const n = (v as { toNumber: () => number }).toNumber();
        return Number.isFinite(n) ? n : NaN;
      }
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    };

    /** Same SKU can exist on multiple org members' Product rows; canonical pick may have inventory but no COGS. */
    const mergeSiblingSkuFields = (
      canonical: InventoryProductRow,
      group: InventoryProductRow[],
    ): InventoryProductRow => {
      const sorted = [...group].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      const cCanon = numOrNaN((canonical as any).costOfGoods);
      if (!Number.isFinite(cCanon) || cCanon <= 0) {
        for (const row of sorted) {
          const n = numOrNaN((row as any).costOfGoods);
          if (Number.isFinite(n) && n > 0) {
            (canonical as any).costOfGoods = n;
            break;
          }
        }
      }
      const pCanon = numOrNaN((canonical as any).currentListedPrice);
      if (!Number.isFinite(pCanon) || pCanon <= 0) {
        for (const row of sorted) {
          const n = numOrNaN((row as any).currentListedPrice);
          if (Number.isFinite(n) && n > 0) {
            (canonical as any).currentListedPrice = n;
            break;
          }
        }
      }
      if (!(canonical as any).estimatedAmazonFeeUpdatedAt) {
        for (const row of sorted) {
          if ((row as any).estimatedAmazonFeeUpdatedAt) {
            (canonical as any).estimatedAmazonFeePerUnit = (row as any).estimatedAmazonFeePerUnit;
            (canonical as any).estimatedReferralFeePerUnit = (row as any).estimatedReferralFeePerUnit;
            (canonical as any).estimatedFbaFeePerUnit = (row as any).estimatedFbaFeePerUnit;
            (canonical as any).estimatedAmazonFeeUpdatedAt = (row as any).estimatedAmazonFeeUpdatedAt;
            (canonical as any).feeEstimateRawJson = (row as any).feeEstimateRawJson;
            break;
          }
        }
      }
      if ((canonical as any).estimatedReferralFeePerUnit == null) {
        for (const row of sorted) {
          if ((row as any).estimatedReferralFeePerUnit != null) {
            (canonical as any).estimatedReferralFeePerUnit = (row as any).estimatedReferralFeePerUnit;
            break;
          }
        }
      }
      if ((canonical as any).estimatedFbaFeePerUnit == null) {
        for (const row of sorted) {
          if ((row as any).estimatedFbaFeePerUnit != null) {
            (canonical as any).estimatedFbaFeePerUnit = (row as any).estimatedFbaFeePerUnit;
            break;
          }
        }
      }
      return canonical;
    };

    const rowsGroupedBySku = new Map<string, InventoryProductRow[]>();
    for (const p of rows) {
      const arr = rowsGroupedBySku.get(p.sku) ?? [];
      arr.push(p);
      rowsGroupedBySku.set(p.sku, arr);
    }
    const bySku = new Map<string, InventoryProductRow>();
    for (const [, group] of rowsGroupedBySku) {
      const canonical = group.reduce((a, b) => pickCanonicalForSku(a, b));
      bySku.set(canonical.sku, mergeSiblingSkuFields(canonical, group));
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
      // When a marketplace is selected, prefer that row *when present* but fall back to
      // the aggregated inventory snapshot so we don't zero-out stock when per-marketplace is missing.
      availableQty: marketplaceId ? (selectedAvailable ?? p.inventory?.availableQty ?? null) : p.inventory?.availableQty ?? null,
      reservedQty: marketplaceId ? (selectedReserved ?? p.inventory?.reservedQty ?? null) : p.inventory?.reservedQty ?? null,
      inboundQty: marketplaceId ? (selectedInbound ?? p.inventory?.inboundQty ?? null) : p.inventory?.inboundQty ?? null,
      issueQty: marketplaceId ? (selectedIssue ?? p.inventory?.issueQty ?? null) : p.inventory?.issueQty ?? null,
      totalQty: marketplaceId ? (selectedTotal ?? p.inventory?.totalQty ?? null) : p.inventory?.totalQty ?? null,
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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

    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
    
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
            const now = new Date();
            await this.prisma.product.update({
              where: { id: product.id },
              data: {
                feeEstimateRawJson: res ?? undefined,
                ...(persistPrice ? ({ currentListedPrice: listingPriceToPersist, currentListedPriceUpdatedAt: now } as any) : {}),
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
        const now = new Date();
        await this.prisma.product.update({
          where: { id: product.id },
          data: {
            feeEstimateRawJson: res ?? undefined,
            ...(persistPrice ? ({ currentListedPrice: listingPriceToPersist, currentListedPriceUpdatedAt: now } as any) : {}),
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

  /**
   * Refresh Product.currentListedPrice from the Listings API only (no Product Fees calls).
   * Intended for a frequent scheduler so sellers see price changes within ~30 minutes; full fee
   * estimates stay on the daily fee-estimate-refresh job.
   */
  async refreshListedPricesForOrg(
    orgId: string,
    options?: {
      mode?: 'hot' | 'cold' | 'all';
      onProgress?: (progress: { processed: number; total: number }) => void | Promise<void>;
    },
  ): Promise<{
    skipped?: boolean;
    reason?: string;
    updatedCount: number;
    errorCount: number;
    notFoundCount: number;
    total: number;
    processed: number;
  }> {
    const credentials = await this.getAmazonCredentialsForOrg(orgId);
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
    const listingMarketplaceTryOrder = this.spApiClient.marketplaceIdsForListingPriceRefresh(
      credentials.region,
    );

    const account = await this.prisma.sellerAccount.findFirst({
      where: { userId: { in: userIds }, marketplace: 'amazon' },
      orderBy: { updatedAt: 'desc' },
      select: { sellerId: true },
    });
    const sellerId = account?.sellerId ?? null;
    if (!sellerId) {
      return {
        skipped: true,
        reason: 'no_seller_id',
        updatedCount: 0,
        errorCount: 0,
        notFoundCount: 0,
        total: 0,
        processed: 0,
      };
    }

    const batchSize = 50;
    const delayMs = Math.max(
      100,
      Number(this.configService.get<string>('LISTING_PRICE_REFRESH_DELAY_MS')) || 300,
    );
    const retryWaitMs = 60000;

    const mode = options?.mode ?? 'all';
    const now = Date.now();
    const recentlySoldSince = new Date(
      now - (Number(this.configService.get<string>('LISTING_PRICE_HOT_RECENTLY_SOLD_WITHIN_HOURS')) || 72) * 60 * 60 * 1000,
    );

    const hotWhere = {
      userId: { in: userIds },
      sku: { not: '' },
      OR: [
        { inventory: { is: { totalQty: { gt: 0 } } } },
        { orderItems: { some: { createdAt: { gte: recentlySoldSince } } } },
      ],
    } as const;

    const coldWhere = {
      userId: { in: userIds },
      sku: { not: '' },
      NOT: hotWhere,
    } as const;

    const where =
      mode === 'hot' ? hotWhere : mode === 'cold' ? coldWhere : { userId: { in: userIds }, sku: { not: '' } };

    const totalProductCount = await this.prisma.product.count({ where: where as any });
    if (totalProductCount === 0) {
      return { updatedCount: 0, errorCount: 0, notFoundCount: 0, total: 0, processed: 0 };
    }

    await options?.onProgress?.({ processed: 0, total: totalProductCount });

    let updatedCount = 0;
    let errorCount = 0;
    let notFoundCount = 0;
    let processed = 0;
    let cursorId: string | undefined;

    while (true) {
      const products = await this.prisma.product.findMany({
        where: where as any,
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        select: { id: true, sku: true },
      });
      if (products.length === 0) break;

      for (const product of products) {
        await new Promise((r) => setTimeout(r, delayMs));
        const run = async (): Promise<boolean> => {
          // GET list listings item: max 1 marketplaceId per request (Amazon returns 400 if many).
          let lastErr: Error | null = null;
          for (const mid of listingMarketplaceTryOrder) {
            try {
              const listingRes = await this.spApiClient.getListingsItem(
                credentials,
                sellerId,
                product.sku,
                [mid],
                ['summaries', 'offers', 'attributes'],
              );
              const parsed = this.parseListingsItemPrice(listingRes as any);
              if (parsed != null && parsed > 0) {
                await this.prisma.product.update({
                  where: { id: product.id },
                  data: { currentListedPrice: parsed, currentListedPriceUpdatedAt: new Date() } as any,
                });
                return true;
              }
            } catch (e) {
              lastErr = e instanceof Error ? e : new Error(String(e));
              const msg = lastErr.message ?? '';
              const is404 = msg.includes('(404)') && msg.includes('/listings/');
              const isTooManyMids =
                msg.includes('(400)') &&
                (msg.includes('marketplaceIds') || msg.includes('Too many'));
              if (is404 || isTooManyMids) continue;
              throw lastErr;
            }
          }
          if (lastErr) throw lastErr;
          return false;
        };

        try {
          const ok = await run();
          if (ok) updatedCount += 1;
        } catch (e) {
          const msg = (e as Error).message ?? '';
          const is429 = msg.includes('(429)') || msg.includes('QuotaExceeded');
          const isListings404 = msg.includes('(404)') && msg.includes('/listings/');
          if (is429) {
            this.logger.warn(
              `[refreshListedPricesForOrg] SKU ${product.sku} rate limited (429); waiting ${retryWaitMs / 1000}s…`,
            );
            await new Promise((r) => setTimeout(r, retryWaitMs));
            try {
              const ok = await run();
              if (ok) updatedCount += 1;
            } catch (retryErr) {
              const rmsg = (retryErr as Error).message ?? '';
              const retry404 = rmsg.includes('(404)') && rmsg.includes('/listings/');
              if (retry404) {
                notFoundCount += 1;
              } else {
                this.logger.warn(
                  `[refreshListedPricesForOrg] SKU ${product.sku} failed after retry: ${rmsg}`,
                );
                errorCount += 1;
              }
            }
          } else if (isListings404) {
            notFoundCount += 1;
          } else {
            this.logger.warn(`[refreshListedPricesForOrg] SKU ${product.sku} failed: ${msg}`);
            errorCount += 1;
          }
        }

        processed += 1;
        await options?.onProgress?.({ processed, total: totalProductCount });
      }

      cursorId = products[products.length - 1].id;
      if (products.length < batchSize) break;
    }

    this.logger.log(
      `[refreshListedPricesForOrg] org=${orgId} updated=${updatedCount} notFound=${notFoundCount} errors=${errorCount} processed=${processed}/${totalProductCount}`,
    );
    return { updatedCount, errorCount, notFoundCount, total: totalProductCount, processed };
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
    let referralFee: number | null = null;
    let fbaFee: number | null = null;
    let digitalServiceFee: number | null = null;

    const normType = (t: unknown) => String(t ?? '').replace(/\s+/g, '').toUpperCase();
    const isReferralType = (t: string) => t === 'REFERRALFEE' || t.endsWith('REFERRALFEE');
    const isDigitalType = (t: string) =>
      t === 'VARIABLECLOSINGFEE' || t === 'DIGITALSERVICEFEE' || t.includes('DIGITALSERVICE');
    const isFbaLeafType = (t: string) => t === 'FBAFEES' || t.startsWith('FBA');

    /** Classify only leaf rows so we never add parent + IncludedFeeDetailList (avoids double-counting totals). */
    let referralSum = 0;
    let fbaSum = 0;
    let digitalSum = 0;
    let otherLeafSum = 0;
    const visitFeeLeaves = (nodes: any[] | undefined) => {
      if (!Array.isArray(nodes)) return;
      for (const item of nodes) {
        const included = item.IncludedFeeDetailList ?? item.includedFeeDetailList;
        if (Array.isArray(included) && included.length > 0) {
          visitFeeLeaves(included);
          continue;
        }
        const feeType = normType(item.FeeType ?? item.feeType ?? '');
        const amount = moneyToNum(item.FeeAmount ?? item.feeAmount ?? item.FinalFee ?? item.finalFee);
        if (!Number.isFinite(amount)) continue;
        if (isReferralType(feeType)) referralSum += amount;
        else if (isDigitalType(feeType)) digitalSum += amount;
        else if (isFbaLeafType(feeType)) fbaSum += amount;
        else otherLeafSum += amount;
      }
    };

    if (Array.isArray(list) && list.length > 0) {
      visitFeeLeaves(list);
    }

    // Authoritative total: Amazon's rollup first (matches Seller Central), then leaf-sum helper, then sum of classified leaves.
    let authoritativeTotal: number | null = null;
    const totalEst = fees.TotalFeesEstimate ?? fees.totalFeesEstimate;
    if (totalEst != null) {
      const t = Math.abs(moneyToNum(totalEst));
      if (Number.isFinite(t) && t > 0) authoritativeTotal = t;
    }
    if (authoritativeTotal == null || authoritativeTotal < 1e-9) {
      const fromApiSum = this.parseFeesEstimateAmount(res);
      if (fromApiSum != null && Number.isFinite(fromApiSum)) {
        const t = Math.abs(fromApiSum);
        if (t > 0) authoritativeTotal = t;
      }
    }
    const leafPartsAbs =
      Math.abs(referralSum) + Math.abs(fbaSum) + Math.abs(digitalSum) + Math.abs(otherLeafSum);
    if (authoritativeTotal == null || authoritativeTotal < 1e-9) {
      if (leafPartsAbs > 0) authoritativeTotal = leafPartsAbs;
    }

    // Scale classified buckets to match authoritative total (handles aggregate rows we skipped on leaves).
    let refM = Math.abs(referralSum);
    let fbaM = Math.abs(fbaSum);
    let digM = Math.abs(digitalSum);
    let othM = Math.abs(otherLeafSum);
    const parts = refM + fbaM + digM + othM;
    if (authoritativeTotal != null && parts > 1e-9) {
      const diff = Math.abs(authoritativeTotal - parts);
      if (diff > 0.02) {
        const scale = authoritativeTotal / parts;
        refM *= scale;
        fbaM *= scale;
        digM *= scale;
        othM *= scale;
      }
    }
    // Bucket uncategorized Amazon line fees with FBA for storage (no separate column).
    fbaM += othM;

    if (refM > 1e-6) referralFee = refM;
    if (fbaM > 1e-6) fbaFee = fbaM;
    if (digM > 1e-6) digitalServiceFee = digM;

    const totalMag =
      authoritativeTotal != null && Number.isFinite(authoritativeTotal) && authoritativeTotal > 0
        ? authoritativeTotal
        : parts > 0
          ? parts
          : null;

    return {
      total: totalMag,
      referralFee:
        referralFee != null && Number.isFinite(referralFee) ? Math.abs(referralFee) : referralFee,
      fbaFee: fbaFee != null && Number.isFinite(fbaFee) ? Math.abs(fbaFee) : fbaFee,
      digitalServiceFee:
        digitalServiceFee != null && Number.isFinite(digitalServiceFee)
          ? Math.abs(digitalServiceFee)
          : digitalServiceFee,
    };
  }

  /**
   * From Product Fees `feeEstimateRawJson`, read absolute magnitudes for **FBA core** (VATable),
   * **fuel / logistics add-ons** (ex-VAT on top in UK SC), and **fulfillment tax lines** (e.g. FulfillmentFeeTax).
   * Returns null if FeeDetailList is missing.
   */
  private parseProductFeesFbaUkVatSplitMags(
    res: unknown,
  ): { rawCoreMag: number; rawAddonMag: number; rawTaxMag: number } | null {
    const result =
      (res as any)?.payload?.FeesEstimateResult ??
      (res as any)?.FeesEstimateResult ??
      res;
    if (!result || typeof result !== 'object') return null;
    const fees = (result as any).FeesEstimate ?? (result as any).feesEstimate;
    if (!fees) return null;
    const list = fees.FeeDetailList ?? fees.feeDetailList;
    if (!Array.isArray(list) || list.length === 0) return null;

    const moneyToNum = (m: any): number => {
      if (m == null) return 0;
      const a =
        m.Amount ??
        m.amount ??
        m.CurrencyAmount ??
        (typeof m.CurrencyAmount === 'object' ? m.CurrencyAmount?.Amount : null);
      if (typeof a === 'number' && Number.isFinite(a)) return a;
      if (typeof a === 'string') return parseFloat(a) || 0;
      return 0;
    };
    const normType = (t: unknown) => String(t ?? '').replace(/\s+/g, '').toUpperCase();
    const isReferralType = (t: string) => t === 'REFERRALFEE' || t.endsWith('REFERRALFEE');
    const isDigitalType = (t: string) =>
      t === 'VARIABLECLOSINGFEE' || t === 'DIGITALSERVICEFEE' || t.includes('DIGITALSERVICE');
    const isFbaLeafType = (t: string) => t === 'FBAFEES' || t.startsWith('FBA');
    const isFbaFuelLogisticsAddonType = (t: string) => {
      const u = normType(t);
      return (
        u.includes('FUEL') ||
        u.includes('INFLATION') ||
        u.includes('LOWCARBON') ||
        (u.includes('SURCHARGE') && !u.includes('REFERRAL')) ||
        u.includes('LOGISTICS')
      );
    };
    /** Product Fees may list VAT on fulfillment separately (e.g. FulfillmentFeeTax) — do not gross that up again. */
    const isFbaProductTaxLine = (t: string) => {
      const u = normType(t);
      if (u.includes('REFERRAL') || u.includes('COMMISSION')) return false;
      if (u.includes('DIGITAL')) return false;
      if (u.includes('SHIPPING')) return false;
      return (
        u === 'FULFILLMENTFEETAX' ||
        u.endsWith('FULFILLMENTFEETAX') ||
        (u.includes('FULFILLMENT') && u.includes('TAX')) ||
        (u.startsWith('FBA') && u.includes('TAX'))
      );
    };

    let fbaCoreMag = 0;
    let fbaAddonMag = 0;
    let fbaTaxMag = 0;
    const visit = (nodes: any[] | undefined) => {
      if (!Array.isArray(nodes)) return;
      for (const item of nodes) {
        const included = item.IncludedFeeDetailList ?? item.includedFeeDetailList;
        if (Array.isArray(included) && included.length > 0) {
          visit(included);
          continue;
        }
        const feeType = normType(item.FeeType ?? item.feeType ?? '');
        const rawAmt = moneyToNum(
          item.FeeAmount ?? item.feeAmount ?? item.FinalFee ?? item.finalFee,
        );
        if (!Number.isFinite(rawAmt)) continue;
        const mag = Math.abs(rawAmt);
        if (mag < 1e-9) continue;
        if (isReferralType(feeType) || isDigitalType(feeType)) continue;
        if (isFbaLeafType(feeType)) {
          if (isFbaProductTaxLine(feeType)) fbaTaxMag += mag;
          else if (isFbaFuelLogisticsAddonType(feeType)) fbaAddonMag += mag;
          else fbaCoreMag += mag;
        } else if (isFbaProductTaxLine(feeType)) {
          fbaTaxMag += mag;
        } else {
          // Same as `parseFeesEstimateBreakdown`: other leaves roll into FBA — treat as VATable core.
          fbaCoreMag += mag;
        }
      }
    };
    visit(list);
    if (fbaCoreMag + fbaAddonMag + fbaTaxMag < 1e-9) return null;
    return {
      rawCoreMag: fbaCoreMag,
      rawAddonMag: fbaAddonMag,
      rawTaxMag: fbaTaxMag,
    };
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

  async backfillOrderItems(
    userId: string,
    days = 30,
    opts?: { amazonOrderId?: string },
  ) {
    const credentials = await this.getAmazonCredentialsForUser(userId);

    const nowSafe = new Date(Date.now() - 5 * 60 * 1000);
    const startDate = new Date(nowSafe.getTime() - days * 24 * 60 * 60 * 1000);
    /** Same knob as order sync — long backfills hammer Finances quotas without a pause. */
    const backfillFinancesPauseMs = Math.max(
      400,
      Number(this.configService.get<string>('AMAZON_ORDER_FINANCES_PAUSE_MS')) || 2200,
    );

    const targetOrderId = opts?.amazonOrderId?.trim() ?? '';
    let orders: Array<{
      id: string;
      orderId: string;
      orderDate: Date;
      rawResponse: unknown;
    }>;
    if (targetOrderId) {
      const one = await this.prisma.order.findFirst({
        where: { userId, marketplace: 'amazon', orderId: targetOrderId },
        select: {
          id: true,
          orderId: true,
          orderDate: true,
          rawResponse: true,
        },
      });
      if (!one) {
        throw new NotFoundException(
          `No order row for amazonOrderId=${targetOrderId} (user scope).`,
        );
      }
      orders = [one];
      this.logger.log(
        `[backfillOrderItems] single-order mode userId=${userId.slice(0, 8)}… amazonOrderId=${targetOrderId} (ignores days=…; one Finances pull)`,
      );
    } else {
      orders = await this.prisma.order.findMany({
        where: {
          userId,
          marketplace: 'amazon',
          orderDate: { gte: startDate, lte: nowSafe },
        },
        select: {
          id: true,
          orderId: true,
          orderDate: true,
          rawResponse: true,
        },
        orderBy: { orderDate: 'desc' },
      });
      this.logger.log(
        `[backfillOrderItems] userId=${userId.slice(0, 8)}… days=${days} orders=${orders.length}; ` +
          `Finances pacing ~${backfillFinancesPauseMs}ms between orders (min ~${((orders.length * backfillFinancesPauseMs) / 60000).toFixed(1)} min from pauses alone, plus SP-API latency)`,
      );
    }

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
      // Match syncRecentOrdersToDb: first non-zero fee; last non-zero breakdown (see shipmentLists order).
      const addFee = (
        map: Map<string, number>,
        key: string,
        amount: number,
      ) => {
        if (!key || amount === 0 || !Number.isFinite(amount)) return;
        const prev = map.get(key) ?? 0;
        if (prev !== 0) return;
        map.set(key, amount);
      };
      const addFeeBreakdownBackfill = (
        map: Map<string, FeeBreakdownBackfill>,
        key: string,
        r: number,
        f: number,
        d: number,
      ) => {
        if (!key) return;
        const mag = Math.abs(r) + Math.abs(f) + Math.abs(d);
        if (mag < 1e-9) return;
        map.set(key, { referral: r, fba: f, digital: d });
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

        const recursiveSignedBf = sumCurrencyAmountsByKey(finRes, 'FeeAmount');
        amazonFeesTotal = recursiveSignedBf;

        const events =
          finRes?.payload?.FinancialEvents ??
          finRes?.payload?.financialEvents ??
          {};
        const shipmentLists = [
          ...(events?.ShipmentEventList ?? events?.shipmentEventList ?? []),
          ...(events?.ShipmentSettleEventList ?? events?.shipmentSettleEventList ?? []),
          ...(events?.DeferredTransactionEventList ?? events?.deferredTransactionEventList ?? []),
          ...(events?.RefundEventList ?? events?.refundEventList ?? []),
          ...(events?.ChargebackEventList ?? events?.chargebackEventList ?? []),
          ...(events?.GuaranteeClaimEventList ?? events?.guaranteeClaimEventList ?? []),
        ];
        for (const ev of shipmentLists) {
          const items = ev?.ShipmentItemList ?? ev?.shipmentItemList ?? [];
          for (const si of items) {
            const fee = parseFinancesShipmentItemFeesSignedTotal(si);
            const orderItemIdRaw = si?.OrderItemId ?? si?.orderItemId;
            const orderItemId = orderItemIdRaw != null ? String(orderItemIdRaw) : '';
            const sku = (si?.SellerSKU ?? si?.sellerSKU) as string | undefined;
            if (fee !== 0) {
              if (orderItemId) addFee(feeByOrderItemId, orderItemId, fee);
              if (sku) addFee(feeBySku, sku, fee);
            }
            const shipBd = parseFinancesShipmentItemFeesBreakdown(si);
            const { referral: r, fba: f, digital: d } = shipBd;
            if (orderItemId) addFeeBreakdownBackfill(breakdownByOrderItemId, orderItemId, r, f, d);
            if (sku) addFeeBreakdownBackfill(breakdownBySku, sku, r, f, d);
          }
        }
        const itemizedSignedSumBf =
          feeByOrderItemId.size > 0
            ? [...feeByOrderItemId.values()].reduce((a, b) => a + b, 0)
            : [...feeBySku.values()].reduce((a, b) => a + b, 0);
        if (Math.abs(itemizedSignedSumBf) > 1e-6) {
          amazonFeesTotal = itemizedSignedSumBf;
        }
      } catch (err) {
        console.warn(
          '[AmazonService.backfillOrderItems] listFinancialEventsByOrderId failed',
          { userId, amazonOrderId, err },
        );
      }

      // Finances v0 can be empty for deferred orders even when Seller Central shows "Order Payment".
      // Use Finances 2024-06-19 transactions (ORDER_ID) as a fallback to get the correct fee totals.
      if (feeByOrderItemId.size === 0 && feeBySku.size === 0) {
        try {
          const mpFromOrderItems =
            this.extractMarketplaceIdFromOrdersGetOrderItemsPayload({ payload: { OrderItems: orderItems } }) ??
            (credentials.region === 'eu'
              ? 'A1F83G8C2ARO7P'
              : credentials.region === 'fe'
                ? 'A1VC38T7YXB528'
                : 'ATVPDKIKX0DER');
          const { postedAfter, postedBefore } = this.finances2024ListTransactionsMaxPostedWindowIso();
          const sweepStatuses = ['DEFERRED', 'DEFERRED_RELEASED', 'RELEASED'] as const;
          const txAgg: any[] = [];
          const seen = new Set<string>();
          const push = (arr: any[]) => {
            for (const t of arr) {
              const id = String(t?.transactionId ?? t?.TransactionId ?? '');
              const key = id || JSON.stringify(t).slice(0, 400);
              if (seen.has(key)) continue;
              seen.add(key);
              txAgg.push(t);
            }
          };
          for (const st of sweepStatuses) {
            const r = await this.finances2024ListTransactionsFetchAllPages(credentials, {
              marketplaceId: mpFromOrderItems,
              postedAfter,
              postedBefore,
              transactionStatus: st,
              relatedIdentifierName: 'ORDER_ID',
              relatedIdentifierValue: amazonOrderId,
            });
            push(r.transactions as any[]);
            await new Promise<void>((r2) => setTimeout(r2, 250));
          }
          {
            const r = await this.finances2024ListTransactionsFetchAllPages(credentials, {
              marketplaceId: mpFromOrderItems,
              postedAfter,
              postedBefore,
              transactionStatus: null,
              relatedIdentifierName: 'ORDER_ID',
              relatedIdentifierValue: amazonOrderId,
            });
            push(r.transactions as any[]);
          }

          const readAmt = (node: any): number => {
            const amtRaw =
              node?.breakdownAmount?.currencyAmount ??
              node?.breakdownAmount?.CurrencyAmount ??
              node?.breakdownAmount?.Amount ??
              node?.breakdownAmount?.amount ??
              node?.breakdownAmount ??
              node?.BreakdownAmount;
            const amt = Number(amtRaw);
            return Number.isFinite(amt) ? amt : 0;
          };
          const sumTarget = (
            node: any,
            targetTypes: Set<string>,
            out: Record<string, number>,
          ) => {
            if (!node) return;
            const t = String(node.breakdownType ?? node.BreakdownType ?? '').trim();
            if (t && targetTypes.has(t)) {
              const amt = readAmt(node);
              if (Math.abs(amt) > 1e-9) out[t] = (out[t] ?? 0) + amt;
              return;
            }
            const kids = node.breakdowns ?? node.Breakdowns;
            if (Array.isArray(kids)) for (const k of kids) sumTarget(k, targetTypes, out);
          };
          const targetTypes = new Set<string>([
            'Commission',
            'ReferralFee',
            'FixedClosingFee',
            'VariableClosingFee',
            'PerItemFee',
            'DigitalServicesFee',
            'FBAPerUnitFulfillmentFee',
            'FBAWeightBasedFee',
            'FBAFulfillmentFee',
          ]);

          for (const tx of txAgg) {
            const items = Array.isArray(tx?.items) ? tx.items : Array.isArray(tx?.Items) ? tx.Items : [];
            for (const it of items) {
              const rel = Array.isArray(it?.relatedIdentifiers)
                ? it.relatedIdentifiers
                : Array.isArray(it?.RelatedIdentifiers)
                  ? it.RelatedIdentifiers
                  : [];
              const idRow = rel.find(
                (r: any) =>
                  String(r?.itemRelatedIdentifierName ?? r?.ItemRelatedIdentifierName ?? '') ===
                  'ORDER_ADJUSTMENT_ITEM_ID',
              );
              const orderItemId =
                idRow?.itemRelatedIdentifierValue ?? idRow?.ItemRelatedIdentifierValue;
              const ctx0 = Array.isArray(it?.contexts)
                ? it.contexts[0]
                : Array.isArray(it?.Contexts)
                  ? it.Contexts[0]
                  : null;
              const sku = ctx0?.sku ?? ctx0?.Sku ?? null;
              const breakdowns = Array.isArray(it?.breakdowns)
                ? it.breakdowns
                : Array.isArray(it?.Breakdowns)
                  ? it.Breakdowns
                  : [];
              const sums: Record<string, number> = {};
              for (const b of breakdowns) sumTarget(b, targetTypes, sums);
              const digital = sums.DigitalServicesFee ?? 0;
              const closing =
                (sums.FixedClosingFee ?? 0) +
                (sums.VariableClosingFee ?? 0) +
                (sums.PerItemFee ?? 0);
              const referral = (sums.Commission ?? 0) + (sums.ReferralFee ?? 0) + closing;
              const fba =
                (sums.FBAPerUnitFulfillmentFee ?? 0) +
                (sums.FBAWeightBasedFee ?? 0) +
                (sums.FBAFulfillmentFee ?? 0);
              const feeTotal = Number((digital + referral + fba).toFixed(2));
              if (feeTotal === 0) continue;
              if (orderItemId) {
                addFee(feeByOrderItemId, String(orderItemId), feeTotal);
                addFeeBreakdownBackfill(
                  breakdownByOrderItemId,
                  String(orderItemId),
                  Number(referral.toFixed(2)),
                  Number(fba.toFixed(2)),
                  Number(digital.toFixed(2)),
                );
              }
              if (sku) {
                addFee(feeBySku, String(sku), feeTotal);
                addFeeBreakdownBackfill(
                  breakdownBySku,
                  String(sku),
                  Number(referral.toFixed(2)),
                  Number(fba.toFixed(2)),
                  Number(digital.toFixed(2)),
                );
              }
            }
          }
          const sum2024 =
            feeByOrderItemId.size > 0
              ? [...feeByOrderItemId.values()].reduce((a, b) => a + b, 0)
              : [...feeBySku.values()].reduce((a, b) => a + b, 0);
          if (Math.abs(sum2024) > 1e-6) amazonFeesTotal = sum2024;
        } catch {
          // ignore
        }
      }

      let orderTotalAmt = this.parseOrderTotalAmountFromOrderJson(ord.rawResponse);
      if (orderTotalAmt <= 0) {
        orderTotalAmt = orderItems.reduce(
          (s, item) => s + this.parseOrderItemLineRevenueFromRaw(item),
          0,
        );
      }
      const lineRevenues = this.computeLineRevenueTotals(orderItems, orderTotalAmt);
      const totalLineRevenue = lineRevenues.reduce((a, b) => a + b, 0);

      if (
        orderTotalAmt > 0.01 &&
        Math.abs(amazonFeesTotal) > orderTotalAmt * 0.35
      ) {
        const itemizedPost =
          feeByOrderItemId.size > 0
            ? [...feeByOrderItemId.values()].reduce((a, b) => a + b, 0)
            : [...feeBySku.values()].reduce((a, b) => a + b, 0);
        if (Math.abs(itemizedPost) < 1e-4) {
          amazonFeesTotal = -Math.min(
            Math.abs(amazonFeesTotal),
            orderTotalAmt * AmazonService.LIST_ORDERS_MAX_FEE_TO_REVENUE_RATIO,
          );
        }
      }

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

        let revenueTotal = lineRevenues[idx] ?? 0;
        const shippingCharged = Number(it?.ShippingPrice?.Amount ?? 0);
        const taxCharged = Number(it?.ItemTax?.Amount ?? 0);

        let itemFees = 0;
        let usedOrderLevelFinancesBf = false;
        if (orderItemId && feeByOrderItemId.has(orderItemId)) {
          itemFees = feeByOrderItemId.get(orderItemId) ?? 0;
        } else if (sku && feeBySku.has(sku)) {
          itemFees = feeBySku.get(sku) ?? 0;
        } else if (totalLineRevenue > 0 && amazonFeesTotal !== 0) {
          itemFees = (revenueTotal / totalLineRevenue) * amazonFeesTotal;
          usedOrderLevelFinancesBf = true;
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

        if (revenueTotal <= 0 && itemProduct) {
          const lp = (itemProduct as { currentListedPrice?: unknown }).currentListedPrice;
          const listNum = lp != null ? Number(lp) : 0;
          if (listNum > 0) {
            revenueTotal = Number((listNum * quantityOrdered).toFixed(2));
          }
        }

        const existingItem = await this.prisma.orderItem.findUnique({
          where: {
            orderDbId_orderItemId: { orderDbId: ord.id, orderItemId },
          },
          select: {
            amazonFeesTotal: true,
            profit: true,
            feesSource: true,
            atSaleEstimateReferralFeeTotal: true,
            atSaleEstimateFbaFeeTotal: true,
            atSaleEstimateDigitalServiceFeeTotal: true,
          },
        });

        const feesFromFinancesForLineBf =
          (orderItemId && feeByOrderItemId.has(orderItemId)) ||
          (sku && feeBySku.has(sku)) ||
          usedSameAsinSettled ||
          usedOrderLevelFinancesBf;

        const preserveFrozenEstimateBf =
          !feesFromFinancesForLineBf &&
          existingItem != null &&
          this.isPersistedAmazonFeeEstimateSource(existingItem.feesSource as string) &&
          existingItem.amazonFeesTotal != null &&
          Math.abs(Number(existingItem.amazonFeesTotal)) > 1e-9;

        let estimateSnapRefBf: number | null = null;
        let estimateSnapFbaBf: number | null = null;
        let estimateSnapDigBf: number | null = null;

        if (preserveFrozenEstimateBf) {
          let preserved = Number(existingItem!.amazonFeesTotal);
          if (preserved > 0) preserved = -Math.abs(preserved);
          itemFees = preserved;
        } else if (itemFees === 0 && !usedSameAsinSettled) {
          const fromProd = this.orderItemFeeEstimateFromPreSaleProduct(
            itemProduct as {
              estimatedReferralFeePerUnit?: unknown;
              estimatedFbaFeePerUnit?: unknown;
              estimatedDigitalServiceFeePerUnit?: unknown;
              estimatedAmazonFeePerUnit?: unknown;
            },
            quantityOrdered,
          );
          if (fromProd != null) {
            itemFees = fromProd.itemFees;
            estimateSnapRefBf = fromProd.referralLine;
            estimateSnapFbaBf = fromProd.fbaLine;
            estimateSnapDigBf = fromProd.digitalLine;
          } else if (sku) {
            const productWithEst = await this.prisma.product.findUnique({
              where: { userId_sku: { userId, sku } },
              select: {
                estimatedReferralFeePerUnit: true,
                estimatedFbaFeePerUnit: true,
                estimatedDigitalServiceFeePerUnit: true,
                estimatedAmazonFeePerUnit: true,
              },
            });
            const fromDb = this.orderItemFeeEstimateFromPreSaleProduct(
              productWithEst,
              quantityOrdered,
            );
            if (fromDb != null) {
              itemFees = fromDb.itemFees;
              estimateSnapRefBf = fromDb.referralLine;
              estimateSnapFbaBf = fromDb.fbaLine;
              estimateSnapDigBf = fromDb.digitalLine;
            }
          }
        }

        const cogsPerUnit = itemProduct.costOfGoods
          ? Number(itemProduct.costOfGoods)
          : null;
        const cogsTotal =
          cogsPerUnit != null ? cogsPerUnit * quantityOrdered : null;
        const feesFromFinances = feesFromFinancesForLineBf;
        const orderLineFeesSource = feesFromFinances ? 'finances' : 'estimate';
        // Same convention as sync: Finances fees are negative; estimates must not be positive here.
        if (!feesFromFinances && itemFees > 0) {
          itemFees = -Math.abs(itemFees);
        }
        const profit =
          cogsTotal != null
            ? revenueTotal - taxCharged - cogsTotal + itemFees
            : null;
        const settledBreakdown =
          (orderItemId && breakdownByOrderItemId.get(orderItemId)) ??
          (sku && breakdownBySku.get(sku)) ??
          null;
        let finalFees = Number.isNaN(itemFees) ? 0 : Number(itemFees.toFixed(2));
        let finalProfit = profit != null ? Number(profit.toFixed(2)) : null;
        // Never overwrite a saved estimate with 0: keep existing until settled fees arrive.
        if (
          finalFees === 0 &&
          existingItem &&
          existingItem.amazonFeesTotal != null &&
          Number(existingItem.amazonFeesTotal) !== 0 &&
          this.isPersistedAmazonFeeEstimateSource(existingItem.feesSource as string)
        ) {
          let reused = Number(existingItem.amazonFeesTotal);
          if (this.isPersistedAmazonFeeEstimateSource(existingItem.feesSource as string) && reused > 0) {
            reused = -Math.abs(reused);
          }
          finalFees = reused;
          finalProfit =
            cogsTotal != null
              ? Number((revenueTotal - taxCharged - cogsTotal + finalFees).toFixed(2))
              : null;
        }
        if (
          feesFromFinances &&
          settledBreakdown &&
          Math.abs(
            settledBreakdown.referral +
              settledBreakdown.fba +
              settledBreakdown.digital,
          ) > 1e-6
        ) {
          const sumBd =
            settledBreakdown.referral +
            settledBreakdown.fba +
            settledBreakdown.digital;
          finalFees = Number(sumBd.toFixed(2));
          finalProfit =
            cogsTotal != null
              ? Number((revenueTotal - taxCharged - cogsTotal + finalFees).toFixed(2))
              : null;
        }
        const updateFeeColumnsBf =
          feesFromFinances || (existingItem?.feesSource as string) !== 'finances';
        const shouldUpdateFeeColumnsBf =
          updateFeeColumnsBf && !preserveFrozenEstimateBf;
        const settledFeeFields =
          feesFromFinances && settledBreakdown
            ? {
                settledReferralFeeTotal: Number(settledBreakdown.referral.toFixed(2)),
                settledFbaFeeTotal: Number(settledBreakdown.fba.toFixed(2)),
                settledDigitalServiceFeeTotal: Number(settledBreakdown.digital.toFixed(2)),
              }
            : feesFromFinances
              ? {
                  settledReferralFeeTotal: null,
                  settledFbaFeeTotal: null,
                  settledDigitalServiceFeeTotal: null,
                }
              : {};
        let estimateSnapshotPayloadBf: Record<string, number | null> = {};
        if (shouldUpdateFeeColumnsBf) {
          if (feesFromFinancesForLineBf) {
            estimateSnapshotPayloadBf = {
              atSaleEstimateReferralFeeTotal: null,
              atSaleEstimateFbaFeeTotal: null,
              atSaleEstimateDigitalServiceFeeTotal: null,
            };
          } else if (orderLineFeesSource === 'estimate') {
            estimateSnapshotPayloadBf = {
              atSaleEstimateReferralFeeTotal: estimateSnapRefBf,
              atSaleEstimateFbaFeeTotal: estimateSnapFbaBf,
              atSaleEstimateDigitalServiceFeeTotal: estimateSnapDigBf,
            };
          }
        }
        const createEstimateSnapshotsBf =
          orderLineFeesSource === 'estimate' && !feesFromFinancesForLineBf
            ? {
                atSaleEstimateReferralFeeTotal: estimateSnapRefBf,
                atSaleEstimateFbaFeeTotal: estimateSnapFbaBf,
                atSaleEstimateDigitalServiceFeeTotal: estimateSnapDigBf,
              }
            : feesFromFinancesForLineBf
              ? {
                  atSaleEstimateReferralFeeTotal: null,
                  atSaleEstimateFbaFeeTotal: null,
                  atSaleEstimateDigitalServiceFeeTotal: null,
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
          profit: finalProfit,
          ...(shouldUpdateFeeColumnsBf
            ? {
                amazonFeesTotal: finalFees,
                feesSource: orderLineFeesSource,
                ...settledFeeFields,
                ...estimateSnapshotPayloadBf,
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
            feesSource: orderLineFeesSource,
            ...settledFeeFields,
            ...createEstimateSnapshotsBf,
            cogsTotal,
            profit: finalProfit,
            rawResponse: it,
            orderDate: ord.orderDate,
          },
        });
        upsertedItems += 1;
      }

      processedOrders += 1;
      if (processedOrders < orders.length) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, backfillFinancesPauseMs),
        );
      }
    }

    try {
      await this.recomputeDailyKpiSummary(userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[AmazonService.backfillOrderItems] recomputeDailyKpiSummary failed (non-fatal): ${msg}`,
      );
    }

    return {
      days: targetOrderId ? null : days,
      amazonOrderId: targetOrderId || null,
      startDate: targetOrderId ? null : startDate.toISOString(),
      endDate: targetOrderId ? null : nowSafe.toISOString(),
      processedOrders,
      upsertedItems,
      skippedNoItems,
      totalOrders: orders.length,
      approxFinancesPauseMsPerOrder: backfillFinancesPauseMs,
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

    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
      /** When true (e.g. spreadsheet bulk upload), skip updating `Product.costOfGoods`; caller syncs once per product after all rows. */
      skipSyncProductCostOfGoods?: boolean;
    },
  ) {
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);

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
    if (!dto.skipSyncProductCostOfGoods) {
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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);

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

  /**
   * Bulk-create COGS ledger rows from client-parsed spreadsheet rows (ASIN and/or SKU → product lookup).
   * Each row becomes one Purchase. `Product.costOfGoods` is synced **once per product after all rows**,
   * using the **last** successful row for that product, so listings not present in the file keep their costs.
   */
  async bulkUploadCostOfGoodsRows(
    orgId: string,
    userId: string,
    rows: unknown[],
  ): Promise<{
    created: number;
    errors: Array<{ rowIndex: number; asin?: string; message: string }>;
  }> {
    const MAX = 2000;
    if (!Array.isArray(rows)) {
      throw new BadRequestException('rows must be an array');
    }
    if (rows.length === 0) {
      throw new BadRequestException('rows is empty');
    }
    if (rows.length > MAX) {
      throw new BadRequestException(`At most ${MAX} rows per upload`);
    }

    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
    const errors: Array<{ rowIndex: number; asin?: string; message: string }> =
      [];
    let created = 0;

    const num = (v: unknown, def?: number): number | undefined => {
      if (v === null || v === undefined || v === '') return def;
      if (typeof v === 'number') {
        return Number.isFinite(v) ? v : def;
      }
      const cleaned = String(v).replace(/[£$€\s]/g, '').replace(/,/g, '');
      const n = parseFloat(cleaned);
      if (!Number.isFinite(n)) return def;
      return n;
    };

    const str = (v: unknown): string | undefined => {
      if (v === null || v === undefined) return undefined;
      const s = String(v).trim();
      return s === '' ? undefined : s;
    };

    const parseUkStyleNumericDate = (s: string): Date | undefined => {
      const m = s
        .trim()
        .match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/);
      if (!m) return undefined;
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      let y = parseInt(m[3], 10);
      if (y < 100) y += 2000;
      let day: number;
      let month: number;
      if (a > 12) {
        day = a;
        month = b;
      } else if (b > 12) {
        month = a;
        day = b;
      } else {
        // Both ≤12: assume day/month/year (UK-style), e.g. 4/2/2026 → 4 Feb 2026
        day = a;
        month = b;
      }
      const d = new Date(y, month - 1, day);
      if (
        Number.isNaN(d.getTime()) ||
        d.getFullYear() !== y ||
        d.getMonth() !== month - 1 ||
        d.getDate() !== day
      ) {
        return undefined;
      }
      return d;
    };

    const parseDate = (v: unknown): string | undefined => {
      if (v === null || v === undefined || v === '') return undefined;
      if (v instanceof Date && !Number.isNaN(v.getTime())) {
        return v.toISOString();
      }
      if (typeof v === 'number' && Number.isFinite(v)) {
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        const d = new Date(excelEpoch.getTime() + v * 86400000);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
      }
      const s = String(v).trim();
      const uk = parseUkStyleNumericDate(s);
      if (uk) return uk.toISOString();
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
      return undefined;
    };

    const normalizeAsin = (raw: string): string =>
      raw.replace(/\s/g, '').toUpperCase();

    /** Last successful row per product sets `Product.costOfGoods` after the upload loop. */
    const bulkDerivedCogsByProductId = new Map<string, number>();

    for (let i = 0; i < rows.length; i++) {
      const rowIndex = i + 1;
      const row = rows[i];
      if (!row || typeof row !== 'object') {
        errors.push({ rowIndex, message: 'Row is not an object' });
        continue;
      }
      const o = row as Record<string, unknown>;
      const asinRaw = str(o.asin);
      const skuRaw = str(o.sku);
      const skuNorm = skuRaw ? skuRaw.trim() : '';
      if (!asinRaw && !skuNorm) {
        errors.push({
          rowIndex,
          message: 'Missing ASIN or SKU (map at least one)',
        });
        continue;
      }
      const asin = asinRaw ? normalizeAsin(asinRaw) : '';
      if (asinRaw && !asin) {
        errors.push({ rowIndex, message: 'Invalid ASIN' });
        continue;
      }

      const unitCostIncVat = num(o.unitCostIncVat);
      if (unitCostIncVat === undefined || unitCostIncVat <= 0) {
        errors.push({
          rowIndex,
          asin: asin || undefined,
          message: 'unitCostIncVat must be a positive number',
        });
        continue;
      }

      let product: { id: string; userId: string } | null = null;
      if (skuNorm) {
        if (asin) {
          product = await this.prisma.product.findFirst({
            where: {
              userId: { in: userIds },
              sku: { equals: skuNorm, mode: 'insensitive' },
              asin: { equals: asin, mode: 'insensitive' },
            },
            select: { id: true, userId: true },
          });
        }
        if (!product) {
          product = await this.prisma.product.findFirst({
            where: {
              userId: { in: userIds },
              sku: { equals: skuNorm, mode: 'insensitive' },
            },
            select: { id: true, userId: true },
          });
        }
      }
      if (!product && asin) {
        product = await this.prisma.product.findFirst({
          where: {
            userId: { in: userIds },
            asin: { equals: asin, mode: 'insensitive' },
          },
          select: { id: true, userId: true },
        });
      }

      if (!product) {
        errors.push({
          rowIndex,
          asin: asin || undefined,
          message:
            skuNorm && asin
              ? 'No product with this SKU + ASIN in your account'
              : skuNorm
                ? 'No product with this SKU in your account'
                : 'No product with this ASIN in your account',
        });
        continue;
      }

      let purchaseDateIso: string;
      const pd = parseDate(o.purchaseDate);
      if (pd) {
        purchaseDateIso = pd;
      } else {
        purchaseDateIso = new Date().toISOString();
      }

      const qtyPurchased = Math.max(0, num(o.qtyPurchased, 1) ?? 1);
      const qtyDelivered = Math.max(0, num(o.qtyDelivered, 1) ?? 1);
      const deliveryCostIncVat = Math.max(
        0,
        num(o.deliveryCostIncVat, 0) ?? 0,
      );
      const prepCostIncVat = Math.max(0, num(o.prepCostIncVat, 0) ?? 0);
      const vatRatePct = Math.max(0, num(o.vatRatePct, 0) ?? 0);

      const totalLineIncVat =
        unitCostIncVat + deliveryCostIncVat + prepCostIncVat;
      const vatFactor = 1 + (vatRatePct > 0 ? vatRatePct / 100 : 0);
      const derivedRounded = Number.isFinite(totalLineIncVat)
        ? Number(
            (vatFactor > 0 ? totalLineIncVat / vatFactor : totalLineIncVat).toFixed(
              2,
            ),
          )
        : null;

      try {
        await this.createPurchase(orgId, product.userId, {
          productId: product.id,
          fulfilment: str(o.fulfilment) ?? 'FBA',
          supplier: str(o.supplier),
          supplierLink: str(o.supplierLink),
          bundleSize: Math.max(1, Math.floor(num(o.bundleSize, 1) ?? 1)),
          purchaseDate: purchaseDateIso,
          orderNumber: str(o.orderNumber),
          shipmentId: str(o.shipmentId),
          qtyPurchased,
          qtyDelivered,
          currency: (str(o.currency) ?? 'GBP').toUpperCase(),
          vatRatePct,
          unitCostIncVat,
          deliveryCostIncVat,
          prepCostIncVat,
          skipSyncProductCostOfGoods: true,
        });
        created += 1;
        if (derivedRounded != null) {
          bulkDerivedCogsByProductId.set(product.id, derivedRounded);
        }
      } catch (e: unknown) {
        const msg =
          e instanceof Error
            ? e.message
            : typeof e === 'string'
              ? e
              : 'Failed to create entry';
        errors.push({ rowIndex, asin: asin || undefined, message: msg });
      }
    }

    for (const [productId, rounded] of bulkDerivedCogsByProductId) {
      try {
        await this.updateProductCostOfGoods(orgId, productId, rounded);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(
          `[bulkUploadCostOfGoodsRows] updateProductCostOfGoods failed productId=${productId}: ${msg}`,
        );
      }
    }

    return { created, errors };
  }

  async seedCostOfGoodsEntriesFromProducts(orgId: string) {
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);

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
    const userIds = await this.getOrgAmazonAggregateUserIds(orgId);
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
        };
      }
      return {
        productId: id,
        sku: id,
        asin: null as string | null,
        title: null as string | null,
        imageUrl: null as string | null,
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
