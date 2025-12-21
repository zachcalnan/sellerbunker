import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import * as crypto from 'crypto';

type SpApiRegion = 'na' | 'eu' | 'fe';

/**
 * Thin wrapper around the Amazon Selling Partner API.
 *
 * This class is wired for the **sandbox** endpoints by default.
 * You will plug in real auth + signing later (LWA + AWS SigV4 or an official SDK).
 */
@Injectable()
export class AmazonSpApiClient {
  private readonly region: SpApiRegion;
  private readonly endpoint: string;

  private readonly lwaClientId: string;
  private readonly lwaClientSecret: string;
  private readonly refreshToken: string;

  private readonly awsAccessKeyId: string;
  private readonly awsSecretAccessKey: string;
  private readonly awsRoleArn?: string;

  private cachedAccessToken: string | null = null;
  private cachedAccessTokenExpiresAt = 0;

  constructor(private readonly configService: ConfigService) {
    this.region = (this.configService.get<SpApiRegion>('SPAPI_REGION') ??
      'na') as SpApiRegion;

    // Default to NA sandbox. Override with SPAPI_SANDBOX_ENDPOINT if needed.
    this.endpoint =
      this.configService.get<string>('SPAPI_SANDBOX_ENDPOINT') ??
      'https://sandbox.sellingpartnerapi-na.amazon.com';

    this.lwaClientId = this.configService.get<string>('LWA_CLIENT_ID') ?? '';
    this.lwaClientSecret =
      this.configService.get<string>('LWA_CLIENT_SECRET') ?? '';
    this.refreshToken =
      this.configService.get<string>('SPAPI_REFRESH_TOKEN') ?? '';

    this.awsAccessKeyId =
      this.configService.get<string>('AWS_ACCESS_KEY_ID') ?? '';
    this.awsSecretAccessKey =
      this.configService.get<string>('AWS_SECRET_ACCESS_KEY') ?? '';
    this.awsRoleArn = this.configService.get<string>('AWS_ROLE_ARN') ?? '';

    // Debug log (masked) to verify env wiring – safe to remove later.
    // eslint-disable-next-line no-console
    console.log('[SPAPI CONFIG]', {
      region: this.region,
      lwaClientId: this.lwaClientId ? `${this.lwaClientId.slice(0, 8)}...` : '',
      refreshToken: this.refreshToken
        ? `${this.refreshToken.slice(0, 8)}...`
        : '',
      awsAccessKeyId: this.awsAccessKeyId
        ? `${this.awsAccessKeyId.slice(0, 4)}...`
        : '',
    });
  }

  /**
   * Example wrapper for the Sellers API: getMarketplaceParticipations.
   */
  async getMarketplaceParticipations() {
    return this.signedSpApiRequest({
      method: 'GET',
      path: '/sellers/v1/marketplaceParticipations',
      query: {},
    });
  }

  /**
   * Example wrapper around Orders API getOrders.
   *
   * NOTE: This is a placeholder. To call the real SP-API, you should
   * integrate an official or generated SDK (for example the one shown
   * in the docs snippet you pasted) and move that code into this method.
   */
  async getOrders(params?: {
    createdAfter?: string;
    createdBefore?: string;
    marketplaceIds?: string[];
    orderStatuses?: string[];
  }) {
    const {
      createdAfter,
      createdBefore,
      marketplaceIds = ['ATVPDKIKX0DER'], // US marketplace by default
      orderStatuses,
    } = params ?? {};

    // For the static sandbox, CreatedAfter and MarketplaceIds must match
    // the documented test case or you'll get InvalidInput.
    const isSandbox = true; // this client always uses sandbox host for now

    const query: Record<string, unknown> = {};

    if (isSandbox) {
      query.CreatedAfter = 'TEST_CASE_200';
      query.MarketplaceIds = ['ATVPDKIKX0DER'];
    } else {
      const now = new Date();
      const thirtyDaysAgo = new Date(
        now.getTime() - 30 * 24 * 60 * 60 * 1000,
      );

      const createdAfterIso =
        createdAfter ?? thirtyDaysAgo.toISOString().split('.')[0] + 'Z';

      query.CreatedAfter = createdAfterIso;
      if (createdBefore) {
        query.CreatedBefore = createdBefore;
      }
      query.MarketplaceIds = marketplaceIds;
      if (orderStatuses) {
        query.OrderStatuses = orderStatuses;
      }
    }

    return this.signedSpApiRequest({
      method: 'GET',
      path: '/orders/v0/orders',
      query,
    });
  }

  private async getLwaAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedAccessToken && now < this.cachedAccessTokenExpiresAt) {
      return this.cachedAccessToken;
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.lwaClientId,
      client_secret: this.lwaClientSecret,
    }).toString();

    const response = await this.httpRequest({
      hostname: 'api.amazon.com',
      path: '/auth/o2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body).toString(),
      },
      body,
    });

    if (response.statusCode !== 200) {
      throw new Error(
        `LWA token request failed: ${response.statusCode} ${response.body}`,
      );
    }

    const data = JSON.parse(response.body) as {
      access_token: string;
      expires_in: number;
    };

    this.cachedAccessToken = data.access_token;
    // Subtract 60s as a safety margin
    this.cachedAccessTokenExpiresAt = now + (data.expires_in - 60) * 1000;

    return this.cachedAccessToken;
  }

  private async signedSpApiRequest(options: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    query?: Record<string, unknown>;
    body?: string;
  }): Promise<unknown> {
    const accessToken = await this.getLwaAccessToken();

    const host = 'sandbox.sellingpartnerapi-na.amazon.com';
    const region = this.mapRegionToAwsRegion(this.region);
    const service = 'execute-api';

    const queryString = this.buildQueryString(options.query ?? {});
    const canonicalUri = options.path;
    const canonicalQuerystring = queryString;

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const payload = options.body ?? '';
    const payloadHash = crypto
      .createHash('sha256')
      .update(payload, 'utf8')
      .digest('hex');

    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-access-token:${accessToken}\n` +
      `x-amz-date:${amzDate}\n`;

    const signedHeaders = 'host;x-amz-access-token;x-amz-date';

    const canonicalRequest = [
      options.method,
      canonicalUri,
      canonicalQuerystring,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      crypto
        .createHash('sha256')
        .update(canonicalRequest, 'utf8')
        .digest('hex'),
    ].join('\n');

    const signingKey = this.getSignatureKey(
      this.awsSecretAccessKey,
      dateStamp,
      region,
      service,
    );

    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(stringToSign, 'utf8')
      .digest('hex');

    const authorizationHeader =
      `${algorithm} Credential=${this.awsAccessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const pathWithQuery = canonicalQuerystring
      ? `${canonicalUri}?${canonicalQuerystring}`
      : canonicalUri;

    const response = await this.httpRequest({
      hostname: host,
      path: pathWithQuery,
      method: options.method,
      headers: {
        host,
        'x-amz-access-token': accessToken,
        'x-amz-date': amzDate,
        Authorization: authorizationHeader,
      },
      body: payload,
    });

    if (!response.body) {
      return null;
    }

    try {
      return JSON.parse(response.body);
    } catch {
      return response.body;
    }
  }

  private buildQueryString(query: Record<string, unknown>): string {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      if (Array.isArray(value)) {
        value.forEach((v) => params.append(key, String(v)));
      } else {
        params.append(key, String(value));
      }
    });
    return params.toString();
  }

  private getSignatureKey(
    secret: string,
    date: string,
    region: string,
    service: string,
  ): Buffer {
    const kDate = crypto
      .createHmac('sha256', `AWS4${secret}`)
      .update(date, 'utf8')
      .digest();
    const kRegion = crypto
      .createHmac('sha256', kDate)
      .update(region, 'utf8')
      .digest();
    const kService = crypto
      .createHmac('sha256', kRegion)
      .update(service, 'utf8')
      .digest();
    const kSigning = crypto
      .createHmac('sha256', kService)
      .update('aws4_request', 'utf8')
      .digest();
    return kSigning;
  }

  private mapRegionToAwsRegion(region: SpApiRegion): string {
    switch (region) {
      case 'na':
        return 'us-east-1';
      case 'eu':
        return 'eu-west-1';
      case 'fe':
        return 'us-west-2';
      default:
        return 'us-east-1';
    }
  }

  private httpRequest(options: {
    hostname: string;
    path: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ statusCode: number; body: string }> {
    const { hostname, path, method, headers, body } = options;

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname,
          path,
          method,
          headers: {
            ...(headers ?? {}),
            ...(body
              ? { 'Content-Length': Buffer.byteLength(body).toString() }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk as Buffer));
          res.on('end', () => {
            const responseBody = Buffer.concat(chunks).toString('utf8');
            resolve({
              statusCode: res.statusCode ?? 0,
              body: responseBody,
            });
          });
        },
      );

      req.on('error', (err) => reject(err));

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }
}


