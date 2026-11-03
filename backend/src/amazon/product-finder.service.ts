import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AmazonService } from './amazon.service';
import { ProductFinderSearchDto } from './dto/product-finder-search.dto';
import {
  buildFinderConfidence,
  computeFinderEconomics,
  passesFinderGates,
  scoreTitleSimilarity,
  tokenizeFinderText,
} from './product-finder.util';

const UK = 'A1F83G8C2ARO7P';
const SAS = (term: string) =>
  `https://sas.selleramp.com/sas/lookup?search_term=${encodeURIComponent(term)}`;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

@Injectable()
export class ProductFinderService {
  private readonly logger = new Logger(ProductFinderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly amazonService: AmazonService,
  ) {}

  async search(orgId: string, userId: string, dto: ProductFinderSearchDto) {
    const seedRaw = dto.seed.trim();
    const take = Math.max(1, Math.min(50, Number(dto.take) || 20));
    const minProfit = Number.isFinite(dto.minProfitPerUnit)
      ? Number(dto.minProfitPerUnit)
      : 5;
    const minRoi = Number.isFinite(dto.minRoi) ? Number(dto.minRoi) : 0.2;
    const requireUngated = dto.requireUngated !== false;
    const maxBuyPrice =
      dto.maxBuyPrice != null && Number.isFinite(dto.maxBuyPrice)
        ? Number(dto.maxBuyPrice)
        : null;
    const includeAi = dto.includeAiSummary === true;
    const seedAsin = /^[A-Z0-9]{10}$/i.test(seedRaw)
      ? seedRaw.toUpperCase()
      : null;

    const userIds = await this.resolveOrgUserIds(orgId);
    if (userIds.length === 0) {
      return {
        seed: {
          query: seedRaw,
          resolvedAsin: seedAsin,
          resolvedTitle: seedRaw,
          resolvedSku: null,
          inCatalog: false,
        },
        assumptions: {
          maxBuyPrice,
          minProfitPerUnit: minProfit,
          minRoi,
          requireUngated,
          feeFallbackRateIfMissing: 0.35,
          dataScope:
            'Your Amazon listings + order history + stored fee estimates + selling-eligibility.',
        },
        results: [],
        aiSummary: null,
        meta: {
          catalogScanned: 0,
          similarConsidered: 0,
          returned: 0,
          openaiUsed: false,
          note: 'No Amazon-linked org members found.',
        },
      };
    }

    const products = await this.prisma.product.findMany({
      where: {
        userId: { in: userIds },
        sku: { notIn: ['AMAZON_GENERIC', 'AMAZON_MULTI'] },
      },
      select: {
        id: true,
        userId: true,
        sku: true,
        asin: true,
        title: true,
        imageUrl: true,
        displayGroup: true,
        productType: true,
        costOfGoods: true,
        currentListedPrice: true,
        estimatedReferralFeePerUnit: true,
        estimatedFbaFeePerUnit: true,
        estimatedDigitalServiceFeePerUnit: true,
        estimatedAmazonFeePerUnit: true,
      },
      take: 2500,
    });

    const byAsin = seedAsin
      ? products.find((p) => (p.asin ?? '').toUpperCase() === seedAsin)
      : undefined;
    const byTitle = products
      .map((p) => ({
        p,
        s: scoreTitleSimilarity(seedRaw, p.title ?? p.sku),
      }))
      .sort((a, b) => b.s - a.s)[0];
    const seedProduct =
      byAsin ?? (byTitle && byTitle.s >= 8 ? byTitle.p : undefined) ?? null;

    const seedTitle =
      seedProduct?.title?.trim() ||
      seedRaw.replace(/^[A-Z0-9]{10}$/i, '').trim() ||
      seedRaw;
    const seedDisplayGroup = seedProduct?.displayGroup ?? null;

    const eligibilityRows = await this.prisma.asinSellingEligibility.findMany({
      where: { userId: { in: userIds }, marketplaceId: UK },
      select: {
        asin: true,
        canRestock: true,
        checkedAt: true,
        notes: true,
      },
    });
    const eligibilityByAsin = new Map(
      eligibilityRows.map((r) => [r.asin.toUpperCase(), r]),
    );

    const productIds = products.map((p) => p.id);
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const since90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const [sales30, sales90, latestPurchases] = await Promise.all([
      productIds.length
        ? (this.prisma as any).orderItem.groupBy({
            by: ['productId'],
            where: {
              userId: { in: userIds },
              productId: { in: productIds },
              orderDate: { gte: since30 },
            },
            _sum: { quantity: true, profit: true, revenueTotal: true },
          })
        : Promise.resolve([]),
      productIds.length
        ? (this.prisma as any).orderItem.groupBy({
            by: ['productId'],
            where: {
              userId: { in: userIds },
              productId: { in: productIds },
              orderDate: { gte: since90 },
            },
            _sum: { quantity: true, profit: true },
          })
        : Promise.resolve([]),
      productIds.length
        ? this.prisma.purchase.findMany({
            where: { productId: { in: productIds }, userId: { in: userIds } },
            orderBy: { purchaseDate: 'desc' },
            distinct: ['productId'],
            select: {
              productId: true,
              unitCostIncVat: true,
              supplier: true,
              supplierLink: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const sales30ById = new Map<string, any>(
      (sales30 as any[]).map((r) => [r.productId, r]),
    );
    const sales90ById = new Map<string, any>(
      (sales90 as any[]).map((r) => [r.productId, r]),
    );
    const purchaseById = new Map(
      (latestPurchases as any[]).map((r) => [r.productId, r]),
    );

    type Scored = {
      similarScore: number;
      row: (typeof products)[0];
    };
    const scored: Scored[] = [];
    for (const p of products) {
      if (seedProduct && p.id === seedProduct.id) continue;
      let similar = scoreTitleSimilarity(seedTitle, p.title ?? '');
      if (
        seedDisplayGroup &&
        p.displayGroup &&
        p.displayGroup === seedDisplayGroup
      ) {
        similar += 8;
      }
      // Also allow keyword-only seeds to match SKU/ASIN loosely
      if (similar < 8) {
        const tokens = tokenizeFinderText(seedRaw);
        const hay = `${p.title ?? ''} ${p.sku} ${p.asin ?? ''}`.toLowerCase();
        const hit = tokens.filter((t) => hay.includes(t)).length;
        if (hit >= 2) similar = Math.max(similar, hit * 4);
      }
      if (similar < 8) continue;
      scored.push({ similarScore: similar, row: p });
    }
    scored.sort((a, b) => b.similarScore - a.similarScore);

    const results: Array<Record<string, unknown>> = [];
    for (const { similarScore, row } of scored) {
      const asin = row.asin?.toUpperCase() ?? null;
      const elig = asin ? eligibilityByAsin.get(asin) : undefined;
      const ungated = elig ? elig.canRestock : null;
      const eligibilityAgeHours = elig
        ? (Date.now() - elig.checkedAt.getTime()) / 3600000
        : null;

      const fees = this.amazonService.repricerAmazonFeePerUnitFromProduct(row);
      const listed = num(row.currentListedPrice);
      const s30 = sales30ById.get(row.id);
      const s90 = sales90ById.get(row.id);
      const units30 = Number(s30?._sum?.quantity ?? 0) || 0;
      const units90 = Number(s90?._sum?.quantity ?? 0) || 0;
      const profit30 = num(s30?._sum?.profit);
      const qty30 = units30 > 0 ? units30 : null;
      const historicalAvgProfit =
        profit30 != null && qty30 ? profit30 / qty30 : null;

      const purchase = purchaseById.get(row.id);
      const lastBuy = num(purchase?.unitCostIncVat);
      const cogsFallback = num(row.costOfGoods);
      const buyPrice = maxBuyPrice ?? lastBuy ?? cogsFallback;

      // Resale: prefer live list price, else avg revenue/unit from 30d
      const rev30 = num(s30?._sum?.revenueTotal);
      const avgSell =
        rev30 != null && units30 > 0 ? rev30 / units30 : null;
      const resalePrice = listed ?? avgSell;

      const economics = computeFinderEconomics({
        resalePrice,
        feesPerUnit: fees,
        buyPrice,
      });

      const meets = passesFinderGates({
        requireUngated,
        ungated,
        minProfitPerUnit: minProfit,
        minRoi,
        profitPerUnit: economics.profitPerUnit,
        roi: economics.roi,
      });

      // Keep near-misses if similar & ungated but show gate fail — still useful.
      // Primary list: passes gates OR (ungated unknown and profitable on paper).
      if (!meets && requireUngated && ungated === false) continue;
      if (
        !meets &&
        (economics.profitPerUnit == null ||
          economics.profitPerUnit < minProfit * 0.5)
      ) {
        continue;
      }

      const confidence = buildFinderConfidence({
        similarScore,
        ungated,
        eligibilityAgeHours,
        hasFeeEstimate: fees != null && fees > 0,
        usedFeeFallback: economics.usedFeeFallback,
        hasBuyPrice: buyPrice != null,
        unitsSold30d: units30,
        unitsSold90d: units90,
        historicalAvgProfit,
        meetsProfitGate: meets,
      });

      results.push({
        productId: row.id,
        sku: row.sku,
        asin,
        title: row.title,
        imageUrl: row.imageUrl,
        similarScore,
        whySimilar:
          similarScore >= 20
            ? 'Close title / category match to your seed'
            : 'Partial title or category overlap',
        ungated,
        eligibilityCheckedAt: elig?.checkedAt?.toISOString() ?? null,
        eligibilityNotes: elig?.notes ?? null,
        resalePrice: economics.resalePrice,
        estimatedFeesPerUnit: economics.feesPerUnit,
        buyPrice: economics.buyPrice,
        buyPriceSource: maxBuyPrice
          ? 'deal_input'
          : lastBuy != null
            ? 'last_purchase'
            : cogsFallback != null
              ? 'product_cogs'
              : null,
        profitPerUnit: economics.profitPerUnit,
        roi: economics.roi,
        meetsProfitGate: meets,
        unitsSold30d: units30,
        unitsSold90d: units90,
        historicalAvgProfitPerUnit:
          historicalAvgProfit != null
            ? Math.round(historicalAvgProfit * 100) / 100
            : null,
        supplier: purchase?.supplier ?? null,
        supplierLink: purchase?.supplierLink ?? null,
        confidence,
        sasUrl: asin ? SAS(asin) : SAS(row.title ?? row.sku),
      });

      if (results.length >= take * 3) break; // gather then re-sort
    }

    results.sort((a, b) => {
      const ca = (a.confidence as { score: number }).score;
      const cb = (b.confidence as { score: number }).score;
      const pa = Number(a.profitPerUnit ?? -999);
      const pb = Number(b.profitPerUnit ?? -999);
      if (cb !== ca) return cb - ca;
      return pb - pa;
    });

    const trimmed = results.slice(0, take);

    let aiSummary: string | null = null;
    if (includeAi && trimmed.length > 0) {
      aiSummary = await this.optionalAiSummary(seedTitle, trimmed.slice(0, 5));
    }

    return {
      seed: {
        query: seedRaw,
        resolvedAsin: seedProduct?.asin ?? seedAsin,
        resolvedTitle: seedProduct?.title ?? seedTitle,
        resolvedSku: seedProduct?.sku ?? null,
        inCatalog: Boolean(seedProduct),
      },
      assumptions: {
        maxBuyPrice,
        minProfitPerUnit: minProfit,
        minRoi,
        requireUngated,
        feeFallbackRateIfMissing: 0.35,
        dataScope:
          'Your Amazon listings + order history + stored fee estimates + selling-eligibility. No Keepa / no Amazon-wide similar API (avoids inventing ASINs and heavy rate spend).',
      },
      results: trimmed,
      aiSummary,
      meta: {
        catalogScanned: products.length,
        similarConsidered: scored.length,
        returned: trimmed.length,
        openaiUsed: Boolean(aiSummary),
        note: 'Tip: leave AI summary off (default). Use Open in SAS on a row for deeper external research.',
      },
    };
  }

  private async resolveOrgUserIds(orgId: string): Promise<string[]> {
    const members = await this.prisma.organizationMembership.findMany({
      where: { orgId },
      select: { userId: true },
    });
    return [...new Set(members.map((m) => m.userId))];
  }

  private async optionalAiSummary(
    seedTitle: string,
    top: Array<Record<string, unknown>>,
  ): Promise<string | null> {
    const apiKey = (process.env.OPENAI_API_KEY ?? '').trim();
    if (!apiKey) return null;
    const model =
      (process.env.OPENAI_PRODUCT_FINDER_MODEL ?? '').trim() || 'gpt-4o-mini';
    const compact = top.map((r) => ({
      title: r.title,
      asin: r.asin,
      ungated: r.ungated,
      profitPerUnit: r.profitPerUnit,
      roi: r.roi,
      unitsSold30d: r.unitsSold30d,
      confidence: (r.confidence as { level: string; score: number })?.level,
      whySimilar: r.whySimilar,
    }));
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 350,
          messages: [
            {
              role: 'system',
              content:
                'You help an Amazon UK wholesale/arbitrage seller. Summarise which of these OWNED catalog candidates look most winnable vs the seed. Do not invent ASINs or external products. Be concise (max 6 bullets).',
            },
            {
              role: 'user',
              content: `Seed: ${seedTitle}\nCandidates JSON:\n${JSON.stringify(compact)}`,
            },
          ],
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Product finder AI summary failed: ${res.status}`);
        return null;
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return body.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
      this.logger.warn(
        `Product finder AI summary error: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
  }
}
