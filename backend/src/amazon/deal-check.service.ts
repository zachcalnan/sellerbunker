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
  composeDealCheckFees,
  marketplaceUsesDigitalServiceFee,
} from './deal-check-fees.util';
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
  referralFeeAtGood: number | null;
  fbaFeeAtGood: number | null;
  digitalServiceFeeAtGood: number | null;
  feesIncludeVat: boolean;
  feeSource:
    | 'product_fees_api'
    | 'stored_scaled'
    | 'heuristic'
    | null;
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
    let referralFeeAtGood: number | null = null;
    let fbaFeeAtGood: number | null = null;
    let digitalServiceFeeAtGood: number | null = null;
    let feesIncludeVat = false;
    let feeSource: DealCheckResult['feeSource'] = null;
    let usedFeeFallback = false;

    const vatMeta = await this.resolveDealCheckVatMeta(orgId);

    if (good != null) {
      const feeLive = await this.amazonService.estimateFbaFeesForAsinAtPrice(
        orgId,
        {
          asin,
          marketplaceId,
          listingPrice: good,
          currency,
        },
      );
      if (feeLive != null && feeLive.total > 0) {
        feesAtGood = feeLive.total;
        referralFeeAtGood = feeLive.referralFee;
        fbaFeeAtGood = feeLive.fbaFee;
        digitalServiceFeeAtGood = feeLive.digitalServiceFee;
        feesIncludeVat = feeLive.feesIncludeVat;
        feeSource = 'product_fees_api';
      } else {
        const scaled = await this.scaleStoredFees(
          orgId,
          asin,
          good,
          marketplaceId,
          vatMeta,
        );
        if (scaled != null) {
          feesAtGood = scaled.fees;
          referralFeeAtGood = scaled.referralFee;
          fbaFeeAtGood = scaled.fbaFee;
          digitalServiceFeeAtGood = scaled.digitalServiceFee;
          feesIncludeVat = scaled.feesIncludeVat;
          feeSource = 'stored_scaled';
          usedFeeFallback = scaled.fallback;
        } else {
          usedFeeFallback = true;
          feeSource = 'heuristic';
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

    const feeNote =
      feeSource === 'product_fees_api'
        ? ` Fees from Amazon Product Fees estimate at good resale${
            feesIncludeVat ? ' (inc. UK VAT on fees)' : ' (ex-VAT)'
          }.`
        : feeSource === 'stored_scaled'
          ? ` Fees scaled from stored product fee estimate at good resale${
              feesIncludeVat ? ' (inc. UK VAT on fees)' : ''
            }.`
          : feeSource === 'heuristic'
            ? ' Fees are a coarse % fallback (Product Fees unavailable).'
            : '';

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
      referralFeeAtGood,
      fbaFeeAtGood,
      digitalServiceFeeAtGood,
      feesIncludeVat,
      feeSource,
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
      note: `Good resale = ~75th percentile of ${sourceLabel} over ${stats.lookbackDays}d (rounded).${decNote} Probability = share of days at/above that level. ROI gate ${Math.round(DEAL_CHECK_ROI_GATE * 100)}%.${feeNote}`,
    };
  }

  private async resolveDealCheckVatMeta(orgId: string): Promise<{
    includeFeeVat: boolean;
    vatRatePct: number;
  }> {
    try {
      const org = await (this.prisma as any).organization.findUnique({
        where: { id: orgId },
        select: {
          vatRegistrationType: true,
          vatEffectiveDate: true,
          vatRatePct: true,
        },
      });
      const vatRegistrationType =
        org?.vatRegistrationType ?? 'NON_VAT_REGISTERED';
      const vatEffectiveDate = org?.vatEffectiveDate
        ? (org.vatEffectiveDate as Date)
        : null;
      const vatRatePct =
        org?.vatRatePct != null && Number.isFinite(Number(org.vatRatePct))
          ? Number(org.vatRatePct)
          : 20;
      const now = new Date();
      let includeFeeVat = true;
      if (vatRegistrationType === 'NON_VAT_REGISTERED') {
        includeFeeVat = true;
      } else if (vatEffectiveDate != null && now < vatEffectiveDate) {
        includeFeeVat = true;
      } else {
        includeFeeVat = false;
      }
      return { includeFeeVat, vatRatePct };
    } catch {
      return { includeFeeVat: true, vatRatePct: 20 };
    }
  }

  private async scaleStoredFees(
    orgId: string,
    asin: string,
    targetPrice: number,
    marketplaceId: string,
    vatMeta: { includeFeeVat: boolean; vatRatePct: number },
  ): Promise<{
    fees: number;
    referralFee: number | null;
    fbaFee: number | null;
    digitalServiceFee: number | null;
    feesIncludeVat: boolean;
    fallback: boolean;
  } | null> {
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
        dsf != null && listed > 0 ? (dsf / listed) * targetPrice : null;
      const fbaFee = fba ?? 0;
      const composed = composeDealCheckFees({
        referralFee: scaledRef,
        fbaFee,
        digitalServiceFee: scaledDsf,
        totalFromApi: null,
        applyDigitalServiceFallback: marketplaceUsesDigitalServiceFee(
          marketplaceId,
        ),
        includeFeeVat: vatMeta.includeFeeVat,
        vatRatePct: vatMeta.vatRatePct,
      });
      if (!composed) return null;
      return {
        fees: composed.feesTotal,
        referralFee: composed.referralFee,
        fbaFee: composed.fbaFee,
        digitalServiceFee: composed.digitalServiceFee,
        feesIncludeVat: composed.feesIncludeVat,
        fallback: false,
      };
    }

    if (totalStored != null && listed != null && listed > 0) {
      const rate = totalStored / listed;
      const scaledTotal = rate * targetPrice;
      const composed = composeDealCheckFees({
        referralFee: null,
        fbaFee: null,
        digitalServiceFee: null,
        totalFromApi: scaledTotal,
        applyDigitalServiceFallback: false,
        includeFeeVat: vatMeta.includeFeeVat,
        vatRatePct: vatMeta.vatRatePct,
      });
      if (!composed) return null;
      return {
        fees: composed.feesTotal,
        referralFee: null,
        fbaFee: null,
        digitalServiceFee: null,
        feesIncludeVat: composed.feesIncludeVat,
        fallback: true,
      };
    }

    this.logger.debug(`No stored fees to scale for ASIN ${asin}`);
    return null;
  }
}
