import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type KeepaProductPayload = {
  asin?: string;
  title?: string;
  csv?: unknown;
  stats?: unknown;
  monthlySold?: number | null;
  domainId?: number;
};

export type KeepaProductResponse = {
  products?: KeepaProductPayload[];
  tokensLeft?: number;
  tokensConsumed?: number;
  refillIn?: number;
  refillRate?: number;
  error?: unknown;
};

@Injectable()
export class KeepaClient {
  private readonly logger = new Logger(KeepaClient.name);

  constructor(private readonly config: ConfigService) {}

  getApiKey(): string | null {
    const key = (this.config.get<string>('KEEPA_API_KEY') ?? process.env.KEEPA_API_KEY ?? '')
      .trim();
    return key || null;
  }

  isConfigured(): boolean {
    return this.getApiKey() != null;
  }

  /**
   * Cheap product history pull: 1 token/ASIN (no offers).
   * Uses marketplace NEW history; NEW_FBA only present if Keepa already has it cached.
   */
  async fetchProduct(opts: {
    asin: string;
    domainId: number;
    /** Limit history window (days). */
    days?: number;
    statsDays?: number;
  }): Promise<KeepaProductResponse> {
    const key = this.getApiKey();
    if (!key) {
      throw new ServiceUnavailableException(
        'Keepa is not configured. Set KEEPA_API_KEY in deploy/.env.personal',
      );
    }
    const asin = opts.asin.trim().toUpperCase();
    const days = Math.max(30, Math.min(365, opts.days ?? 180));
    const stats = Math.max(30, Math.min(365, opts.statsDays ?? days));
    const url = new URL('https://api.keepa.com/product');
    url.searchParams.set('key', key);
    url.searchParams.set('domain', String(opts.domainId));
    url.searchParams.set('asin', asin);
    url.searchParams.set('stats', String(stats));
    url.searchParams.set('history', '1');
    url.searchParams.set('days', String(days));
    // Prefer cached history — avoid forced refresh tokens for deal checks.
    url.searchParams.set('update', '24');

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    let body: KeepaProductResponse;
    try {
      body = JSON.parse(text) as KeepaProductResponse;
    } catch {
      this.logger.warn(`Keepa non-JSON response status=${res.status}`);
      throw new ServiceUnavailableException('Keepa returned an invalid response');
    }
    if (!res.ok) {
      this.logger.warn(`Keepa HTTP ${res.status}: ${text.slice(0, 200)}`);
      throw new ServiceUnavailableException(
        `Keepa request failed (${res.status})`,
      );
    }
    if (body.error != null) {
      this.logger.warn(`Keepa error: ${JSON.stringify(body.error).slice(0, 200)}`);
      throw new ServiceUnavailableException('Keepa API error');
    }
    return body;
  }
}
