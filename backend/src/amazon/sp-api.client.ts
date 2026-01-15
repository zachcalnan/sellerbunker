import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import * as crypto from 'crypto';

export type SpApiRegion = 'na' | 'eu' | 'fe';

export interface SpApiCredentials {
  region: SpApiRegion;
  lwaClientId: string;
  lwaClientSecret: string;
  refreshToken: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsRoleArn?: string;
}

/**
 * Thin wrapper around the Amazon Selling Partner API.
 *
 * This class is wired for the **sandbox** endpoints by default.
 * It now accepts per-request credentials so each seller can use
 * their own SP-API / AWS keys.
 */
@Injectable()
export class AmazonSpApiClient {
  private readonly useSandbox: boolean;

  constructor(private readonly configService: ConfigService) {
    // Default to sandbox unless explicitly disabled
    const flag = this.configService.get<string>('SPAPI_USE_SANDBOX');
    this.useSandbox = flag === undefined ? true : flag === 'true';
  }
  /**
   * Example wrapper for the Sellers API: getMarketplaceParticipations.
   */
  async getMarketplaceParticipations(credentials: SpApiCredentials) {
    return this.signedSpApiRequest(credentials, {
      method: 'GET',
      path: '/sellers/v1/marketplaceParticipations',
      query: {},
    });
  }

  /**
   * Example wrapper around Orders API getOrders.
   *
   * NOTE: This is a placeholder. To call the real SP-API, you should
   * integrate an official or generated SDK and move that code into this method.
   */
  async getOrders(
    credentials: SpApiCredentials,
    params?: {
      createdAfter?: string;
      createdBefore?: string;
      marketplaceIds?: string[];
      orderStatuses?: string[];
    },
  ) {
    const {
      createdAfter,
      createdBefore,
      marketplaceIds = ['ATVPDKIKX0DER'], // US marketplace by default
      orderStatuses,
    } = params ?? {};

    // For the static sandbox, CreatedAfter and MarketplaceIds must match
    // the documented test case or you'll get InvalidInput.
    const isSandbox = this.useSandbox;

    const query: Record<string, unknown> = {};

    if (isSandbox && !createdAfter && !createdBefore && !orderStatuses) {
      // Default sandbox test case if no explicit range is requested
      query.CreatedAfter = 'TEST_CASE_200';
      query.MarketplaceIds = ['ATVPDKIKX0DER'];
    } else {
      if (createdAfter) {
        query.CreatedAfter = createdAfter;
      }
      if (createdBefore) {
        query.CreatedBefore = createdBefore;
      }
      query.MarketplaceIds = marketplaceIds;
      if (orderStatuses) {
        query.OrderStatuses = orderStatuses;
      }
    }

    return this.signedSpApiRequest(credentials, {
      method: 'GET',
      path: '/orders/v0/orders',
      query,
    });
  }

  private async getLwaAccessToken(
    credentials: SpApiCredentials,
  ): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: credentials.lwaClientId,
      client_secret: credentials.lwaClientSecret,
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

    return data.access_token;
  }

  private async signedSpApiRequest(
    credentials: SpApiCredentials,
    options: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      path: string;
      query?: Record<string, unknown>;
      body?: string;
    },
  ): Promise<unknown> {
    const accessToken = await this.getLwaAccessToken(credentials);

    const host = this.getHostForRegion(credentials.region, this.useSandbox);
    const region = this.mapRegionToAwsRegion(credentials.region);
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
      credentials.awsSecretAccessKey,
      dateStamp,
      region,
      service,
    );

    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(stringToSign, 'utf8')
      .digest('hex');

    const authorizationHeader =
      `${algorithm} Credential=${credentials.awsAccessKeyId}/${credentialScope}, ` +
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

  private getSandboxHostForRegion(region: SpApiRegion): string {
    switch (region) {
      case 'na':
        return 'sandbox.sellingpartnerapi-na.amazon.com';
      case 'eu':
        return 'sandbox.sellingpartnerapi-eu.amazon.com';
      case 'fe':
        return 'sandbox.sellingpartnerapi-fe.amazon.com';
      default:
        return 'sandbox.sellingpartnerapi-na.amazon.com';
    }
  }

  private getProdHostForRegion(region: SpApiRegion): string {
    switch (region) {
      case 'na':
        return 'sellingpartnerapi-na.amazon.com';
      case 'eu':
        return 'sellingpartnerapi-eu.amazon.com';
      case 'fe':
        return 'sellingpartnerapi-fe.amazon.com';
      default:
        return 'sellingpartnerapi-na.amazon.com';
    }
  }

  private getHostForRegion(region: SpApiRegion, sandbox: boolean): string {
    return sandbox
      ? this.getSandboxHostForRegion(region)
      : this.getProdHostForRegion(region);
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

