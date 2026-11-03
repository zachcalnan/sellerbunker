import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  ExtractedPurchaseDraft,
  PURCHASE_SCREENSHOT_SYSTEM_PROMPT,
  parseVisionPurchaseJson,
} from './purchase-screenshot-extract.util';
import {
  DbProductHint,
  enrichDraftWithCatalogAndDb,
} from './purchase-screenshot-enrich.util';
import { SUPPLIER_CATALOG } from './supplier-product-catalog';

const DEFAULT_MODEL = 'gpt-4o';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Keep listing hints small — each call billed on prompt tokens. */
const MAX_LISTING_HINTS = 30;
/** Default daily AI extracts per org (override with PURCHASE_VISION_DAILY_LIMIT). */
const DEFAULT_DAILY_LIMIT = 20;

@Injectable()
export class PurchaseScreenshotExtractService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async extractFromImage(input: {
    imageBase64: string;
    mimeType?: string;
    hint?: string;
    orgId?: string;
  }): Promise<{
    draft: ExtractedPurchaseDraft;
    model: string;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      approxCostUsd?: number;
    };
    quota?: { used: number; limit: number; remaining: number };
  }> {
    const apiKey = (process.env.OPENAI_API_KEY ?? '').trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'OPENAI_API_KEY is not configured on the server',
      );
    }

    // Reserve a daily slot before calling OpenAI (refunded if the call fails).
    const reserved = await this.reserveDailyQuota(input.orgId);

    const { base64, mimeType } = this.normalizeImage(
      input.imageBase64,
      input.mimeType,
    );
    const approxBytes = Math.floor((base64.length * 3) / 4);
    if (approxBytes > MAX_IMAGE_BYTES) {
      await this.releaseDailyQuota(input.orgId);
      throw new BadRequestException(
        'Image is too large (max ~4MB after compression). Try a smaller screenshot.',
      );
    }

    const model = (process.env.OPENAI_VISION_MODEL ?? '').trim() || DEFAULT_MODEL;
    // `low` is ~85 image tokens; `high` can be 700–1500+. Default low to control spend.
    const detailRaw = (process.env.OPENAI_VISION_DETAIL ?? 'low')
      .trim()
      .toLowerCase();
    const detail: 'low' | 'high' | 'auto' =
      detailRaw === 'high' || detailRaw === 'auto' ? detailRaw : 'low';

    const dbProducts = await this.loadOrgProducts(input.orgId);
    const listingHints = this.formatListingHints(dbProducts);
    // Keep catalog short — only a few hard-coded fallbacks.
    const catalogHint = SUPPLIER_CATALOG.slice(0, 12)
      .map(
        (p) =>
          `${p.supplierLabel}: "${p.title.slice(0, 50)}" ASIN ${p.asin}`,
      )
      .join('\n');

    const userText = [
      'Extract the purchase order fields from this screenshot.',
      'Mobile confirmations often show only a thumbnail + qty badge — still fill lines[] from packaging text and the badge.',
      'Parse quantities like "10x Product" or "Landmark (8 items)" into qty.',
      'Identify the retailer from the domain/logo/app chrome.',
      input.hint?.trim() ? `Hint: ${input.hint.trim().slice(0, 200)}` : null,
      listingHints
        ? [
            'Your Amazon listings (match closest; set asin when confident):',
            listingHints,
          ].join('\n')
        : null,
      'Supplier fallbacks (only if no listing match):',
      catalogHint,
    ]
      .filter(Boolean)
      .join('\n');

    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 1200,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: PURCHASE_SCREENSHOT_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: userText },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${base64}`,
                    detail,
                  },
                },
              ],
            },
          ],
        }),
      });
    } catch (e: unknown) {
      await this.releaseDailyQuota(input.orgId);
      const msg = e instanceof Error ? e.message : String(e);
      throw new ServiceUnavailableException(`OpenAI request failed: ${msg}`);
    }

    const bodyText = await response.text();
    if (!response.ok) {
      await this.releaseDailyQuota(input.orgId);
      throw new ServiceUnavailableException(
        this.formatOpenAiHttpError(response.status, bodyText),
      );
    }

    let payload: {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      payload = JSON.parse(bodyText) as typeof payload;
    } catch {
      await this.releaseDailyQuota(input.orgId);
      throw new ServiceUnavailableException('OpenAI returned invalid JSON');
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content?.trim()) {
      await this.releaseDailyQuota(input.orgId);
      throw new BadRequestException('Model returned empty content');
    }

    let draft: ExtractedPurchaseDraft;
    try {
      draft = enrichDraftWithCatalogAndDb(
        parseVisionPurchaseJson(content),
        dbProducts,
      );
    } catch (e: unknown) {
      await this.releaseDailyQuota(input.orgId);
      throw e;
    }

    const promptTokens = payload.usage?.prompt_tokens;
    const completionTokens = payload.usage?.completion_tokens;
    // gpt-4o list prices (approx): $2.50 / 1M in, $10 / 1M out
    const approxCostUsd =
      promptTokens != null && completionTokens != null
        ? Number(
            (
              (promptTokens / 1_000_000) * 2.5 +
              (completionTokens / 1_000_000) * 10
            ).toFixed(4),
          )
        : undefined;

    return {
      draft,
      model: `${model} (detail=${detail})`,
      usage: {
        promptTokens,
        completionTokens,
        approxCostUsd,
      },
      quota: reserved,
    };
  }

  /** Current UTC-day quota for Purchases UI (does not increment). */
  async getDailyQuota(orgId?: string): Promise<{
    used: number;
    limit: number;
    remaining: number;
  }> {
    return this.readDailyQuota(orgId);
  }

  private dailyLimit(): number {
    const n = Number(process.env.PURCHASE_VISION_DAILY_LIMIT ?? DEFAULT_DAILY_LIMIT);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAILY_LIMIT;
    return Math.floor(n);
  }

  private quotaKey(orgId: string): string {
    const day = new Date().toISOString().slice(0, 10);
    return `purchase-vision:${orgId}:${day}`;
  }

  private async readDailyQuota(orgId?: string): Promise<{
    used: number;
    limit: number;
    remaining: number;
  }> {
    const limit = this.dailyLimit();
    if (!orgId?.trim()) {
      return { used: 0, limit, remaining: limit };
    }
    const raw = await this.redis.get(this.quotaKey(orgId.trim()));
    const used = Math.max(0, Number(raw ?? 0) || 0);
    return { used, limit, remaining: Math.max(0, limit - used) };
  }

  /**
   * Atomically reserve one extract for today. Throws 429 when over the cap.
   * Call releaseDailyQuota if OpenAI fails so the slot is refunded.
   */
  private async reserveDailyQuota(orgId?: string): Promise<{
    used: number;
    limit: number;
    remaining: number;
  }> {
    const limit = this.dailyLimit();
    if (!orgId?.trim()) {
      return { used: 0, limit, remaining: limit };
    }
    const key = this.quotaKey(orgId.trim());
    const client = this.redis.getClient();
    const used = await client.incr(key);
    if (used === 1) {
      await client.expire(key, 60 * 60 * 36);
    }
    if (used > limit) {
      await client.decr(key);
      throw new HttpException(
        {
          message: `Daily screenshot AI limit reached (${limit}/day). Enter the purchase manually, or try again tomorrow.`,
          quota: { used: limit, limit, remaining: 0 },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return { used, limit, remaining: Math.max(0, limit - used) };
  }

  private async releaseDailyQuota(orgId?: string): Promise<void> {
    if (!orgId?.trim()) return;
    try {
      const client = this.redis.getClient();
      const key = this.quotaKey(orgId.trim());
      const next = await client.decr(key);
      if (next < 0) await client.set(key, '0', 'EX', 60 * 60 * 36);
    } catch {
      // Best-effort refund; don't mask the original extract error.
    }
  }

  /**
   * Prefer titled products; put likely in-stock / recently useful titles first
   * by keeping stable order from DB (caller can extend with inventory join later).
   */
  private formatListingHints(products: DbProductHint[]): string | null {
    const withTitle = products.filter(
      (p) => p.asin && (p.title ?? '').trim().length >= 4,
    );
    if (withTitle.length === 0) return null;

    const seen = new Set<string>();
    const lines: string[] = [];
    for (const p of withTitle) {
      const asin = (p.asin ?? '').toUpperCase();
      if (!asin || seen.has(asin)) continue;
      seen.add(asin);
      const title = (p.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 55);
      lines.push(`- ${asin} | ${p.sku} | ${title}`);
      if (lines.length >= MAX_LISTING_HINTS) break;
    }
    return lines.length ? lines.join('\n') : null;
  }

  private async loadOrgProducts(orgId?: string): Promise<DbProductHint[]> {
    if (!orgId?.trim()) return [];
    const members = await this.prisma.organizationMembership.findMany({
      where: { orgId: orgId.trim() },
      select: { userId: true },
    });
    const userIds = members.map((m) => m.userId);
    if (userIds.length === 0) return [];

    // Prefer products that currently have FBA stock (new purchases often restock these).
    const withStock = await this.prisma.product.findMany({
      where: {
        userId: { in: userIds },
        asin: { not: null },
        title: { not: null },
        inventory: { is: { availableQty: { gt: 0 } } },
      },
      select: { asin: true, sku: true, title: true, imageUrl: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_LISTING_HINTS,
    });

    if (withStock.length >= Math.min(40, MAX_LISTING_HINTS)) {
      return withStock;
    }

    const stockAsins = withStock
      .map((p) => p.asin)
      .filter((a): a is string => Boolean(a));

    const rest = await this.prisma.product.findMany({
      where: {
        userId: { in: userIds },
        asin: { not: null },
        title: { not: null },
        ...(stockAsins.length ? { NOT: { asin: { in: stockAsins } } } : {}),
      },
      select: { asin: true, sku: true, title: true, imageUrl: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_LISTING_HINTS - withStock.length,
    });

    return [...withStock, ...rest];
  }

  private formatOpenAiHttpError(status: number, bodyText: string): string {
    const snippet = bodyText.slice(0, 800);
    const lower = snippet.toLowerCase();
    if (
      lower.includes('credit_balance_exhausted') ||
      lower.includes('insufficient_quota') ||
      lower.includes('no credits remaining')
    ) {
      return 'OpenAI has no credits remaining. Top up billing at platform.openai.com, or enter the purchase manually.';
    }
    if (status === 429) {
      return 'OpenAI rate limit exceeded. Wait a moment and retry, or enter the purchase manually.';
    }
    if (status === 401 || status === 403) {
      return 'OpenAI API key was rejected. Check OPENAI_API_KEY on the server.';
    }
    return `OpenAI error ${status}: ${snippet.slice(0, 400)}`;
  }

  private normalizeImage(
    raw: string,
    mimeHint?: string,
  ): { base64: string; mimeType: string } {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) {
      throw new BadRequestException('imageBase64 is required');
    }

    const dataUrl = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(trimmed);
    if (dataUrl) {
      return { mimeType: dataUrl[1].toLowerCase(), base64: dataUrl[2] };
    }

    const mimeType = (mimeHint ?? 'image/jpeg').toLowerCase();
    if (!mimeType.startsWith('image/')) {
      throw new BadRequestException('mimeType must be an image/* type');
    }
    return { base64: trimmed.replace(/\s/g, ''), mimeType };
  }
}
