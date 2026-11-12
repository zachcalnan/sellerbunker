import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AmazonService } from './amazon.service';
import { KeepaClient } from './keepa.client';
import {
  DEAL_CHECK_ROI_GATE,
  DECEMBER_BLEND_WEIGHT,
  computeDealCheckEconomics,
  computeDealCheckPriceStats,
  currencyForKeepaDomain,
  marketplaceIdToKeepaDomain,
} from './keepa-deal-check.util';

export type DealCheckResult = {
  asin: string;
  title: string | null;
  currency: string;
  marketplaceId: string;
  keepaDomainId: number;
  buyPrice: number;
  lookbackDays: number;
  priceSource: 'keepa_new_fba' | 'keepa_new';
  sampleDays: number;
  currentPrice: number | null;
  medianPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  goodResalePrice: number | null;
  bestCaseResalePrice: number | null;
  /** Historical share of days New/FBA ≥ goodResalePrice. */
  probabilityPct: number | null;
  decemberGoodResalePrice: number | null;
  decemberSampleDays: number;
  decemberWeight: number;
  feesAtGood: number | null;
  profitAtGood: number | null;
  roiAtGood: number | null;
  meetsRoiGate: boolean;
  usedFeeFallback: boolean;
  monthlySoldEstimate: number | null;
  tokensLeft: number | null;
  tokensConsumed: number | null;
  note: string;
};

@Injectable()
export class DealCheckService {
  private readonly logger = new Logger(DealCheckService.name);

  constructor(
    private readonly keepa: KeepaClient,
    private readonly prisma: PrismaService,
    private readonly amazonService: AmazonService,
  ) {}

  async checkDeal(
    orgId: string,
    input: {
      asin: string;
      buyPrice: number;
      marketplaceId?: string | null;
      lookbackDays?: number;
    },
  ): Promise<DealCheckResult> {
    const asin = String(input.asin ?? '')
      .trim()
      .toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      throw new BadRequestException('asin must be a 10-character Amazon ASIN');
    }
    const buyPrice = Number(input.buyPrice);
    if (!Number.isFinite(buyPrice) || buyPrice <= 0) {
      throw new BadRequestException('buyPrice must be a positive number');
    }
    if (!this.keepa.isConfigured()) {
      throw new ServiceUnavailableException(
        'Keepa is not configured. Add KEEPA_API_KEY to deploy/.env.personal and redeploy.',
      );
    }

    const marketplaceId =
      String(input.marketplaceId ?? '').trim() || 'A1F83G8C2ARO7P';
    const domainId = marketplaceIdToKeepaDomain(marketplaceId);
    const currency = currencyForKeepaDomain(domainId);
    const lookbackDays = Math.max(
      30,
      Math.min(365, Math.floor(Number(input.lookbackDays) || 365)),
    );

    const keepaRes = await this.keepa.fetchProduct({
      asin,
      domainId,
      days: lookbackDays,
      statsDays: lookbackDays,
    });
    const product = Array.isArray(keepaRes.products) ? keepaRes.products[0] : null;
    if (!product) {
      throw new BadRequestException(`No Keepa product found for ASIN ${asin}`);
    }

    const stats = computeDealCheckPriceStats({
      csv: product.csv,
      domainId,
      lookbackDays,
    });

    const good = stats.goodResalePrice;
    let feesAtGood: number | null = null;
    let usedFeeFallback = false;

    if (good != null) {
      const feeLive = await this.amazonService.estimateFbaFeesForAsinAtPrice(orgId, {
        asin,
        marketplaceId,
        listingPrice: good,
        currency,
      });
      if (feeLive != null && feeLive > 0) {
        feesAtGood = feeLive;
      } else {
        const scaled = await this.scaleStoredFees(orgId, asin, good);
        if (scaled != null) {
          feesAtGood = scaled.fees;
          usedFeeFallback = scaled.fallback;
        } else {
          usedFeeFallback = true;
          feesAtGood = Math.round(good * 0.35 * 100) / 100;
        }
      }
    }

    let economics: ReturnType<typeof computeDealCheckEconomics> | null = null;
    if (good != null && feesAtGood != null) {
      economics = computeDealCheckEconomics({
        buyPrice,
        resalePrice: good,
        feesPerUnit: feesAtGood,
        roiGate: DEAL_CHECK_ROI_GATE,
      });
      usedFeeFallback = economics.usedFeeFallback || usedFeeFallback;
    }

    const monthlySold =
      product.monthlySold != null && Number.isFinite(Number(product.monthlySold))
        ? Number(product.monthlySold)
        : null;

    const sourceLabel =
      stats.source === 'keepa_new_fba'
        ? '3P New FBA history'
        : 'marketplace New history (3P; Amazon 1P excluded)';
    const decNote =
      stats.decemberWeight > 0 && stats.decemberGoodResalePrice != null
        ? ` Blended ${Math.round(stats.decemberWeight * 100)}% toward December band (~${currency} ${stats.decemberGoodResalePrice}, ${stats.decemberSampleDays} Dec days).`
        : ` No December blend (need Dec history in the window; weight ${Math.round(DECEMBER_BLEND_WEIGHT * 100)}% when available).`;

    return {
      asin,
      title: product.title ? String(product.title) : null,
      currency,
      marketplaceId,
      keepaDomainId: domainId,
      buyPrice,
      lookbackDays: stats.lookbackDays,
      priceSource: stats.source,
      sampleDays: stats.sampleDays,
      currentPrice: stats.currentPrice,
      medianPrice: stats.medianPrice,
      minPrice: stats.minPrice,
      maxPrice: stats.maxPrice,
      goodResalePrice: stats.goodResalePrice,
      bestCaseResalePrice: stats.bestCaseResalePrice,
      probabilityPct: stats.probabilityPct,
      decemberGoodResalePrice: stats.decemberGoodResalePrice,
      decemberSampleDays: stats.decemberSampleDays,
      decemberWeight: stats.decemberWeight,
      feesAtGood: economics?.feesPerUnit ?? feesAtGood,
      profitAtGood: economics?.profitPerUnit ?? null,
      roiAtGood: economics?.roi ?? null,
      meetsRoiGate: economics?.meetsRoiGate ?? false,
      usedFeeFallback,
      monthlySoldEstimate: monthlySold,
      tokensLeft:
        keepaRes.tokensLeft != null ? Number(keepaRes.tokensLeft) : null,
      tokensConsumed:
        keepaRes.tokensConsumed != null
          ? Number(keepaRes.tokensConsumed)
          : null,
      note: `Good resale = ~75th percentile of ${sourceLabel} over ${stats.lookbackDays}d (rounded).${decNote} Probability = share of days at/above that level. ROI gate ${Math.round(DEAL_CHECK_ROI_GATE * 100)}%.`,
    };
  }

  private async scaleStoredFees(
    orgId: string,
    asin: string,
    targetPrice: number,
  ): Promise<{ fees: number; fallback: boolean } | null> {
    const membershipUsers = await this.prisma.organizationMembership.findMany({
      where: { orgId },
      select: { userId: true },
      take: 20,
    });
    const userIds = membershipUsers.map((m) => m.userId);
    if (userIds.length === 0) return null;

    const product = await this.prisma.product.findFirst({
      where: { userId: { in: userIds }, asin },
      select: {
        currentListedPrice: true,
        estimatedReferralFeePerUnit: true,
        estimatedFbaFeePerUnit: true,
        estimatedDigitalServiceFeePerUnit: true,
        estimatedAmazonFeePerUnit: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!product) return null;

    const listed =
      product.currentListedPrice != null
        ? Number(product.currentListedPrice)
        : null;
    const ref =
      product.estimatedReferralFeePerUnit != null
        ? Math.abs(Number(product.estimatedReferralFeePerUnit))
        : null;
    const fba =
      product.estimatedFbaFeePerUnit != null
        ? Math.abs(Number(product.estimatedFbaFeePerUnit))
        : null;
    const dsf =
      product.estimatedDigitalServiceFeePerUnit != null
        ? Math.abs(Number(product.estimatedDigitalServiceFeePerUnit))
        : null;
    const totalStored =
      product.estimatedAmazonFeePerUnit != null
        ? Math.abs(Number(product.estimatedAmazonFeePerUnit))
        : null;

    if (ref != null && listed != null && listed > 0) {
      const referralRate = ref / listed;
      const scaledRef = referralRate * targetPrice;
      const scaledDsf =
        dsf != null && listed > 0
          ? (dsf / listed) * targetPrice
          : targetPrice * 0.02;
      const fbaFee = fba ?? 0;
      const fees = Math.round((scaledRef + fbaFee + scaledDsf) * 100) / 100;
      return { fees, fallback: false };
    }

    if (totalStored != null && listed != null && listed > 0) {
      const rate = totalStored / listed;
      return {
        fees: Math.round(rate * targetPrice * 100) / 100,
        fallback: true,
      };
    }

    this.logger.debug(`No stored fees to scale for ASIN ${asin}`);
    return null;
  }
}
