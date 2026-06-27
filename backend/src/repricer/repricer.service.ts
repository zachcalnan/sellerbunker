import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { AmazonSpApiClient, SpApiCredentials } from '../amazon/sp-api.client';
import { AmazonService } from '../amazon/amazon.service';

@Injectable()
export class RepricerService {
  private readonly logger = new Logger(RepricerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly spApiClient: AmazonSpApiClient,
    private readonly amazonService: AmazonService,
  ) {}

  private async getOrgMemberUserIds(orgId: string): Promise<string[]> {
    return this.usersService.getOrgMemberUserIds(orgId);
  }

  private isSuspiciousCogs(cost: number | null, currentPrice: number | null): boolean {
    if (cost == null || !Number.isFinite(cost) || cost <= 0) return false;
    if (currentPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0) return false;
    // If an item sells for meaningful money but COGS is tiny, it is usually a bad COGS entry (wrong unit / divided twice).
    // Avoid repricing on it and avoid showing misleading ROI%.
    return currentPrice >= 10 && cost < 1;
  }

  private static readonly REPRICER_SYSTEM_SKUS = new Set(['AMAZON_GENERIC', 'AMAZON_MULTI']);

  private pickRepricerCandidateRow<
    T extends {
      productId: string;
      availableQty: number;
      totalQty: number;
      activeUnits30d: number;
    },
  >(a: T, b: T, repricerProductIds: Set<string>): T {
    const aSel = repricerProductIds.has(a.productId);
    const bSel = repricerProductIds.has(b.productId);
    if (aSel && !bSel) return a;
    if (!aSel && bSel) return b;
    if (b.availableQty !== a.availableQty) return b.availableQty > a.availableQty ? b : a;
    if (b.totalQty !== a.totalQty) return b.totalQty > a.totalQty ? b : a;
    if (b.activeUnits30d !== a.activeUnits30d) return b.activeUnits30d > a.activeUnits30d ? b : a;
    return b;
  }

  async listCandidates(
    orgId: string,
    opts?: { page?: number; pageSize?: number; q?: string },
  ): Promise<{
    meta: { build: string };
    items: Array<{
      productId: string;
      sku: string;
      asin: string | null;
      title: string | null;
      imageUrl: string | null;
      totalQty: number;
      availableQty: number;
      activeUnits30d: number;
      currentListedPrice: number | null;
      currentListedPriceUpdatedAt: Date | null;
      costOfGoods: number | null;
      /** Order-aligned fee for margin (Finances-preferred + split-estimate fallback). */
      amazonFeePerUnit: number | null;
      /** Raw Product Fees API rollup stored on `products` (optional diagnostics). */
      estimatedAmazonFeeRollup: number | null;
      /** Preview profit at current price (null when missing inputs). */
      expectedProfit: number | null;
      /** Preview ROI% at current price (null when missing inputs). */
      expectedRoiPct: number | null;
      /** Debug: fee used for preview (null when missing). */
      expectedFeePerUnit: number | null;
      /** Debug: cogs used for preview (null when missing). */
      expectedCogsPerUnit: number | null;
    }>;
    total: number;
    page: number;
    pageSize: number;
  }> {
    const userIds = await this.getOrgMemberUserIds(orgId);
    if (userIds.length === 0) {
      const ps = Math.min(100, Math.max(5, Math.floor(Number(opts?.pageSize) || 25)));
      const build =
        (process.env.RENDER_GIT_COMMIT ?? '').trim() ||
        (process.env.VERCEL_GIT_COMMIT_SHA ?? '').trim() ||
        (process.env.GIT_COMMIT_SHA ?? '').trim() ||
        'unknown';
      return { meta: { build }, items: [], total: 0, page: 1, pageSize: ps };
    }
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const activityRows = await (this.prisma as any).orderItem.groupBy({
      by: ['productId'],
      where: { userId: { in: userIds }, marketplace: 'amazon', createdAt: { gte: since } },
      _sum: { quantity: true },
    });
    const unitsByProductId = new Map<string, number>();
    for (const r of activityRows ?? []) {
      const pid = String(r.productId);
      const q = Number(r._sum?.quantity ?? 0);
      unitsByProductId.set(pid, Number.isFinite(q) && q > 0 ? q : 0);
    }

    const selectedRows = await (this.prisma as any).repricerSelectedSku.findMany({
      where: { orgId, enabled: true },
      select: { productId: true },
    });
    const repricerProductIds = new Set<string>(
      (selectedRows ?? []).map((r: { productId: string }) => r.productId),
    );

    const products = await this.prisma.product.findMany({
      where: {
        userId: { in: userIds },
        sku: { not: '' },
        NOT: { sku: { in: ['AMAZON_GENERIC', 'AMAZON_MULTI'] } },
      },
      select: {
        id: true,
        sku: true,
        asin: true,
        title: true,
        imageUrl: true,
        currentListedPrice: true,
        currentListedPriceUpdatedAt: true,
        costOfGoods: true,
        estimatedAmazonFeePerUnit: true,
        estimatedReferralFeePerUnit: true,
        estimatedFbaFeePerUnit: true,
        estimatedDigitalServiceFeePerUnit: true,
        inventory: { select: { totalQty: true, availableQty: true } },
      },
    });

    const visibleProducts = products.filter(
      (p) => !RepricerService.REPRICER_SYSTEM_SKUS.has(String(p.sku ?? '').trim()),
    );

    const productIds = visibleProducts.map((p) => p.id);
    const financesSnap =
      productIds.length > 0
        ? await this.amazonService.getLatestFinancesFeeSnapshotsForProducts(
            userIds,
            productIds,
          )
        : new Map();

    const mapped = visibleProducts
      .map((p) => {
        const totalQty = Number((p as any)?.inventory?.totalQty ?? 0);
        const availableQty = Number((p as any)?.inventory?.availableQty ?? 0);
        const activeUnits30d = unitsByProductId.get(p.id) ?? 0;
        const rollup =
          p.estimatedAmazonFeePerUnit != null ? Number(p.estimatedAmazonFeePerUnit) : null;
        const aligned = this.amazonService.repricerAmazonFeePerUnitFromProduct(
          {
            currentListedPrice: p.currentListedPrice,
            estimatedReferralFeePerUnit: (p as any).estimatedReferralFeePerUnit,
            estimatedFbaFeePerUnit: (p as any).estimatedFbaFeePerUnit,
            estimatedDigitalServiceFeePerUnit: (p as any).estimatedDigitalServiceFeePerUnit,
            estimatedAmazonFeePerUnit: p.estimatedAmazonFeePerUnit,
          },
          financesSnap.get(p.id) ?? null,
        );
        const alignedSafe =
          aligned != null && Number.isFinite(aligned) && aligned >= 0.01 ? aligned : null;
        const price =
          p.currentListedPrice != null && Number.isFinite(Number(p.currentListedPrice))
            ? Number(p.currentListedPrice)
            : null;
        const cogsRaw =
          p.costOfGoods != null && Number.isFinite(Number(p.costOfGoods)) && Number(p.costOfGoods) > 0
            ? Number(p.costOfGoods)
            : null;
        const cogs = this.isSuspiciousCogs(cogsRaw, price) ? null : cogsRaw;
        const feeForPreview =
          alignedSafe != null
            ? alignedSafe
            : rollup != null && Number.isFinite(rollup) && rollup >= 0.01
              ? Math.abs(rollup)
              : null;
        const profit =
          price != null && cogs != null && feeForPreview != null
            ? price - feeForPreview - cogs
            : null;
        const roiPct =
          profit != null && cogs != null && cogs > 0
            ? (profit / cogs) * 100
            : null;

        return {
          productId: p.id,
          sku: p.sku,
          asin: p.asin ?? null,
          title: p.title ?? null,
          imageUrl: p.imageUrl ?? null,
          totalQty: Number.isFinite(totalQty) ? totalQty : 0,
          availableQty: Number.isFinite(availableQty) ? availableQty : 0,
          activeUnits30d,
          currentListedPrice: p.currentListedPrice != null ? Number(p.currentListedPrice) : null,
          currentListedPriceUpdatedAt: (p as any).currentListedPriceUpdatedAt ?? null,
          costOfGoods: cogs,
          amazonFeePerUnit: alignedSafe,
          estimatedAmazonFeeRollup: rollup != null && Number.isFinite(rollup) ? rollup : null,
          expectedProfit:
            profit != null && Number.isFinite(profit) ? Math.round(profit * 100) / 100 : null,
          expectedRoiPct:
            roiPct != null && Number.isFinite(roiPct) ? Math.round(roiPct * 10) / 10 : null,
          expectedFeePerUnit:
            feeForPreview != null && Number.isFinite(feeForPreview)
              ? Math.round(feeForPreview * 100) / 100
              : null,
          expectedCogsPerUnit:
            cogs != null && Number.isFinite(cogs) ? Math.round(cogs * 100) / 100 : null,
        };
      });

    const bySku = new Map<string, (typeof mapped)[number]>();
    for (const row of mapped) {
      const key = row.sku.trim().toLowerCase();
      const prev = bySku.get(key);
      bySku.set(
        key,
        prev ? this.pickRepricerCandidateRow(prev, row, repricerProductIds) : row,
      );
    }
    const listable = [...bySku.values()];

    listable.sort((a, b) => {
      if (b.availableQty !== a.availableQty) return b.availableQty - a.availableQty;
      if (b.activeUnits30d !== a.activeUnits30d) return b.activeUnits30d - a.activeUnits30d;
      return b.totalQty - a.totalQty;
    });

    const q = (opts?.q ?? '').trim().toLowerCase();
    let list = listable;
    if (q) {
      list = listable.filter((c) => {
        return (
          c.sku.toLowerCase().includes(q) ||
          (c.asin ?? '').toLowerCase().includes(q) ||
          (c.title ?? '').toLowerCase().includes(q)
        );
      });
    }

    const total = list.length;
    const page = Math.max(1, Math.floor(Number(opts?.page) || 1));
    const rawPs = Math.floor(Number(opts?.pageSize) || 25);
    const pageSize = Math.min(100, Math.max(5, Number.isFinite(rawPs) ? rawPs : 25));
    const start = (page - 1) * pageSize;
    const items = list.slice(start, start + pageSize);

    const build =
      (process.env.RENDER_GIT_COMMIT ?? '').trim() ||
      (process.env.VERCEL_GIT_COMMIT_SHA ?? '').trim() ||
      (process.env.GIT_COMMIT_SHA ?? '').trim() ||
      'unknown';
    return { meta: { build }, items, total, page, pageSize };
  }

  async getSelectedSkus(orgId: string) {
    const rows = await (this.prisma as any).repricerSelectedSku.findMany({
      where: { orgId, enabled: true },
      orderBy: { createdAt: 'asc' },
      include: {
        product: {
          select: { id: true, sku: true, asin: true, title: true, imageUrl: true },
        },
        ruleSet: { select: { id: true, name: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      sku: r.product.sku,
      asin: r.product.asin ?? null,
      title: r.product.title ?? null,
      imageUrl: r.product.imageUrl ?? null,
      ruleSetId: r.ruleSetId ?? null,
      ruleSetName: r.ruleSet?.name ?? null,
      enabled: r.enabled,
      updatedAt: r.updatedAt,
    }));
  }

  /** Pin one SKU to a saved pricing preset. */
  async assignSkuToPreset(orgId: string, productId: string, ruleSetId: string) {
    const pid = productId.trim();
    const rid = ruleSetId.trim();
    if (!pid || !rid) {
      throw new BadRequestException('productId and ruleSetId are required');
    }
    // Legacy rows from older "unassign = null rule" behaviour still counted toward the cap.
    await (this.prisma as any).repricerSelectedSku.deleteMany({
      where: { orgId, ruleSetId: null },
    });
    const userIds = await this.getOrgMemberUserIds(orgId);
    const productOk = await this.prisma.product.findFirst({
      where: { id: pid, userId: { in: userIds } },
      select: { id: true },
    });
    if (!productOk) throw new BadRequestException('SKU is not available for your organization');

    const preset = await (this.prisma as any).repricerRuleSet.findFirst({
      where: { id: rid, orgId },
      select: { id: true },
    });
    if (!preset) throw new BadRequestException('Pricing rule not found');

    const existing = await (this.prisma as any).repricerSelectedSku.findUnique({
      where: { orgId_productId: { orgId, productId: pid } },
    });

    await (this.prisma as any).repricerSelectedSku.upsert({
      where: { orgId_productId: { orgId, productId: pid } },
      create: { orgId, productId: pid, ruleSetId: rid, enabled: true },
      update: { ruleSetId: rid, enabled: true },
    });

    return { ok: true as const, selected: await this.getSelectedSkus(orgId) };
  }

  /** Remove SKU from the repricer cohort. */
  async unassignSkuFromPreset(orgId: string, productId: string) {
    const pid = productId.trim();
    if (!pid) throw new BadRequestException('productId is required');

    const userIds = await this.getOrgMemberUserIds(orgId);
    const productOk = await this.prisma.product.findFirst({
      where: { id: pid, userId: { in: userIds } },
      select: { id: true },
    });
    if (!productOk) throw new BadRequestException('SKU is not available for your organization');

    const existing = await (this.prisma as any).repricerSelectedSku.findUnique({
      where: { orgId_productId: { orgId, productId: pid } },
    });
    if (!existing) {
      // Nothing to unassign.
      return { ok: true as const, selected: await this.getSelectedSkus(orgId) };
    }

    await (this.prisma as any).repricerSelectedSku.delete({
      where: { orgId_productId: { orgId, productId: pid } },
    });

    return { ok: true as const, selected: await this.getSelectedSkus(orgId) };
  }

  async setSelectedSkus(orgId: string, productIds: string[]) {
    const unique = [...new Set(productIds.map((s) => s.trim()).filter(Boolean))];
    await (this.prisma as any).repricerSelectedSku.deleteMany({
      where: { orgId, ruleSetId: null },
    });
    const userIds = await this.getOrgMemberUserIds(orgId);
    const okCount = await this.prisma.product.count({
      where: { id: { in: unique }, userId: { in: userIds } },
    });
    if (okCount !== unique.length) {
      throw new Error('One or more selected SKUs are not available for your org');
    }
    const active = await (this.prisma as any).repricerRuleSet.findFirst({
      where: { orgId, isActive: true },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    if (!active) {
      throw new Error('No active pricing preset — create one and set it as active first');
    }
    const ruleSetId = String(active.id);
    await (this.prisma as any).repricerSelectedSku.deleteMany({ where: { orgId } });
    if (unique.length === 0) return { ok: true, selected: [] as any[] };
    await (this.prisma as any).repricerSelectedSku.createMany({
      data: unique.map((pid) => ({ orgId, productId: pid, ruleSetId, enabled: true })),
      skipDuplicates: true,
    });
    return { ok: true, selected: await this.getSelectedSkus(orgId) };
  }

  private serializeRuleRow(row: any) {
    const num = (v: unknown) =>
      v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
    const dec = (v: unknown) => num(v);
    const jsonIds = (v: unknown) => (Array.isArray(v) ? v.map((s) => String(s)) : []);
    return {
      id: row.id,
      name: row.name,
      isActive: Boolean(row.isActive),
      chainAfterDays: row.chainAfterDays != null ? Number(row.chainAfterDays) : null,
      followUpRuleSetId: row.followUpRuleSetId ?? null,
      rule1: {
        label: row.rule1Label ?? '',
        priceReference:
          String(row.rule1PriceReference ?? 'buy_box').toLowerCase() === 'best_offer'
            ? 'best_offer'
            : String(row.rule1PriceReference ?? 'buy_box').toLowerCase() === 'next_best_offer'
              ? 'next_best_offer'
              : 'buy_box',
        minProfit: dec(row.rule1MinProfit),
        maxProfit: dec(row.rule1MaxProfit),
        minListPrice: dec(row.rule1MinListPrice),
        maxListPrice: dec(row.rule1MaxListPrice),
        minRoiPct: dec(row.rule1MinRoiPct),
        maxRoiPct: dec(row.rule1MaxRoiPct),
        endsAt: row.rule1EndsAt ? new Date(row.rule1EndsAt).toISOString() : null,
        strategy: row.rule1Strategy ?? '',
        beatType: row.rule1BeatType ?? '',
        beatValue: dec(row.rule1BeatValue),
        onlyWhenBuyBoxFba: Boolean(row.rule1OnlyWhenBuyBoxFba),
        ignoreAmazon: Boolean(row.rule1IgnoreAmazon),
        ignoreFbm: Boolean(row.rule1IgnoreFbm),
        ignoreSellerViewsEnabled: Boolean(row.rule1IgnoreSellerViewsEnabled),
        ignoreSellerViewsBelow:
          row.rule1IgnoreSellerViewsBelow != null ? Number(row.rule1IgnoreSellerViewsBelow) : null,
        ignoreSellerIds: jsonIds(row.rule1IgnoreSellerIds),
        minSellerFeedbackPct: dec(row.rule1MinSellerFeedbackPct),
        cooldownMinutes: row.rule1CooldownMinutes != null ? Number(row.rule1CooldownMinutes) : null,
        smartDelayEnabled: Boolean(row.rule1SmartDelayEnabled),
      },
      rule2: {
        label: row.rule2Label ?? '',
        priceReference:
          String(row.rule2PriceReference ?? 'buy_box').toLowerCase() === 'best_offer'
            ? 'best_offer'
            : String(row.rule2PriceReference ?? 'buy_box').toLowerCase() === 'next_best_offer'
              ? 'next_best_offer'
              : 'buy_box',
        minProfit: dec(row.rule2MinProfit),
        maxProfit: dec(row.rule2MaxProfit),
        minRoiPct: dec(row.rule2MinRoiPct),
        maxRoiPct: dec(row.rule2MaxRoiPct),
        endsAt: row.rule2EndsAt ? new Date(row.rule2EndsAt).toISOString() : null,
        strategy: row.rule2Strategy ?? '',
        beatType: row.rule2BeatType ?? '',
        beatValue: dec(row.rule2BeatValue),
        onlyWhenBuyBoxFba: Boolean(row.rule2OnlyWhenBuyBoxFba),
        ignoreAmazon: Boolean(row.rule2IgnoreAmazon),
        ignoreFbm: Boolean(row.rule2IgnoreFbm),
        ignoreSellerViewsEnabled: Boolean(row.rule2IgnoreSellerViewsEnabled),
        ignoreSellerViewsBelow:
          row.rule2IgnoreSellerViewsBelow != null ? Number(row.rule2IgnoreSellerViewsBelow) : null,
        ignoreSellerIds: jsonIds(row.rule2IgnoreSellerIds),
        minSellerFeedbackPct: dec(row.rule2MinSellerFeedbackPct),
        cooldownMinutes: row.rule2CooldownMinutes != null ? Number(row.rule2CooldownMinutes) : null,
        smartDelayEnabled: Boolean(row.rule2SmartDelayEnabled),
      },
      updatedAt: row.updatedAt,
    };
  }

  /** All saved presets for the org + which one is applied to repricing (isActive). */
  async getRuleLibrary(orgId: string) {
    const rows = await (this.prisma as any).repricerRuleSet.findMany({
      where: { orgId },
      orderBy: { updatedAt: 'desc' },
    });
    const active = rows.find((r: any) => r.isActive);
    const countRows = await (this.prisma as any).repricerSelectedSku.groupBy({
      by: ['ruleSetId'],
      where: { orgId, enabled: true, ruleSetId: { not: null } },
      _count: { _all: true },
    });
    const counts = new Map<string, number>();
    for (const c of countRows ?? []) {
      if (c.ruleSetId) counts.set(String(c.ruleSetId), c._count._all);
    }
    return {
      presets: rows.map((r: any) => ({
        ...this.serializeRuleRow(r),
        assignedSkuCount: counts.get(String(r.id)) ?? 0,
      })),
      activePresetId: active?.id ?? null,
    };
  }

  /** @deprecated use getRuleLibrary */
  async getRuleSet(orgId: string) {
    const lib = await this.getRuleLibrary(orgId);
    return lib.presets.find((p: any) => p.id === lib.activePresetId) ?? lib.presets[0] ?? null;
  }

  async renameActivePreset(orgId: string, name: string) {
    const active = await (this.prisma as any).repricerRuleSet.findFirst({
      where: { orgId, isActive: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!active) return { ok: false as const };
    const row = await (this.prisma as any).repricerRuleSet.update({
      where: { id: active.id },
      data: { name: name.slice(0, 80) },
    });
    return this.serializeRuleRow(row);
  }

  async applyRulePreset(orgId: string, presetId: string) {
    const row = await (this.prisma as any).repricerRuleSet.findFirst({
      where: { id: presetId, orgId },
    });
    if (!row) throw new BadRequestException('Pricing rule not found');
    await (this.prisma as any).repricerRuleSet.updateMany({
      where: { orgId, NOT: { id: presetId } },
      data: { isActive: false },
    });
    await (this.prisma as any).repricerRuleSet.update({
      where: { id: presetId },
      data: { isActive: true },
    });
    const lib = await this.getRuleLibrary(orgId);
    return { ok: true as const, activePresetId: lib.activePresetId };
  }

  async deleteRulePreset(orgId: string, presetId: string) {
    const rid = presetId.trim();
    if (!rid) throw new BadRequestException('presetId is required');

    const row = await (this.prisma as any).repricerRuleSet.findFirst({
      where: { id: rid, orgId },
      select: { id: true, isActive: true },
    });
    if (!row) throw new BadRequestException('Pricing rule not found');

    // Drop SKUs from the repricer cohort that used this preset (same as unassign; frees slots).
    await (this.prisma as any).repricerSelectedSku.deleteMany({
      where: { orgId, ruleSetId: rid },
    });

    await (this.prisma as any).repricerRuleSet.delete({
      where: { id: rid },
    });

    // If we deleted the active preset, promote another preset (most recently updated) as active.
    if (row.isActive) {
      const next = await (this.prisma as any).repricerRuleSet.findFirst({
        where: { orgId },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      });
      if (next?.id) {
        await (this.prisma as any).repricerRuleSet.updateMany({
          where: { orgId, NOT: { id: next.id } },
          data: { isActive: false },
        });
        await (this.prisma as any).repricerRuleSet.update({
          where: { id: next.id },
          data: { isActive: true },
        });
      }
    }

    const lib = await this.getRuleLibrary(orgId);
    return { ok: true as const, activePresetId: lib.activePresetId };
  }

  private validateRuleBlock(r?: {
    priceReference?: string | null;
    minProfit?: number | null;
    maxProfit?: number | null;
    minListPrice?: number | null;
    maxListPrice?: number | null;
    minRoiPct?: number | null;
    maxRoiPct?: number | null;
    endsAt?: string | null;
    strategy?: string | null;
    beatType?: string | null;
    beatValue?: number | null;
    onlyWhenBuyBoxFba?: boolean | null;
    ignoreAmazon?: boolean | null;
    ignoreFbm?: boolean | null;
    ignoreSellerViewsEnabled?: boolean | null;
    ignoreSellerViewsBelow?: number | null;
    ignoreSellerIds?: string[] | null;
    minSellerFeedbackPct?: number | null;
    cooldownMinutes?: number | null;
    smartDelayEnabled?: boolean | null;
  }) {
    const minProfit = r?.minProfit ?? null;
    const maxProfit = r?.maxProfit ?? null;
    const minRoi = r?.minRoiPct ?? null;
    const maxRoi = r?.maxRoiPct ?? null;
    if (minProfit != null && !Number.isFinite(minProfit)) {
      throw new Error('Minimum profit must be a number');
    }
    if (maxProfit != null && !Number.isFinite(maxProfit)) {
      throw new Error('Maximum profit must be a number');
    }
    if (minProfit != null && maxProfit != null && maxProfit < minProfit) {
      throw new Error('Maximum profit must be greater than or equal to Minimum profit');
    }
    const minList = r?.minListPrice ?? null;
    const maxList = r?.maxListPrice ?? null;
    if (minList != null && (!Number.isFinite(minList) || minList < 0)) {
      throw new Error('Minimum price must be a non-negative number');
    }
    if (maxList != null && (!Number.isFinite(maxList) || maxList < 0)) {
      throw new Error('Maximum price must be a non-negative number');
    }
    if (minList != null && maxList != null && maxList < minList) {
      throw new Error('Maximum price must be greater than or equal to Minimum price');
    }
    const checkPct = (n: number, label: string) => {
      if (!Number.isFinite(n) || n < -5000 || n > 5000) {
        throw new Error(`${label} must be between -5000 and 5000`);
      }
    };
    if (minRoi != null) checkPct(minRoi, 'Minimum ROI %');
    if (maxRoi != null) checkPct(maxRoi, 'Maximum ROI %');
    if (minRoi != null && maxRoi != null && maxRoi < minRoi) {
      throw new Error('Maximum ROI % must be greater than or equal to Minimum ROI %');
    }
    const endsAt = r?.endsAt ? new Date(r.endsAt) : null;
    if (r?.endsAt && Number.isNaN(endsAt?.getTime() ?? NaN)) {
      throw new Error('Rule end date is invalid');
    }
    const pref = String(r?.priceReference ?? 'buy_box').trim().toLowerCase();
    if (pref && !['buy_box', 'best_offer', 'next_best_offer'].includes(pref)) {
      throw new Error('Price reference must be buy_box, best_offer, or next_best_offer');
    }
      const strat = (r?.strategy ?? '').trim();
      if (
        strat &&
        !['match_buy_box', 'beat_buy_box', 'stay_above_buy_box', 'no_buy_box'].includes(strat)
      ) {
        throw new Error('Strategy is invalid');
      }
    const beatType = (r?.beatType ?? '').trim();
    if (beatType && !['amount', 'percent'].includes(beatType)) {
      throw new Error('Beat type is invalid');
    }
    const beatValue = r?.beatValue ?? null;
    if (beatValue != null && (!Number.isFinite(beatValue) || beatValue < 0)) {
      throw new Error('Beat value must be a non-negative number');
    }
    const fb = r?.minSellerFeedbackPct ?? null;
    if (fb != null && (!Number.isFinite(fb) || fb < 0 || fb > 100)) {
      throw new Error('Minimum seller feedback % must be between 0 and 100');
    }
    const cd = r?.cooldownMinutes ?? null;
    if (cd != null && (!Number.isFinite(cd) || cd < 0 || cd > 7 * 24 * 60)) {
      throw new Error('Cooldown minutes is invalid');
    }
    if (r?.ignoreSellerViewsEnabled) {
      const v = r?.ignoreSellerViewsBelow;
      if (v == null || !Number.isFinite(v) || v < 0 || v > 1_000_000_000) {
        throw new Error('When ignoring sellers by reviews, enter a valid review threshold (0 or higher)');
      }
    }
  }

  async upsertRuleSet(
    orgId: string,
    data: {
      id?: string;
      name?: string;
      setAsActive?: boolean;
      chainAfterDays?: number | null;
      followUpRuleSetId?: string | null;
      rule1?: Record<string, unknown>;
      rule2?: Record<string, unknown>;
    },
  ) {
    return this.saveRuleSet(orgId, data);
  }

  async saveRuleSet(
    orgId: string,
    data: {
      id?: string;
      name?: string;
      setAsActive?: boolean;
      chainAfterDays?: number | null;
      followUpRuleSetId?: string | null;
      rule1?: {
        label?: string | null;
        priceReference?: string | null;
        minProfit?: number | null;
        maxProfit?: number | null;
        minListPrice?: number | null;
        maxListPrice?: number | null;
        minRoiPct?: number | null;
        maxRoiPct?: number | null;
        endsAt?: string | null;
        strategy?: string | null;
        beatType?: string | null;
        beatValue?: number | null;
        onlyWhenBuyBoxFba?: boolean | null;
        ignoreAmazon?: boolean | null;
        ignoreFbm?: boolean | null;
        ignoreSellerViewsEnabled?: boolean | null;
        ignoreSellerViewsBelow?: number | null;
        ignoreSellerIds?: string[] | null;
        minSellerFeedbackPct?: number | null;
        cooldownMinutes?: number | null;
        smartDelayEnabled?: boolean | null;
      };
      rule2?: {
        label?: string | null;
        priceReference?: string | null;
        minProfit?: number | null;
        maxProfit?: number | null;
        minListPrice?: number | null;
        maxListPrice?: number | null;
        minRoiPct?: number | null;
        maxRoiPct?: number | null;
        endsAt?: string | null;
        strategy?: string | null;
        beatType?: string | null;
        beatValue?: number | null;
        onlyWhenBuyBoxFba?: boolean | null;
        ignoreAmazon?: boolean | null;
        ignoreFbm?: boolean | null;
        ignoreSellerViewsEnabled?: boolean | null;
        ignoreSellerViewsBelow?: number | null;
        ignoreSellerIds?: string[] | null;
        minSellerFeedbackPct?: number | null;
        cooldownMinutes?: number | null;
        smartDelayEnabled?: boolean | null;
      };
    },
  ) {
    this.validateRuleBlock(data.rule1);
    this.validateRuleBlock(data.rule2);

    const toDate = (s?: string | null) => (s ? new Date(s) : null);
    const toBool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
    const toStr = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const toNumOrNull = (v: unknown) => {
      if (v == null) return null;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const toIgnoreSellerIds = (v: unknown) => {
      if (!Array.isArray(v)) return null;
      const out = v.map((s) => String(s).trim()).filter(Boolean).slice(0, 50);
      return out.length ? out : null;
    };
    const toPriceRef = (v: unknown) => {
      const s = String(v ?? 'buy_box').trim().toLowerCase();
      if (s === 'best_offer') return 'best_offer';
      if (s === 'next_best_offer') return 'next_best_offer';
      return 'buy_box';
    };

    const chainDays = toNumOrNull(data.chainAfterDays);
    if (chainDays != null && (!Number.isFinite(chainDays) || chainDays < 1 || chainDays > 3650)) {
      throw new Error('Chain after days must be between 1 and 3650, or leave empty');
    }

    let followId: string | null =
      typeof data.followUpRuleSetId === 'string' && data.followUpRuleSetId.trim()
        ? data.followUpRuleSetId.trim()
        : null;
    if (followId && chainDays == null) {
      throw new Error('Set “after X days” when choosing a follow-up pricing rule');
    }
    if (chainDays != null && !followId) {
      throw new Error('Choose which pricing rule to use after those days');
    }
    if (followId) {
      const target = await (this.prisma as any).repricerRuleSet.findFirst({
        where: { id: followId, orgId },
      });
      if (!target) throw new Error('Follow-up rule must belong to your organization');
    }

    const payload: any = {
      name: (data.name ?? 'Default').slice(0, 80),
      rule1Label: toStr(data.rule1?.label).slice(0, 80) || null,
      rule1PriceReference: toPriceRef(data.rule1?.priceReference),
      rule1MinProfit: data.rule1?.minProfit ?? null,
      rule1MaxProfit: data.rule1?.maxProfit ?? null,
      rule1MinListPrice: toNumOrNull(data.rule1?.minListPrice),
      rule1MaxListPrice: toNumOrNull(data.rule1?.maxListPrice),
      rule1MinRoiPct: data.rule1?.minRoiPct ?? null,
      rule1MaxRoiPct: data.rule1?.maxRoiPct ?? null,
      rule1EndsAt: toDate(data.rule1?.endsAt ?? null),
      rule1Strategy: toStr(data.rule1?.strategy),
      rule1BeatType: toStr(data.rule1?.beatType),
      rule1BeatValue: toNumOrNull(data.rule1?.beatValue),
      rule1OnlyWhenBuyBoxFba: toBool(data.rule1?.onlyWhenBuyBoxFba, false),
      rule1IgnoreAmazon: toBool(data.rule1?.ignoreAmazon, true),
      rule1IgnoreFbm: toBool(data.rule1?.ignoreFbm, false),
      rule1IgnoreSellerViewsEnabled: toBool(data.rule1?.ignoreSellerViewsEnabled, false),
      rule1IgnoreSellerViewsBelow: data.rule1?.ignoreSellerViewsEnabled
        ? toNumOrNull(data.rule1?.ignoreSellerViewsBelow)
        : null,
      rule1IgnoreSellerIds: toIgnoreSellerIds(data.rule1?.ignoreSellerIds),
      rule1MinSellerFeedbackPct: toNumOrNull(data.rule1?.minSellerFeedbackPct),
      rule1CooldownMinutes: toNumOrNull(data.rule1?.cooldownMinutes),
      rule1SmartDelayEnabled: toBool(data.rule1?.smartDelayEnabled, true),
      rule2Label: toStr(data.rule2?.label).slice(0, 80) || null,
      rule2PriceReference: toPriceRef(data.rule2?.priceReference),
      rule2MinProfit: data.rule2?.minProfit ?? null,
      rule2MaxProfit: data.rule2?.maxProfit ?? null,
      rule2MinListPrice: toNumOrNull(data.rule2?.minListPrice),
      rule2MaxListPrice: toNumOrNull(data.rule2?.maxListPrice),
      rule2MinRoiPct: data.rule2?.minRoiPct ?? null,
      rule2MaxRoiPct: data.rule2?.maxRoiPct ?? null,
      rule2EndsAt: toDate(data.rule2?.endsAt ?? null),
      rule2Strategy: toStr(data.rule2?.strategy),
      rule2BeatType: toStr(data.rule2?.beatType),
      rule2BeatValue: toNumOrNull(data.rule2?.beatValue),
      rule2OnlyWhenBuyBoxFba: toBool(data.rule2?.onlyWhenBuyBoxFba, false),
      rule2IgnoreAmazon: toBool(data.rule2?.ignoreAmazon, true),
      rule2IgnoreFbm: toBool(data.rule2?.ignoreFbm, false),
      rule2IgnoreSellerViewsEnabled: toBool(data.rule2?.ignoreSellerViewsEnabled, false),
      rule2IgnoreSellerViewsBelow: data.rule2?.ignoreSellerViewsEnabled
        ? toNumOrNull(data.rule2?.ignoreSellerViewsBelow)
        : null,
      rule2IgnoreSellerIds: toIgnoreSellerIds(data.rule2?.ignoreSellerIds),
      rule2MinSellerFeedbackPct: toNumOrNull(data.rule2?.minSellerFeedbackPct),
      rule2CooldownMinutes: toNumOrNull(data.rule2?.cooldownMinutes),
      rule2SmartDelayEnabled: toBool(data.rule2?.smartDelayEnabled, true),
      chainAfterDays: chainDays != null ? Math.floor(chainDays) : null,
      followUpRuleSetId: followId,
    };

    const presetCount = await (this.prisma as any).repricerRuleSet.count({ where: { orgId } });
    const editingId = typeof data.id === 'string' && data.id.trim() ? data.id.trim() : null;

    let setAsActive = data.setAsActive;
    if (typeof setAsActive !== 'boolean') {
      setAsActive = presetCount === 0 ? true : false;
    }

    if (editingId) {
      const row = await (this.prisma as any).repricerRuleSet.findFirst({
        where: { id: editingId, orgId },
      });
      if (!row) throw new Error('Pricing rule not found');
      if (followId === editingId) throw new Error('A rule cannot follow itself; pick another preset');
      const updated = await (this.prisma as any).repricerRuleSet.update({
        where: { id: editingId },
        data: payload,
      });
      if (setAsActive) {
        await (this.prisma as any).repricerRuleSet.updateMany({
          where: { orgId, NOT: { id: editingId } },
          data: { isActive: false },
        });
        await (this.prisma as any).repricerRuleSet.update({
          where: { id: editingId },
          data: { isActive: true },
        });
      }
      const finalRow = await (this.prisma as any).repricerRuleSet.findUnique({
        where: { id: editingId },
      });
      return this.serializeRuleRow(finalRow);
    }

    if (followId) {
      const exists = await (this.prisma as any).repricerRuleSet.findFirst({
        where: { id: followId, orgId },
      });
      if (!exists) throw new Error('Follow-up rule must belong to your organization');
    }

    const created = await (this.prisma as any).repricerRuleSet.create({
      data: {
        orgId,
        ...payload,
        isActive: setAsActive === true,
      },
    });

    if (setAsActive === true) {
      await (this.prisma as any).repricerRuleSet.updateMany({
        where: { orgId, NOT: { id: created.id } },
        data: { isActive: false },
      });
    }

    const finalRow = await (this.prisma as any).repricerRuleSet.findUnique({
      where: { id: created.id },
    });
    return this.serializeRuleRow(finalRow);
  }

  async listLogs(orgId: string, productId?: string, limit = 200) {
    const take = Math.min(500, Math.max(1, Number(limit) || 200));
    const pid = productId?.trim();
    if (pid) {
      const uuidOk =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pid);
      if (!uuidOk) {
        throw new BadRequestException('Invalid productId (expected a UUID).');
      }
    }

    type LogRow = {
      id: string;
      productId: string;
      sku: string;
      asin?: string | null;
      kind: string;
      message: string;
      prevPrice: unknown;
      nextPrice: unknown;
      context?: unknown;
      createdAt: Date;
      lastCheckedAt: Date | null;
    };

    let rows: LogRow[];
    try {
      rows = await this.prisma.repricerLog.findMany({
        where: { orgId, ...(pid ? { productId: pid } : {}) },
        orderBy: { createdAt: 'desc' },
        take,
        include: {
          product: { select: { asin: true } },
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const missingLastChecked =
        /\blast_checked_at\b/i.test(msg) || /no such column.*last_checked_at/i.test(msg);
      if (!missingLastChecked) {
        this.logger.error(`[repricer] listLogs failed: ${msg}`);
        throw e;
      }
      this.logger.warn(
        `[repricer] listLogs: last_checked_at missing on repricer_logs; raw fallback (run: npx prisma migrate deploy). ${msg.slice(0, 280)}`,
      );
      try {
        const raw = pid
          ? await this.prisma.$queryRaw<
              Array<{
                id: string;
                product_id: string;
                sku: string;
                kind: string;
                message: string;
                prev_price: unknown;
                next_price: unknown;
                created_at: Date;
              }>
            >(Prisma.sql`
              SELECT l.id, l.product_id, l.sku, l.kind, l.message, l.prev_price, l.next_price, l.created_at, p.asin
              FROM repricer_logs l
              LEFT JOIN products p ON p.id = l.product_id
              WHERE l.org_id = ${orgId} AND l.product_id = ${pid}
              ORDER BY created_at DESC
              LIMIT ${take}
            `)
          : await this.prisma.$queryRaw<
              Array<{
                id: string;
                product_id: string;
                sku: string;
                asin: string | null;
                kind: string;
                message: string;
                prev_price: unknown;
                next_price: unknown;
                created_at: Date;
              }>
            >(Prisma.sql`
              SELECT l.id, l.product_id, l.sku, l.kind, l.message, l.prev_price, l.next_price, l.created_at, p.asin
              FROM repricer_logs l
              LEFT JOIN products p ON p.id = l.product_id
              WHERE l.org_id = ${orgId}
              ORDER BY created_at DESC
              LIMIT ${take}
            `);
        rows = raw.map((r) => ({
          id: r.id,
          productId: r.product_id,
          sku: r.sku,
          asin: (r as any).asin ?? null,
          kind: r.kind,
          message: r.message,
          prevPrice: r.prev_price,
          nextPrice: r.next_price,
          context: null,
          createdAt: r.created_at,
          lastCheckedAt: null,
        }));
      } catch (inner) {
        this.logger.error(
          `[repricer] listLogs raw fallback failed: ${inner instanceof Error ? inner.message : String(inner)}`,
        );
        throw e;
      }
    }

    let lastEngineAt: Date | null = null;
    try {
      const org = await this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { repricerLastEngineAt: true },
      });
      lastEngineAt = org?.repricerLastEngineAt ?? null;
    } catch (e) {
      this.logger.warn(
        `[repricer] listLogs: could not read repricerLastEngineAt for org ${orgId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return {
      logs: rows.map((r) => ({
        id: r.id,
        productId: r.productId,
        sku: r.sku,
        asin: (r as any)?.product?.asin ?? (r as any)?.asin ?? null,
        kind: r.kind,
        message: r.message,
        context: (r as any)?.context ?? null,
        prevPrice: r.prevPrice != null ? Number(r.prevPrice) : null,
        nextPrice: r.nextPrice != null ? Number(r.nextPrice) : null,
        createdAt: r.createdAt,
        lastCheckedAt: r.lastCheckedAt ?? null,
      })),
      lastEngineAt,
    };
  }

  /**
   * Repricer engine:
   * - Loads selected SKUs for each org
   * - Computes a target price from rules + ROI/profit bounds
   * - When the scheduler passes dryRun=false (default), PATCHes Listings Items API to update
   *   the offer price on Amazon, then mirrors currentListedPrice in DB.
   * - When dryRun=true (set REPRICER_DRY_RUN on the worker), logs DRY-RUN. DB mirror for
   *   currentListedPrice is off unless REPRICER_SIMULATE_PRICE_UPDATE=true (opt-in).
   */
  async runEngineForAllOrgs(opts?: { dryRun?: boolean }) {
    const rows = await (this.prisma as any).repricerSelectedSku.findMany({
      where: { enabled: true },
      select: { orgId: true },
      distinct: ['orgId'],
    });
    for (const r of rows ?? []) {
      const orgId = String(r.orgId);
      try {
        await this.runEngineForOrg(orgId, { dryRun: opts?.dryRun !== false });
      } catch {
        // non-fatal per org
      }
    }
    return { ok: true };
  }

  private computeBounds(params: {
    cost: number | null;
    fee: number | null;
    minProfit: number | null;
    maxProfit: number | null;
    minRoiPct: number | null;
    maxRoiPct: number | null;
    /** Optional listing-currency floor (combined with profit/ROI: strictest min wins). */
    minListPrice?: number | null;
    /** Optional listing-currency ceiling (combined with profit/ROI: strictest max wins). */
    maxListPrice?: number | null;
  }) {
    const { cost, fee, minProfit, maxProfit, minRoiPct, maxRoiPct, minListPrice, maxListPrice } = params;
    if (cost == null || !Number.isFinite(cost) || cost <= 0) return null;
    // Fees can be stored as negative (common in orders/finances). Bounds should use absolute fee cost.
    const f = fee != null && Number.isFinite(fee) ? Math.abs(fee) : 0;
    const minProfitAbs = minProfit != null && Number.isFinite(minProfit) ? minProfit : null;
    const maxProfitAbs = maxProfit != null && Number.isFinite(maxProfit) ? maxProfit : null;
    const minRoi = minRoiPct != null && Number.isFinite(minRoiPct) ? minRoiPct / 100 : null;
    const maxRoi = maxRoiPct != null && Number.isFinite(maxRoiPct) ? maxRoiPct / 100 : null;

    const minByProfit = minProfitAbs != null ? cost + f + minProfitAbs : null;
    const minByRoi = minRoi != null ? cost * (1 + minRoi) + f : null;
    const maxByProfit = maxProfitAbs != null ? cost + f + maxProfitAbs : null;
    const maxByRoi = maxRoi != null ? cost * (1 + maxRoi) + f : null;

    const minCandidates = [minByProfit, minByRoi].filter((n) => n != null) as number[];
    const maxCandidates = [maxByProfit, maxByRoi].filter((n) => n != null) as number[];
    let minPrice = minCandidates.length ? Math.max(...minCandidates) : null;
    let maxPrice = maxCandidates.length ? Math.min(...maxCandidates) : null;

    const listFloor =
      minListPrice != null && Number.isFinite(minListPrice) && minListPrice > 0 ? minListPrice : null;
    const listCeil =
      maxListPrice != null && Number.isFinite(maxListPrice) && maxListPrice > 0 ? maxListPrice : null;
    if (listFloor != null) {
      minPrice = minPrice != null ? Math.max(minPrice, listFloor) : listFloor;
    }
    if (listCeil != null) {
      maxPrice = maxPrice != null ? Math.min(maxPrice, listCeil) : listCeil;
    }
    if (minPrice != null && maxPrice != null && maxPrice < minPrice) {
      return null;
    }

    return { minPrice, maxPrice, fee: f, cost };
  }

  private static readonly ANCHORED_UNCHANGED_LEGACY_MSG =
    'No change: current price already satisfies rules/bounds.';
  private static readonly ANCHORED_UNCHANGED_CURRENT_MSG = 'Leaving price unchanged.';
  private static readonly SKIP_NO_BUY_BOX_UNCHANGED_MSG =
    'Skipped: no buy box on listing; leaving price unchanged.';

  /** Log lines that should collapse to one anchored row per product (not real price moves). */
  private static isIdleChurnLogMessage(message: string): boolean {
    return (
      message === RepricerService.SKIP_NO_BUY_BOX_UNCHANGED_MSG ||
      message === RepricerService.ANCHORED_UNCHANGED_LEGACY_MSG ||
      message === RepricerService.ANCHORED_UNCHANGED_CURRENT_MSG ||
      message.startsWith('No change:')
    );
  }

  /**
   * Finds the anchored "unchanged" row for upsert (one row per product; lastCheckedAt bumped each tick).
   * Must query by JSON/message — not "last 100 rows": busy SKUs exceed that and we would insert a new
   * "no change" line every run instead of updating the anchor.
   */
  private async findAnchoredUnchangedLogRow(orgId: string, productId: string) {
    const prisma = this.prisma as any;
    try {
      // Do NOT select lastCheckedAt here: older DBs may not have repricer_logs.last_checked_at yet.
      const byFlag = await prisma.repricerLog.findFirst({
        where: {
          orgId,
          productId,
          context: { path: ['unchangedAnchor'], equals: true },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, kind: true, message: true, context: true, createdAt: true },
      });
      if (byFlag) return byFlag;

      return await prisma.repricerLog.findFirst({
        where: {
          orgId,
          productId,
          kind: 'decision',
          message: {
            in: [
              RepricerService.ANCHORED_UNCHANGED_LEGACY_MSG,
              RepricerService.ANCHORED_UNCHANGED_CURRENT_MSG,
              RepricerService.SKIP_NO_BUY_BOX_UNCHANGED_MSG,
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, kind: true, message: true, context: true, createdAt: true },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const missingLastChecked =
        /\blast_checked_at\b/i.test(msg) || /no such column.*last_checked_at/i.test(msg);
      if (missingLastChecked) {
        // Anchored unchanged rows are optional; skip the optimization until migrations are applied.
        return null;
      }
      throw e;
    }
  }

  /**
   * Removes only the single "unchanged listing" anchor row for a product (if any).
   * Do not use Prisma `deleteMany` JSON path filters: some drivers omit the JSON predicate and
   * delete every `repricer_logs` row for that org+product — wiping full history on each run.
   */
  private async deleteAnchoredUnchangedLogsForProduct(orgId: string, productId: string) {
    const rows = await (this.prisma as any).repricerLog.findMany({
      where: { orgId, productId },
      select: { id: true, context: true },
    });
    const ids = (rows ?? [])
      .filter((r: { context: unknown }) => {
        const c = r.context as Record<string, unknown> | null;
        return c != null && typeof c === 'object' && c['unchangedAnchor'] === true;
      })
      .map((r: { id: string }) => r.id);
    if (ids.length > 0) {
      await (this.prisma as any).repricerLog.deleteMany({ where: { id: { in: ids } } });
    }
  }

  /**
   * Removes older idle-churn rows for this product (everything except keepId that matches idle patterns).
   * Uses findMany + in-JS match so we never depend on Prisma deleteMany + OR/startsWith quirks.
   */
  private async deleteStaleUnchangedRepricerLogsExcept(orgId: string, productId: string, keepId: string) {
    const candidates = await this.prisma.repricerLog.findMany({
      where: { orgId, productId, id: { not: keepId } },
      select: { id: true, message: true, context: true, kind: true },
      take: 10_000,
    });
    const killIds = candidates
      .filter((r) => {
        if (r.kind !== 'decision') return false;
        if (RepricerService.isIdleChurnLogMessage(r.message)) return true;
        const c = r.context as Record<string, unknown> | null;
        return c != null && typeof c === 'object' && c['unchangedAnchor'] === true;
      })
      .map((r) => r.id);
    if (killIds.length > 0) {
      await this.prisma.repricerLog.deleteMany({ where: { id: { in: killIds } } });
    }
  }

  /**
   * After a repricer log, the "expected" listing price is last nextPrice if set, else last prevPrice
   * (unchanged / skip rows store null next in DB). If currentListedPrice in the app differs, something
   * else changed the price (Amazon sync, manual edit, etc.) — log it so the table isn't missing a step.
   */
  private async inferListedPriceFromLastRepricerLog(orgId: string, productId: string): Promise<number | null> {
    const last = await (this.prisma as any).repricerLog.findFirst({
      where: { orgId, productId },
      orderBy: { createdAt: 'desc' },
      select: { prevPrice: true, nextPrice: true },
    });
    if (!last) return null;
    const n = last.nextPrice != null ? Number(last.nextPrice) : null;
    const pv = last.prevPrice != null ? Number(last.prevPrice) : null;
    if (n != null && Number.isFinite(n)) return n;
    if (pv != null && Number.isFinite(pv)) return pv;
    return null;
  }

  private async maybeLogExternalListingPriceDrift(
    orgId: string,
    productId: string,
    sku: string,
    current: number,
  ) {
    const implied = await this.inferListedPriceFromLastRepricerLog(orgId, productId);
    if (implied == null || !Number.isFinite(implied)) return;
    if (Math.round(implied * 100) === Math.round(current * 100)) return;
    await (this.prisma as any).repricerLog.create({
      data: {
        orgId,
        productId,
        sku,
        kind: 'decision',
        message: `Listing price in app is ${current.toFixed(2)}; last repricer log implied ${implied.toFixed(2)} (change happened outside this repricer — e.g. Amazon sync, manual edit, or another tool).`,
        prevPrice: implied as any,
        nextPrice: current as any,
        context: { externalPriceDrift: true } as any,
      },
    });
  }

  private defaultMarketplaceIdForRegion(region: string | null | undefined): string {
    switch ((region ?? '').toLowerCase()) {
      case 'na':
        return 'ATVPDKIKX0DER';
      case 'fe':
        return 'A1VC38T7YXB528';
      case 'eu':
      default:
        return 'A1F83G8C2ARO7P'; // UK (EU region default)
    }
  }

  /** Buy Box price + lowest and second-lowest competitive offers (from CompetitivePrices), when available. */
  private parseCompetitivePricingTargets(res: any): { buyBox: number | null; bestOffer: number | null; nextBestOffer: number | null } {
    const root = res?.payload ?? res;
    const payload = root?.payload ?? root;
    const list = Array.isArray(payload) ? payload : Array.isArray(root) ? root : [];
    const extractAmount = (p: any): number | null => {
      if (p == null) return null;
      const amount =
        p.Amount ??
        p.amount ??
        p.value ??
        p.Value ??
        p?.ListingPrice?.Amount ??
        p?.ListingPrice?.amount;
      if (typeof amount === 'number' && Number.isFinite(amount)) return amount;
      if (typeof amount === 'string') {
        const n = parseFloat(amount);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };

    let buyBox: number | null = null;
    const competitiveAmounts: number[] = [];

    for (const it of list) {
      if (it?.status && String(it.status).toLowerCase() !== 'success') {
        continue;
      }
      // SP-API v0 returns Product.CompetitivePricing (not CompetitivePricing on the row root).
      const cp =
        it?.Product?.CompetitivePricing ??
        it?.product?.competitivePricing ??
        it?.CompetitivePricing ??
        it?.competitivePricing ??
        it;
      const buyBoxArr = cp?.BuyBoxPrices ?? cp?.buyBoxPrices ?? [];
      if (Array.isArray(buyBoxArr)) {
        for (const bb of buyBoxArr) {
          const lp = bb?.ListingPrice ?? bb?.listingPrice ?? bb?.Price ?? bb?.price;
          const amt = extractAmount(lp);
          if (amt != null && amt > 0) {
            buyBox = amt;
            break;
          }
        }
      }
      const compArr = cp?.CompetitivePrices ?? cp?.competitivePrices ?? [];
      if (Array.isArray(compArr)) {
        for (const c of compArr) {
          const price = c?.Price ?? c?.price;
          const lp = price?.ListingPrice ?? price?.listingPrice;
          const amt = extractAmount(lp);
          if (amt != null && amt > 0) competitiveAmounts.push(amt);
          const ld = price?.LandedPrice ?? price?.landedPrice;
          const amt2 = extractAmount(ld);
          if (amt2 != null && amt2 > 0) competitiveAmounts.push(amt2);
        }
      }
    }

    const unique = Array.from(
      new Set(competitiveAmounts.filter((n) => Number.isFinite(n) && n > 0)),
    ).sort((a, b) => a - b);
    let bestOffer: number | null = unique.length ? unique[0] : null;
    let nextBestOffer: number | null = unique.length > 1 ? unique[1] : null;
    if (bestOffer == null) bestOffer = buyBox;
    if (nextBestOffer == null) {
      // Fallback: if buy box is above the lowest competitive offer, treat it as the "next" anchor.
      nextBestOffer =
        buyBox != null && buyBox > (bestOffer ?? 0) ? buyBox : null;
    }

    return { buyBox, bestOffer, nextBestOffer };
  }

  private parseBuyBoxPriceFromCompetitivePricing(res: any): number | null {
    return this.parseCompetitivePricingTargets(res).buyBox;
  }

  /**
   * Known Amazon retail seller IDs per marketplace (for the "Ignore Amazon" rule).
   * GetItemOffers does not flag Amazon's own offer, so we match on seller id.
   * Override / extend via REPRICER_AMAZON_SELLER_IDS (comma-separated) without a deploy.
   */
  private amazonRetailSellerIds(marketplaceId: string): Set<string> {
    const known: Record<string, string[]> = {
      A1F83G8C2ARO7P: ['A3P5ROKL5A1OLE'], // UK
      ATVPDKIKX0DER: ['ATVPDKIKX0DER'], // US
      A1PA6795UKMFR9: ['A3JWKAKR8XB7XF'], // DE
      A13V1IB3VIYZZH: ['A1X6FK5RDHNB96'], // FR
      APJ6JRA9NG5V4: ['A11IL2PNWYJU7H'], // IT
      A1RKKUPIHCS9HS: ['A1AT7YVPFBWXBL'], // ES
    };
    const set = new Set<string>((known[marketplaceId] ?? []).map((s) => s.trim()).filter(Boolean));
    const extra = (process.env.REPRICER_AMAZON_SELLER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of extra) set.add(id);
    return set;
  }

  /**
   * Parse GetItemOffers into repricing anchors, applying seller-level filters.
   *
   * Filters drop competing offers we should not chase (our own offer, FBM sellers, Amazon,
   * blocked seller ids, low feedback %, sellers with too few ratings). The buy-box anchor is
   * only used when the buy-box winner survives the filters.
   */
  private parseItemOffersTargets(
    res: any,
    opts: {
      sellerId?: string | null;
      ignoreFbm?: boolean;
      ignoreAmazon?: boolean;
      amazonSellerIds?: Set<string>;
      ignoreSellerIds?: Set<string>;
      minSellerFeedbackPct?: number | null;
      minSellerRatingCount?: number | null;
    },
  ): {
    buyBox: number | null;
    bestOffer: number | null;
    nextBestOffer: number | null;
    buyBoxIsFba: boolean | null;
    hadOffers: boolean;
    keptCount: number;
  } {
    const root = res?.payload ?? res;
    const payload = root?.payload ?? root;
    const offers: any[] = Array.isArray(payload?.Offers)
      ? payload.Offers
      : Array.isArray(payload?.offers)
        ? payload.offers
        : [];

    const num = (v: unknown): number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };
    const landed = (o: any): number | null => {
      const listing = num(o?.ListingPrice?.Amount ?? o?.listingPrice?.amount);
      if (listing == null) return null;
      const ship = num(o?.Shipping?.Amount ?? o?.shipping?.amount) ?? 0;
      const total = listing + ship;
      return Number.isFinite(total) && total > 0 ? total : null;
    };
    const isFba = (o: any): boolean =>
      Boolean(o?.IsFulfilledByAmazon ?? o?.isFulfilledByAmazon);
    const isBuyBoxWinner = (o: any): boolean =>
      Boolean(o?.IsBuyBoxWinner ?? o?.isBuyBoxWinner);
    const sellerOf = (o: any): string => String(o?.SellerId ?? o?.sellerId ?? '').trim();

    const ownId = String(opts.sellerId ?? '').trim();
    const amazonIds = opts.amazonSellerIds ?? new Set<string>();
    const blocked = opts.ignoreSellerIds ?? new Set<string>();
    const minFb = opts.minSellerFeedbackPct ?? null;
    const minCount = opts.minSellerRatingCount ?? null;

    // Fulfillment of the *actual* current buy box winner (before filtering) — for onlyWhenBuyBoxFba.
    let buyBoxIsFba: boolean | null = null;
    for (const o of offers) {
      if (isBuyBoxWinner(o)) {
        buyBoxIsFba = isFba(o);
        break;
      }
    }

    const kept: { price: number; isBuyBoxWinner: boolean }[] = [];
    for (const o of offers) {
      const seller = sellerOf(o);
      if (ownId && seller && seller === ownId) continue; // our own offer
      if (opts.ignoreFbm && !isFba(o)) continue;
      if (opts.ignoreAmazon && seller && amazonIds.has(seller)) continue;
      if (blocked.size > 0 && seller && blocked.has(seller)) continue;
      if (minFb != null) {
        const pct = num(
          o?.SellerFeedbackRating?.SellerPositiveFeedbackRating ??
            o?.sellerFeedbackRating?.sellerPositiveFeedbackRating,
        );
        if (pct == null || pct < minFb) continue; // unknown/low feedback excluded
      }
      if (minCount != null) {
        const cnt = num(
          o?.SellerFeedbackRating?.FeedbackCount ?? o?.sellerFeedbackRating?.feedbackCount,
        );
        if (cnt == null || cnt < minCount) continue;
      }
      const price = landed(o);
      if (price == null) continue;
      kept.push({ price, isBuyBoxWinner: isBuyBoxWinner(o) });
    }

    const prices = kept.map((k) => k.price).sort((a, b) => a - b);
    const uniqueAsc = Array.from(new Set(prices));
    const bestOffer = uniqueAsc.length ? uniqueAsc[0] : null;
    const nextBestOffer = uniqueAsc.length > 1 ? uniqueAsc[1] : null;
    const winner = kept.find((k) => k.isBuyBoxWinner);
    const buyBox = winner ? winner.price : null;

    return {
      buyBox,
      bestOffer,
      nextBestOffer,
      buyBoxIsFba,
      hadOffers: offers.length > 0,
      keptCount: kept.length,
    };
  }

  private async getAmazonCredentialsForOrg(orgId: string): Promise<SpApiCredentials> {
    const userIds = await this.getOrgMemberUserIds(orgId);
    const account = await this.prisma.sellerAccount.findFirst({
      where: { userId: { in: userIds }, marketplace: 'amazon' },
      orderBy: { updatedAt: 'desc' },
      select: { credentials: true },
    });
    if (!account) throw new BadRequestException('Amazon account not linked for this org');
    const c = account.credentials as any;
    const creds: SpApiCredentials = {
      region: c?.region === 'na' || c?.region === 'eu' || c?.region === 'fe' ? c.region : 'eu',
      lwaClientId: c?.lwaClientId,
      lwaClientSecret: c?.lwaClientSecret,
      refreshToken: c?.refreshToken,
      awsAccessKeyId: c?.awsAccessKeyId,
      awsSecretAccessKey: c?.awsSecretAccessKey,
      awsRoleArn: process.env.AWS_ROLE_ARN,
    };
    if (
      !creds.lwaClientId ||
      !creds.lwaClientSecret ||
      !creds.refreshToken ||
      !creds.awsAccessKeyId ||
      !creds.awsSecretAccessKey
    ) {
      throw new BadRequestException('Amazon credentials are incomplete; relink Amazon account');
    }
    return creds;
  }

  private marketplaceIdToCurrency(marketplaceId: string): string {
    const map: Record<string, string> = {
      A1F83G8C2ARO7P: 'GBP',
      A1PA6795UKMFR9: 'EUR',
      A13V1IB3VIYZZH: 'EUR',
      APJ6JRA9NG5V4: 'EUR',
      A1RKKUPIHCS9HS: 'EUR',
      A28R8C7NBKEWEA: 'EUR',
      A1805IZSGTT6HS: 'EUR',
      AMEN7PMS3EDWL: 'EUR',
      A2NODRKZP88ZB9: 'SEK',
      A1C3SOZRARQ6R3: 'PLN',
      ATVPDKIKX0DER: 'USD',
      A2EUQ1WTGCTBG2: 'CAD',
      A1AM78C64UM0Y8: 'MXN',
      A2Q3Y263D00KWC: 'BRL',
      A1VC38T7YXB528: 'JPY',
      A19VAU5U5O7RUS: 'SGD',
      A39IBJ37TRP1C6: 'AUD',
    };
    return map[marketplaceId] ?? 'USD';
  }

  private parseListingPatchMeta(
    res: unknown,
    fallbackMarketplaceId: string,
    fallbackProductType?: string | null,
  ): { marketplaceId: string; productType: string; currency: string } | null {
    const payload = (res as any)?.payload ?? res;
    if (!payload || typeof payload !== 'object') return null;
    const summaries = (payload as any).summaries ?? (payload as any).Summaries;
    let productType: string | null = null;
    let marketplaceId = fallbackMarketplaceId;
    if (Array.isArray(summaries) && summaries.length > 0) {
      const s = summaries[0];
      const pt = s?.productType ?? s?.product_type;
      if (typeof pt === 'string' && pt.trim()) productType = pt.trim();
      const mid = s?.marketplaceId ?? s?.marketplace_id;
      if (typeof mid === 'string' && mid.trim()) marketplaceId = mid.trim();
    }
    if (!productType) {
      const rootPt = (payload as any).productType ?? (payload as any).product_type;
      if (typeof rootPt === 'string' && rootPt.trim()) productType = rootPt.trim();
    }
    if (!productType && typeof fallbackProductType === 'string' && fallbackProductType.trim()) {
      productType = fallbackProductType.trim();
    }
    if (!productType) return null;

    let currency = this.marketplaceIdToCurrency(marketplaceId);
    const offers = (payload as any).offers ?? (payload as any).Offers;
    if (Array.isArray(offers) && offers.length > 0) {
      const price = offers[0]?.price ?? offers[0]?.Price;
      const cur =
        price?.currency ?? price?.CurrencyCode ?? price?.currencyCode ?? price?.Currency;
      if (typeof cur === 'string' && cur.length === 3) currency = cur.toUpperCase();
    }
    return { marketplaceId, productType, currency };
  }

  private async resolveListingPatchMeta(
    creds: SpApiCredentials,
    sellerId: string,
    sku: string,
    fallbackProductType?: string | null,
  ): Promise<{ marketplaceId: string; productType: string; currency: string } | null> {
    const marketplaceIds = this.spApiClient.marketplaceIdsForListingPriceRefresh(creds.region);
    for (const mid of marketplaceIds) {
      try {
        const res = await this.spApiClient.getListingsItem(creds, sellerId, sku, [mid], [
          'summaries',
          'offers',
          'attributes',
        ]);
        const meta = this.parseListingPatchMeta(res, mid, fallbackProductType);
        if (meta) return meta;
      } catch {
        // try next marketplace
      }
    }
    return null;
  }

  private async patchAmazonListingPrice(
    creds: SpApiCredentials,
    sellerId: string,
    sku: string,
    nextPrice: number,
    fallbackProductType?: string | null,
  ): Promise<unknown> {
    const meta = await this.resolveListingPatchMeta(creds, sellerId, sku, fallbackProductType);
    if (!meta) {
      throw new Error(
        'Could not load listing via getListingsItem in any marketplace for this region (SKU not found or incomplete summaries).',
      );
    }
    const body = {
      productType: meta.productType,
      patches: [
        {
          op: 'replace',
          path: '/attributes/purchasable_offer',
          value: [
            {
              marketplace_id: meta.marketplaceId,
              currency: meta.currency,
              our_price: [
                {
                  schedule: [{ value_with_tax: nextPrice }],
                },
              ],
            },
          ],
        },
      ],
    };
    const res = await this.spApiClient.patchListingsItem(creds, sellerId, sku, meta.marketplaceId, body);
    this.throwIfListingsPatchRejected(res, sku);
    const issues = (res as any)?.issues ?? (res as any)?.Issues;
    if (Array.isArray(issues) && issues.length > 0) {
      this.logger.warn(
        `[repricer] patchListingsItem non-fatal issues for SKU ${sku}: ${JSON.stringify(issues).slice(0, 1200)}`,
      );
    }
    return res;
  }

  /**
   * Amazon often returns HTTP 200 with an `issues` array; ERROR-level issues mean the update may not apply.
   * Do not mirror the new price into our DB when this happens, or Seller Central and our app will disagree.
   */
  private throwIfListingsPatchRejected(res: unknown, sku: string) {
    const issues = (res as any)?.issues ?? (res as any)?.Issues;
    if (!Array.isArray(issues) || issues.length === 0) return;
    const fatal: string[] = [];
    for (const i of issues) {
      if (!i || typeof i !== 'object') continue;
      const sev = String((i as any).severity ?? (i as any).Severity ?? '').toUpperCase();
      if (['ERROR', 'FATAL', 'CRITICAL'].includes(sev)) {
        fatal.push(String((i as any).message ?? (i as any).Message ?? (i as any).code ?? JSON.stringify(i)));
      }
    }
    if (fatal.length) {
      throw new Error(
        `Amazon Listings PATCH issues for SKU ${sku} (price likely unchanged on Amazon until resolved): ${fatal.join(' | ')}`,
      );
    }
  }

  async runEngineForOrg(orgId: string, opts?: { dryRun?: boolean }) {
    const maxPerTickRaw = Number(process.env.REPRICER_MAX_SKUS_PER_TICK ?? 0);
    const maxPerTick =
      Number.isFinite(maxPerTickRaw) && maxPerTickRaw > 0
        ? Math.max(1, Math.min(50_000, Math.floor(maxPerTickRaw)))
        : 50_000;
    const selected = await (this.prisma as any).repricerSelectedSku.findMany({
      where: { orgId, enabled: true, ruleSetId: { not: null } },
      include: {
        product: {
          select: {
            id: true,
            sku: true,
            asin: true,
            productType: true,
            costOfGoods: true,
            estimatedAmazonFeePerUnit: true,
            estimatedReferralFeePerUnit: true,
            estimatedFbaFeePerUnit: true,
            estimatedDigitalServiceFeePerUnit: true,
            currentListedPrice: true,
            inventory: { select: { totalQty: true, availableQty: true } },
          },
        },
        ruleSet: true,
      },
      orderBy: { createdAt: 'asc' },
      take: maxPerTick,
    });

    if (!selected?.length) {
      await this.touchRepricerEngineAt(orgId);
      return { ok: true, orgId, processed: 0 };
    }

    const userIdsForFees = await this.getOrgMemberUserIds(orgId);
    const engineProductIds = selected
      .map((r: any) => String(r.product?.id ?? ''))
      .filter((id: string) => id.length > 0);
    const financesSnapEngine =
      engineProductIds.length > 0
        ? await this.amazonService.getLatestFinancesFeeSnapshotsForProducts(
            userIdsForFees,
            engineProductIds,
          )
        : new Map<string, { quantity: number; revenueTotal: number; amazonFeesTotal: number }>();

    const activeFallback = await (this.prisma as any).repricerRuleSet.findFirst({
      where: { orgId, isActive: true },
      orderBy: { updatedAt: 'desc' },
    });

    let creds: SpApiCredentials | null = null;
    let marketplaceId = 'A1F83G8C2ARO7P';
    let sellerId: string | null = null;
    try {
      creds = await this.getAmazonCredentialsForOrg(orgId);
      marketplaceId = this.defaultMarketplaceIdForRegion(creds.region);
      const userIds = await this.getOrgMemberUserIds(orgId);
      const account = await this.prisma.sellerAccount.findFirst({
        where: { userId: { in: userIds }, marketplace: 'amazon' },
        orderBy: { updatedAt: 'desc' },
        select: { sellerId: true },
      });
      sellerId = account?.sellerId ?? null;
    } catch {
      creds = null;
    }

    // Last actual price change per product (for cooldown + smart delay). One query, not N.
    const lastChangeByProduct = new Map<
      string,
      { at: Date; prev: number | null; next: number | null }
    >();
    if (engineProductIds.length > 0) {
      const changeLogs = await (this.prisma as any).repricerLog.findMany({
        where: { orgId, productId: { in: engineProductIds }, nextPrice: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { productId: true, createdAt: true, prevPrice: true, nextPrice: true },
        take: 10_000,
      });
      for (const l of changeLogs ?? []) {
        const pid = String(l.productId);
        if (lastChangeByProduct.has(pid)) continue; // first = most recent
        lastChangeByProduct.set(pid, {
          at: l.createdAt instanceof Date ? l.createdAt : new Date(l.createdAt),
          prev: l.prevPrice != null ? Number(l.prevPrice) : null,
          next: l.nextPrice != null ? Number(l.nextPrice) : null,
        });
      }
    }
    const smartDelayMinutes = (() => {
      const raw = Number(process.env.REPRICER_SMART_DELAY_MINUTES);
      return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10;
    })();
    const amazonSellerIds = this.amazonRetailSellerIds(marketplaceId);

    let processed = 0;
    for (const row of selected) {
      const preset = (row as any).ruleSet ?? activeFallback;
      if (!preset) {
        await (this.prisma as any).repricerLog.create({
          data: {
            orgId,
            productId: row.productId,
            sku: String(row.product?.sku ?? ''),
            kind: 'error',
            message: 'Skipped: no pricing rule assigned to this SKU (pick a preset with Apply).',
            prevPrice: null,
            nextPrice: null,
            context: { dryRun: opts?.dryRun !== false },
          },
        });
        processed += 1;
        continue;
      }

      // For now, use rule1 only (step chaining not executed yet).
      const minProfit = preset.rule1MinProfit != null ? Number(preset.rule1MinProfit) : null;
      const maxProfit = preset.rule1MaxProfit != null ? Number(preset.rule1MaxProfit) : null;
      const minListPriceRule =
        preset.rule1MinListPrice != null ? Number(preset.rule1MinListPrice) : null;
      const maxListPriceRule =
        preset.rule1MaxListPrice != null ? Number(preset.rule1MaxListPrice) : null;
      const minRoiPct = preset.rule1MinRoiPct != null ? Number(preset.rule1MinRoiPct) : null;
      const maxRoiPct = preset.rule1MaxRoiPct != null ? Number(preset.rule1MaxRoiPct) : null;
      const strategy = String(preset.rule1Strategy ?? '').trim();
      const beatType = String(preset.rule1BeatType ?? '').trim();
      const beatValue = preset.rule1BeatValue != null ? Number(preset.rule1BeatValue) : null;
      const pr = String(preset.rule1PriceReference ?? 'buy_box').toLowerCase();
      const priceRef =
        pr === 'best_offer'
          ? 'best_offer'
          : pr === 'next_best_offer'
            ? 'next_best_offer'
            : 'buy_box';

      // Seller-level filters (require GetItemOffers, which carries per-offer seller detail).
      const onlyWhenBuyBoxFba = Boolean(preset.rule1OnlyWhenBuyBoxFba);
      const ignoreAmazon = Boolean(preset.rule1IgnoreAmazon);
      const ignoreFbm = Boolean(preset.rule1IgnoreFbm);
      const minSellerFeedbackPct =
        preset.rule1MinSellerFeedbackPct != null
          ? Number(preset.rule1MinSellerFeedbackPct)
          : null;
      const ignoreSellerViewsEnabled = Boolean(preset.rule1IgnoreSellerViewsEnabled);
      const minSellerRatingCount =
        ignoreSellerViewsEnabled && preset.rule1IgnoreSellerViewsBelow != null
          ? Number(preset.rule1IgnoreSellerViewsBelow)
          : null;
      const ignoreSellerIdSet = new Set<string>(
        (Array.isArray(preset.rule1IgnoreSellerIds) ? preset.rule1IgnoreSellerIds : [])
          .map((s: unknown) => String(s).trim())
          .filter((s: string) => s.length > 0),
      );
      const needOffers =
        Boolean(creds) &&
        (ignoreFbm ||
          ignoreAmazon ||
          onlyWhenBuyBoxFba ||
          ignoreSellerIdSet.size > 0 ||
          minSellerFeedbackPct != null ||
          minSellerRatingCount != null);

      // Rule expiry + cooldown gates.
      const ruleEndsAt = preset.rule1EndsAt ? new Date(preset.rule1EndsAt) : null;
      const ruleExpired =
        ruleEndsAt != null && !Number.isNaN(ruleEndsAt.getTime()) && ruleEndsAt.getTime() < Date.now();
      const cooldownMinutes =
        preset.rule1CooldownMinutes != null ? Number(preset.rule1CooldownMinutes) : null;
      const smartDelayEnabled = Boolean(preset.rule1SmartDelayEnabled);
      const lastChange = lastChangeByProduct.get(String(row.product?.id ?? '')) ?? null;
      const minutesSinceLastChange =
        lastChange != null ? (Date.now() - lastChange.at.getTime()) / 60_000 : null;
      const inCooldown =
        cooldownMinutes != null &&
        cooldownMinutes > 0 &&
        minutesSinceLastChange != null &&
        minutesSinceLastChange < cooldownMinutes;

      // Stock gate: only reprice ASINs we positively know are in stock.
      // Skip only when inventory is known AND zero (don't punish listings without an FBA inventory row).
      const invTotalQty = Number((row.product as any)?.inventory?.totalQty);
      const invAvailQty = Number((row.product as any)?.inventory?.availableQty);
      const hasInventoryRow = (row.product as any)?.inventory != null;
      const knownOutOfStock =
        hasInventoryRow &&
        (!Number.isFinite(invTotalQty) || invTotalQty <= 0) &&
        (!Number.isFinite(invAvailQty) || invAvailQty <= 0);

      const p = row.product;
      const sku = String(p?.sku ?? '');
      const asin = p?.asin ? String(p.asin) : null;
      const current = p?.currentListedPrice != null ? Number(p.currentListedPrice) : null;
      const costRaw = p?.costOfGoods != null ? Number(p.costOfGoods) : null;
      const cost = this.isSuspiciousCogs(costRaw, current) ? null : costRaw;
      const fee = this.amazonService.repricerAmazonFeePerUnitFromProduct(
        {
          currentListedPrice: p?.currentListedPrice,
          estimatedReferralFeePerUnit: (p as any)?.estimatedReferralFeePerUnit,
          estimatedFbaFeePerUnit: (p as any)?.estimatedFbaFeePerUnit,
          estimatedDigitalServiceFeePerUnit: (p as any)?.estimatedDigitalServiceFeePerUnit,
          estimatedAmazonFeePerUnit: p?.estimatedAmazonFeePerUnit,
        },
        financesSnapEngine.get(p.id) ?? null,
      );
      // External listing price drift logging is noisy during normal operation (syncs/manual edits/etc).
      // Keep disabled by default; enable only when debugging with REPRICER_LOG_EXTERNAL_DRIFT=true.
      const driftRaw = (process.env.REPRICER_LOG_EXTERNAL_DRIFT ?? '').toLowerCase();
      const logDrift = ['1', 'true', 'yes', 'on'].includes(driftRaw);
      if (logDrift && current != null && Number.isFinite(current) && current > 0) {
        await this.maybeLogExternalListingPriceDrift(orgId, p.id, sku, current);
      }
      const bounds = this.computeBounds({
        cost,
        fee,
        minProfit,
        maxProfit,
        minRoiPct,
        maxRoiPct,
        minListPrice: minListPriceRule,
        maxListPrice: maxListPriceRule,
      });

      let message = '';
      let logKind: 'decision' | 'error' = 'decision';
      let nextPrice: number | null = null;
      let buyBoxPrice: number | null = null;
      let bestOfferPrice: number | null = null;
      let refPrice: number | null = null;
      let skipNoBuyBox = false;
      let skipMessageOverride: string | null = null;
      let usedOffers = false;
      let gateReason: string | null = null;
      if (ruleExpired) {
        gateReason = 'rule_expired';
        message = 'No change: pricing rule end date has passed (rule paused).';
        nextPrice = current;
      } else if (knownOutOfStock) {
        gateReason = 'out_of_stock';
        message = 'No change: out of stock — repricer only adjusts in-stock listings.';
        nextPrice = current;
      } else if (inCooldown) {
        gateReason = 'cooldown';
        message = `No change: within cooldown window (${cooldownMinutes}m since last change).`;
        nextPrice = current;
      } else if (!bounds) {
        message = this.isSuspiciousCogs(costRaw, current)
          ? 'Skipped: suspiciously low COGS for this SKU (fix COGS and retry).'
          : 'Skipped: missing COGS (needed to compute ROI/profit bounds).';
      } else if (bounds.minPrice != null && bounds.maxPrice != null && bounds.maxPrice < bounds.minPrice) {
        message = 'Skipped: bounds invalid (max < min).';
      } else if (current == null || !Number.isFinite(current) || current <= 0) {
        message = 'Skipped: missing current listed price.';
      } else {
        if (creds && asin && strategy && strategy !== 'no_buy_box') {
          let t: { buyBox: number | null; bestOffer: number | null; nextBestOffer: number | null } | null =
            null;
          // Seller-level filters need per-offer detail → GetItemOffers. Fall back to
          // competitive pricing if offers are unavailable so repricing never breaks.
          if (needOffers) {
            try {
              const ores = await this.spApiClient.getItemOffersForAsin(creds, {
                marketplaceId,
                asin,
              });
              const ot = this.parseItemOffersTargets(ores as any, {
                sellerId,
                ignoreFbm,
                ignoreAmazon,
                amazonSellerIds,
                ignoreSellerIds: ignoreSellerIdSet,
                minSellerFeedbackPct,
                minSellerRatingCount,
              });
              if (ot.hadOffers) {
                if (onlyWhenBuyBoxFba && ot.buyBoxIsFba === false) {
                  skipNoBuyBox = true;
                  skipMessageOverride =
                    'No change: buy box is not FBA (rule: only reprice when buy box is FBA).';
                } else if (ot.keptCount === 0) {
                  skipNoBuyBox = true;
                  skipMessageOverride =
                    'No change: no eligible competitor offers after filters (FBM/Amazon/seller rules).';
                } else {
                  t = {
                    buyBox: ot.buyBox,
                    bestOffer: ot.bestOffer,
                    nextBestOffer: ot.nextBestOffer,
                  };
                  usedOffers = true;
                }
              }
            } catch {
              t = null; // fall back to competitive pricing
            }
          }
          try {
            if (!skipNoBuyBox && !t) {
              const res = await this.spApiClient.getCompetitivePricingForASINs(creds, {
                marketplaceId,
                asins: [asin],
              });
              t = this.parseCompetitivePricingTargets(res as any);
            }
            if (!skipNoBuyBox && t) {
            buyBoxPrice = t.buyBox;
            bestOfferPrice = t.bestOffer;
            const bestOk =
              bestOfferPrice != null && Number.isFinite(bestOfferPrice) && bestOfferPrice > 0;
            const buyBoxOk = buyBoxPrice != null && Number.isFinite(buyBoxPrice) && buyBoxPrice > 0;
            // No featured buy box: still reprice when the rule explicitly uses lowest competitive offer.
            if (!buyBoxOk) {
              if ((priceRef === 'best_offer' || priceRef === 'next_best_offer') && bestOk) {
                skipNoBuyBox = false;
                // If we don't have a buy box, we can't reliably infer the "next" anchor; fall back to best offer.
                refPrice = bestOfferPrice;
              } else {
                // buy_box reference (or no usable competitive low) → do not infer a target without a buy box.
                skipNoBuyBox = true;
                refPrice = null;
              }
            } else {
              // Buy box can sit above the market while CompetitivePrices includes lower offers.
              // Respect the user's configured reference:
              // - buy_box: use featured buy box price
              // - best_offer: use lowest competitive offer (fallback to buy box only when best-offer is unavailable)
              // - next_best_offer: if the lowest offer equals our current price, anchor to the next offer above (or buy box when available)
              const chosenBySetting =
                priceRef === 'best_offer'
                  ? bestOfferPrice
                  : priceRef === 'next_best_offer'
                    ? (() => {
                        const best = bestOfferPrice;
                        const next = t.nextBestOffer;
                        if (
                          best != null &&
                          current != null &&
                          Number.isFinite(current) &&
                          Math.round(best * 100) === Math.round(Number(current) * 100) &&
                          next != null &&
                          next > best
                        ) {
                          return next;
                        }
                        return bestOfferPrice ?? buyBoxPrice;
                      })()
                    : buyBoxPrice;
              refPrice = chosenBySetting ?? buyBoxPrice ?? bestOfferPrice ?? null;

              // If "best offer" equals our current price, we can get stuck at the bottom
              // (CompetitivePrices can include our own offer). When the buy box has moved up,
              // allow the reference to follow up so we can raise price too.
              if (
                (priceRef === 'best_offer' || priceRef === 'next_best_offer') &&
                refPrice != null &&
                buyBoxOk &&
                buyBoxPrice != null &&
                current != null &&
                Number.isFinite(current) &&
                Math.round(refPrice * 100) === Math.round(Number(current) * 100) &&
                buyBoxPrice > refPrice
              ) {
                refPrice = buyBoxPrice;
              }
            }
            }
          } catch {
            buyBoxPrice = null;
            bestOfferPrice = null;
            refPrice = null;
          }
        }

        let target = current;
        if (
          !skipNoBuyBox &&
          strategy &&
          strategy !== 'no_buy_box' &&
          refPrice != null &&
          refPrice > 0
        ) {
          if (strategy === 'match_buy_box') {
            target = refPrice;
          } else if (strategy === 'beat_buy_box') {
            if (beatType === 'percent' && beatValue != null && Number.isFinite(beatValue)) {
              target = refPrice * (1 - Math.max(0, beatValue) / 100);
            } else if (beatValue != null && Number.isFinite(beatValue)) {
              target = refPrice - Math.max(0, beatValue);
            } else {
              // No X configured — same as matching the reference (avoid silently leaving price unchanged).
              target = refPrice;
            }
          } else if (strategy === 'stay_above_buy_box') {
            if (beatType === 'percent' && beatValue != null && Number.isFinite(beatValue)) {
              target = refPrice * (1 + Math.max(0, beatValue) / 100);
            } else if (beatValue != null && Number.isFinite(beatValue)) {
              target = refPrice + Math.max(0, beatValue);
            } else {
              target = refPrice;
            }
          }
        }

        const minP = bounds.minPrice ?? null;
        const maxP = bounds.maxPrice ?? null;
        let clamped = target;
        if (minP != null && clamped < minP) clamped = minP;
        if (maxP != null && clamped > maxP) clamped = maxP;
        if (clamped < 0.01) clamped = 0.01;
        if (!Number.isFinite(clamped)) {
          nextPrice = null;
        } else {
          // Rounding matters for ROI/profit bounds. If we are at the minimum bound, rounding down
          // can put us just below min ROI/profit. So:
          // - min bound: round UP to the nearest penny
          // - max bound: round DOWN to the nearest penny
          // - otherwise: normal rounding
          const nearMin = minP != null && clamped <= minP + 1e-9;
          const nearMax = maxP != null && clamped >= maxP - 1e-9;
          if (nearMin && minP != null) nextPrice = Math.ceil(minP * 100) / 100;
          else if (nearMax && maxP != null) nextPrice = Math.floor(maxP * 100) / 100;
          else nextPrice = Math.round(clamped * 100) / 100;

          // Safety: keep within bounds after rounding.
          if (minP != null && nextPrice < minP) nextPrice = Math.ceil(minP * 100) / 100;
          if (maxP != null && nextPrice > maxP) nextPrice = Math.floor(maxP * 100) / 100;
        }

        // Hard safety: min ROI/profit must hold at the chosen nextPrice.
        // Fees can be price-dependent (Finances snapshot scaling), so recompute at the candidate price
        // and bump upward until the constraints are satisfied (or hit max bound).
        if (
          nextPrice != null &&
          bounds &&
          (minRoiPct != null || minProfit != null) &&
          cost != null &&
          Number.isFinite(cost) &&
          cost > 0
        ) {
          const feeAt = (price: number): number => {
            const outFee = this.amazonService.repricerAmazonFeePerUnitFromProduct(
              {
                currentListedPrice: price,
                estimatedReferralFeePerUnit: (p as any)?.estimatedReferralFeePerUnit,
                estimatedFbaFeePerUnit: (p as any)?.estimatedFbaFeePerUnit,
                estimatedDigitalServiceFeePerUnit: (p as any)?.estimatedDigitalServiceFeePerUnit,
                estimatedAmazonFeePerUnit: p?.estimatedAmazonFeePerUnit,
              },
              financesSnapEngine.get(p.id) ?? null,
            );
            return outFee != null && Number.isFinite(outFee) ? Math.abs(Number(outFee)) : 0;
          };
          const meets = (price: number) => {
            const feeAbs = feeAt(price);
            const profitAbs = price - feeAbs - Number(cost);
            const roiPctNow = (profitAbs / Number(cost)) * 100;
            const okProfit = minProfit == null || !Number.isFinite(minProfit) ? true : profitAbs >= Number(minProfit) - 1e-9;
            const okRoi = minRoiPct == null || !Number.isFinite(minRoiPct) ? true : roiPctNow >= Number(minRoiPct) - 1e-9;
            return okProfit && okRoi;
          };

          if (!meets(nextPrice)) {
            const maxAllowed = maxP != null ? Math.floor(maxP * 100) / 100 : null;
            let lo = nextPrice;
            let hi =
              maxAllowed != null
                ? maxAllowed
                : Math.max(nextPrice, Number(cost) * 5); // loose cap when no explicit max

            // If even the max cannot satisfy, we'll keep the computed price but mark it as error in logs later.
            if (maxAllowed != null && !meets(maxAllowed)) {
              // leave nextPrice as-is; message will reflect ROI and bounds.
            } else {
              // Binary search in pennies for the smallest price that satisfies constraints.
              // Work in integer pennies to avoid floating drift.
              let loP = Math.round(lo * 100);
              let hiP = Math.round(hi * 100);
              // Ensure hi satisfies; if not and no max bound, expand a bit.
              if (maxAllowed == null) {
                let expansions = 0;
                while (expansions < 10 && !meets(hiP / 100)) {
                  hiP = Math.min(hiP * 2, Math.round(Number(cost) * 1000)); // hard stop
                  expansions += 1;
                }
              }
              if (meets(hiP / 100)) {
                while (loP + 1 < hiP) {
                  const mid = Math.floor((loP + hiP) / 2);
                  if (meets(mid / 100)) hiP = mid;
                  else loP = mid;
                }
                nextPrice = hiP / 100;
              }
            }
          }
        }

        // Smart delay: hold off chasing a competitor's price DROP for a short window
        // (anti price-war). Upward moves are always allowed. Disabled if smartDelayEnabled is off.
        if (
          smartDelayEnabled &&
          !skipNoBuyBox &&
          nextPrice != null &&
          current != null &&
          Number.isFinite(nextPrice) &&
          nextPrice < current &&
          minutesSinceLastChange != null &&
          minutesSinceLastChange < smartDelayMinutes
        ) {
          skipNoBuyBox = true;
          skipMessageOverride = `No change: smart delay holding price drop (${Math.floor(
            minutesSinceLastChange,
          )}m of ${smartDelayMinutes}m).`;
        }

        if (skipNoBuyBox) {
          message = skipMessageOverride ?? RepricerService.SKIP_NO_BUY_BOX_UNCHANGED_MSG;
          nextPrice = current;
        } else if (nextPrice != null && nextPrice !== current) {
          const refLabel =
            priceRef === 'best_offer'
              ? 'bestOffer'
              : priceRef === 'next_best_offer'
                ? 'nextBest'
                : 'buyBox';
          const detail = `${strategy || 'bounds-only'}${refPrice != null ? `, ${refLabel}=${refPrice.toFixed(2)}` : ''}`;
          const isLive = opts?.dryRun === false;
          if (isLive) {
            if (!creds || !sellerId) {
              logKind = 'error';
              message =
                'LIVE: missing Amazon credentials or seller ID; cannot update listing on Amazon.';
            } else {
              try {
                await this.patchAmazonListingPrice(
                  creds,
                  sellerId,
                  sku,
                  nextPrice,
                  p?.productType != null ? String(p.productType) : null,
                );
                const feeAtPrice = (price: number): number | null => {
                  const outFee = this.amazonService.repricerAmazonFeePerUnitFromProduct(
                    {
                      currentListedPrice: price,
                      estimatedReferralFeePerUnit: (p as any)?.estimatedReferralFeePerUnit,
                      estimatedFbaFeePerUnit: (p as any)?.estimatedFbaFeePerUnit,
                      estimatedDigitalServiceFeePerUnit: (p as any)?.estimatedDigitalServiceFeePerUnit,
                      estimatedAmazonFeePerUnit: p?.estimatedAmazonFeePerUnit,
                    },
                    financesSnapEngine.get(p.id) ?? null,
                  );
                  return outFee != null && Number.isFinite(outFee) ? Math.abs(Number(outFee)) : null;
                };
                const feeAbs =
                  feeAtPrice(Number(nextPrice)) ??
                  (fee != null && Number.isFinite(Number(fee)) ? Math.abs(Number(fee)) : null);
                const roiPct =
                  cost != null &&
                  Number.isFinite(Number(cost)) &&
                  Number(cost) > 0 &&
                  feeAbs != null &&
                  Number.isFinite(nextPrice)
                    ? ((Number(nextPrice) - feeAbs - Number(cost)) / Number(cost)) * 100
                    : null;
                message = `Amazon listing price updated ${current.toFixed(2)} → ${nextPrice.toFixed(2)} (${detail})${
                  roiPct != null && Number.isFinite(roiPct) ? ` • roi≈${(Math.round(roiPct * 10) / 10).toFixed(1)}%` : ''
                }.`;
                const now = new Date();
                await this.prisma.product.update({
                  where: { id: p.id },
                  data: { currentListedPrice: nextPrice as any, currentListedPriceUpdatedAt: now } as any,
                });
              } catch (e) {
                logKind = 'error';
                message = `LIVE: Amazon price update failed: ${e instanceof Error ? e.message : String(e)}`;
              }
            }
          } else {
            const feeAtPrice = (price: number): number | null => {
              const outFee = this.amazonService.repricerAmazonFeePerUnitFromProduct(
                {
                  currentListedPrice: price,
                  estimatedReferralFeePerUnit: (p as any)?.estimatedReferralFeePerUnit,
                  estimatedFbaFeePerUnit: (p as any)?.estimatedFbaFeePerUnit,
                  estimatedDigitalServiceFeePerUnit: (p as any)?.estimatedDigitalServiceFeePerUnit,
                  estimatedAmazonFeePerUnit: p?.estimatedAmazonFeePerUnit,
                },
                financesSnapEngine.get(p.id) ?? null,
              );
              return outFee != null && Number.isFinite(outFee) ? Math.abs(Number(outFee)) : null;
            };
            const feeAbs =
              feeAtPrice(Number(nextPrice)) ??
              (fee != null && Number.isFinite(Number(fee)) ? Math.abs(Number(fee)) : null);
            const roiPct =
              cost != null &&
              Number.isFinite(Number(cost)) &&
              Number(cost) > 0 &&
              feeAbs != null &&
              Number.isFinite(nextPrice)
                ? ((Number(nextPrice) - feeAbs - Number(cost)) / Number(cost)) * 100
                : null;
            message = `DRY-RUN: would update price from ${current.toFixed(2)} → ${nextPrice.toFixed(2)} (${detail})${
              roiPct != null && Number.isFinite(roiPct) ? ` • roi≈${(Math.round(roiPct * 10) / 10).toFixed(1)}%` : ''
            }.`;
            // Default false: do not write our DB-only price when not PATCHing Amazon (avoids "SB shows new price, Seller Central doesn't").
            const simulate = (process.env.REPRICER_SIMULATE_PRICE_UPDATE ?? 'false').toLowerCase();
            if (opts?.dryRun !== false && ['1', 'true', 'yes'].includes(simulate)) {
              const now = new Date();
              await this.prisma.product.update({
                where: { id: p.id },
                data: { currentListedPrice: nextPrice as any, currentListedPriceUpdatedAt: now } as any,
              });
            }
          }
        } else {
          message = 'No change: current price already satisfies rules/bounds.';
          nextPrice = current;
        }
      }

      const logContext = {
        dryRun: opts?.dryRun !== false,
        liveAmazonUpdate: opts?.dryRun === false,
        rule: 'rule1',
        strategy,
        priceReference: priceRef,
        buyBoxPrice,
        bestOfferPrice,
        refPrice,
        minProfit,
        maxProfit,
        minListPrice: minListPriceRule,
        maxListPrice: maxListPriceRule,
        minRoiPct,
        maxRoiPct,
        cost,
        fee,
        bounds: bounds ?? null,
        ruleSetId: preset.id,
        ruleSetName: preset.name ?? null,
        skipNoBuyBox,
        usedOffers,
        gateReason,
        filters: {
          ignoreFbm,
          ignoreAmazon,
          onlyWhenBuyBoxFba,
          ignoreSellerIds: Array.from(ignoreSellerIdSet),
          minSellerFeedbackPct,
          minSellerRatingCount,
          cooldownMinutes,
          smartDelayEnabled,
          ruleEndsAt: ruleEndsAt ? ruleEndsAt.toISOString() : null,
        },
        stock: hasInventoryRow
          ? { totalQty: invTotalQty, availableQty: invAvailQty }
          : null,
      };

      const unchangedNumeric =
        logKind === 'decision' &&
        current != null &&
        Number.isFinite(current) &&
        (nextPrice == null ||
          !Number.isFinite(nextPrice) ||
          Math.round(Number(nextPrice) * 100) === Math.round(Number(current) * 100));

      const isAnchoredUnchanged =
        unchangedNumeric && RepricerService.isIdleChurnLogMessage(message);

      const unchangedReason =
        skipNoBuyBox || message === RepricerService.SKIP_NO_BUY_BOX_UNCHANGED_MSG
          ? 'no_buy_box'
          : 'at_target';

      if (isAnchoredUnchanged) {
        const now = new Date();
        const anchoredContext = {
          ...logContext,
          unchangedAnchor: true,
          unchangedReason,
        };
        const existing = await this.findAnchoredUnchangedLogRow(orgId, p.id);
        let anchorId: string;
        if (existing) {
          anchorId = existing.id;
          try {
            await (this.prisma as any).repricerLog.update({
              where: { id: existing.id },
              data: {
                lastCheckedAt: now,
                message: RepricerService.ANCHORED_UNCHANGED_CURRENT_MSG,
                sku,
                prevPrice: current as any,
                nextPrice: null,
                context: anchoredContext as any,
              },
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const missingLastChecked =
              /\blast_checked_at\b/i.test(msg) || /no such column.*last_checked_at/i.test(msg);
            if (!missingLastChecked) throw e;
            // Older DB: update without lastCheckedAt.
            await (this.prisma as any).repricerLog.update({
              where: { id: existing.id },
              data: {
                message: RepricerService.ANCHORED_UNCHANGED_CURRENT_MSG,
                sku,
                prevPrice: current as any,
                nextPrice: null,
                context: anchoredContext as any,
              },
              // Avoid selecting missing columns (e.g. last_checked_at) on older DBs.
              select: { id: true },
            });
          }
        } else {
          let created: any;
          try {
            created = await (this.prisma as any).repricerLog.create({
              data: {
                orgId,
                productId: p.id,
                sku,
                kind: logKind,
                message: RepricerService.ANCHORED_UNCHANGED_CURRENT_MSG,
                prevPrice: current as any,
                nextPrice: null,
                lastCheckedAt: now,
                context: anchoredContext as any,
              },
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const missingLastChecked =
              /\blast_checked_at\b/i.test(msg) || /no such column.*last_checked_at/i.test(msg);
            if (!missingLastChecked) throw e;
            // Older DB: create without lastCheckedAt.
            created = await (this.prisma as any).repricerLog.create({
              data: {
                orgId,
                productId: p.id,
                sku,
                kind: logKind,
                message: RepricerService.ANCHORED_UNCHANGED_CURRENT_MSG,
                prevPrice: current as any,
                nextPrice: null,
                context: anchoredContext as any,
              },
              // Avoid selecting missing columns (e.g. last_checked_at) on older DBs.
              select: { id: true },
            });
          }
          anchorId = created.id;
        }
        await this.deleteStaleUnchangedRepricerLogsExcept(orgId, p.id, anchorId);
      } else {
        await this.deleteAnchoredUnchangedLogsForProduct(orgId, p.id);
        let created: any;
        try {
          created = await (this.prisma as any).repricerLog.create({
            data: {
              orgId,
              productId: p.id,
              sku,
              kind: logKind,
              message,
              prevPrice: current,
              nextPrice: nextPrice != null && nextPrice !== current ? nextPrice : null,
              context: logContext as any,
            },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const missingLastChecked =
            /\blast_checked_at\b/i.test(msg) || /no such column.*last_checked_at/i.test(msg);
          if (!missingLastChecked) throw e;
          // Older DB: avoid selecting missing columns (e.g. last_checked_at) by using a minimal select.
          created = await (this.prisma as any).repricerLog.create({
            data: {
              orgId,
              productId: p.id,
              sku,
              kind: logKind,
              message,
              prevPrice: current,
              nextPrice: nextPrice != null && nextPrice !== current ? nextPrice : null,
              context: logContext as any,
            },
            select: { id: true },
          });
        }
        await this.deleteStaleUnchangedRepricerLogsExcept(orgId, p.id, created.id);
      }
      processed += 1;
    }

    await this.touchRepricerEngineAt(orgId);
    await this.pruneRepricerLogsForOrg(orgId);
    return { ok: true, orgId, processed };
  }

  /**
   * Prevent repricer logs from growing without bound.
   *
   * Policy (configurable):
   * - Delete rows older than REPRICER_LOG_RETENTION_DAYS (default 30)
   * - Keep at most REPRICER_LOG_RETENTION_MAX_PER_ORG rows per org (default 2000)
   *
   * Non-fatal: failures here must never break repricing.
   */
  private async pruneRepricerLogsForOrg(orgId: string) {
    const daysRaw = Number(process.env.REPRICER_LOG_RETENTION_DAYS);
    const maxRaw = Number(process.env.REPRICER_LOG_RETENTION_MAX_PER_ORG);
    const retentionDays = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.floor(daysRaw) : 30;
    const maxPerOrg = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : 2000;

    try {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      await (this.prisma as any).repricerLog.deleteMany({
        where: { orgId, createdAt: { lt: cutoff } },
      });
    } catch (e) {
      this.logger.warn(
        `[repricer] log retention (days) cleanup failed for org ${orgId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    try {
      const total = await (this.prisma as any).repricerLog.count({ where: { orgId } });
      const extra = total - maxPerOrg;
      if (extra <= 0) return;

      const oldest = await (this.prisma as any).repricerLog.findMany({
        where: { orgId },
        orderBy: { createdAt: 'asc' },
        take: extra,
        select: { id: true },
      });
      const ids = (oldest ?? []).map((r: { id: string }) => r.id).filter(Boolean);
      if (ids.length > 0) {
        await (this.prisma as any).repricerLog.deleteMany({ where: { id: { in: ids } } });
      }
    } catch (e) {
      this.logger.warn(
        `[repricer] log retention (max) cleanup failed for org ${orgId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async touchRepricerEngineAt(orgId: string) {
    try {
      // Raw UPDATE: Prisma `organization.update` can fail when the DB is behind `schema.prisma`
      // (e.g. missing `fixed_costs_software_items`) because the client still materializes the full model.
      const now = new Date();
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE organizations SET repricer_last_engine_at = ${now} WHERE id = ${orgId}`,
      );
    } catch (e) {
      this.logger.warn(
        `[repricer] could not set repricerLastEngineAt for org ${orgId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

