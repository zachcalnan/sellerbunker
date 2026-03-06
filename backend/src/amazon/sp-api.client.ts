import { Injectable, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(AmazonSpApiClient.name);

  constructor(private readonly configService: ConfigService) {
    const flag = (this.configService.get<string>('SPAPI_USE_SANDBOX') ?? '').toLowerCase();
    this.useSandbox = ['1', 'true', 'yes'].includes(flag);
  }

  getDebugConfig() {
    return { useSandbox: this.useSandbox };
  }

  private isDebugEnabled(): boolean {
    const flag = (this.configService.get<string>('SPAPI_DEBUG_LOGS') ?? '').toLowerCase();
    return ['1', 'true', 'yes'].includes(flag);
  }

  private defaultMarketplaceIdsForRegion(region: SpApiRegion): string[] {
    switch (region) {
      case 'na':
        return ['ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2', 'A1AM78C64UM0Y8', 'A2Q3Y263D00KWC']; // US, CA, MX, BR
      case 'eu':
        return [
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
        ];
      case 'fe':
        return ['A1VC38T7YXB528', 'A19VAU5U5O7RUS', 'A39IBJ37TRP1C6']; // JP, SG, AU
      default:
        return ['ATVPDKIKX0DER'];
    }
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
      lastUpdatedAfter?: string;
      lastUpdatedBefore?: string;
      marketplaceIds?: string[];
      orderStatuses?: string[];
      nextToken?: string;
    },
  ) {
    const {
      createdAfter,
      createdBefore,
      lastUpdatedAfter,
      lastUpdatedBefore,
      orderStatuses,
      nextToken,
    } = params ?? {};

    const marketplaceIds =
      params?.marketplaceIds ?? this.defaultMarketplaceIdsForRegion(credentials.region);

    // For the static sandbox, CreatedAfter and MarketplaceIds must match
    // the documented test case or you'll get InvalidInput.
    const isSandbox = this.useSandbox;

    const query: Record<string, unknown> = {};

    if (nextToken) {
      query.NextToken = nextToken;
    } else {
      // Orders API: MarketplaceIds as comma-separated. For EU use UK-only.
      const ids = Array.isArray(marketplaceIds) ? marketplaceIds : [String(marketplaceIds ?? '')];
      const euUkOnly = credentials.region === 'eu' ? ['A1F83G8C2ARO7P'] : ids;
      const marketplaceIdsStr = euUkOnly.join(',');
      if (isSandbox && !createdAfter && !createdBefore && !orderStatuses) {
        query.CreatedAfter = 'TEST_CASE_200';
        query.MarketplaceIds = 'A1F83G8C2ARO7P';
      } else {
        if (lastUpdatedAfter) {
          query.LastUpdatedAfter = lastUpdatedAfter;
          if (lastUpdatedBefore) query.LastUpdatedBefore = lastUpdatedBefore;
        } else {
          if (createdAfter) query.CreatedAfter = createdAfter;
          if (createdBefore) query.CreatedBefore = createdBefore;
        }
        query.MarketplaceIds = marketplaceIdsStr;
        if (orderStatuses?.length) {
          query.OrderStatuses = orderStatuses;
        }
      }
    }

    return this.signedSpApiRequest(credentials, {
      method: 'GET',
      path: '/orders/v0/orders',
      query,
    });
  }

  /**
   * Orders API v0: getOrderItems
   * GET /orders/v0/orders/{orderId}/orderItems
   *
   * Used to fetch item-level prices, taxes, and shipping charges.
   */
  async getOrderItems(
    credentials: SpApiCredentials,
    orderId: string,
    params?: { nextToken?: string },
  ) {
    const query: Record<string, unknown> = {};
    if (params?.nextToken) {
      query.NextToken = params.nextToken;
    }
    return this.signedSpApiRequest(credentials, {
      method: 'GET',
      path: `/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`,
      query,
    });
  }

  /**
   * Finances API v0: listFinancialEventsByOrderId
   * GET /finances/v0/orders/{orderId}/financialEvents
   *
   * Used to fetch Amazon fee components (FBA/referral/etc) and tax-withholding info.
   */
  async listFinancialEventsByOrderId(
    credentials: SpApiCredentials,
    orderId: string,
    params?: { maxResultsPerPage?: number; nextToken?: string },
  ) {
    const query: Record<string, unknown> = {};
    if (params?.maxResultsPerPage) {
      query.MaxResultsPerPage = params.maxResultsPerPage;
    }
    if (params?.nextToken) {
      query.NextToken = params.nextToken;
    }
    return this.signedSpApiRequest(credentials, {
      method: 'GET',
      path: `/finances/v0/orders/${encodeURIComponent(orderId)}/financialEvents`,
      query,
    });
  }

  /**
   * Product Fees API v0: getMyFeesEstimateForSKU
   * POST /products/fees/v0/listings/{SellerSKU}/feesEstimate
   *
   * Returns estimated Amazon fees for a SKU (before sale). Used for inventory/order profit display
   * until actual fees settle from the Finances API.
   */
  async getMyFeesEstimateForSKU(
    credentials: SpApiCredentials,
    sellerSku: string,
    params: {
      marketplaceId: string;
      isAmazonFulfilled?: boolean;
      listingPriceAmount?: number;
      listingPriceCurrency?: string;
      identifier?: string;
    },
  ): Promise<unknown> {
    const {
      marketplaceId,
      isAmazonFulfilled = true,
      listingPriceAmount = 0,
      listingPriceCurrency = 'GBP',
      identifier = `fee-${sellerSku}-${Date.now()}`,
    } = params;
    const body = JSON.stringify({
      FeesEstimateRequest: {
        MarketplaceId: marketplaceId,
        IsAmazonFulfilled: isAmazonFulfilled,
        PriceToEstimateFees: {
          ListingPrice: {
            CurrencyCode: listingPriceCurrency,
            Amount: listingPriceAmount,
          },
          Shipping: {
            CurrencyCode: listingPriceCurrency,
            Amount: 0,
          },
        },
        Identifier: identifier,
        ...(isAmazonFulfilled ? { OptionalFulfillmentProgram: 'FBA_CORE' } : {}),
      },
    });
    return this.signedSpApiRequest(credentials, {
      method: 'POST',
      path: `/products/fees/v0/listings/${encodeURIComponent(sellerSku)}/feesEstimate`,
      body,
    });
  }

  /**
   * Product Fees API v0: getMyFeesEstimateForASIN
   * POST /products/fees/v0/items/{Asin}/feesEstimate
   */
  async getMyFeesEstimateForASIN(
    credentials: SpApiCredentials,
    asin: string,
    params: {
      marketplaceId: string;
      isAmazonFulfilled?: boolean;
      listingPriceAmount?: number;
      listingPriceCurrency?: string;
      identifier?: string;
    },
  ): Promise<unknown> {
    const {
      marketplaceId,
      isAmazonFulfilled = true,
      listingPriceAmount = 0,
      listingPriceCurrency = 'GBP',
      identifier = `fee-asin-${asin}-${Date.now()}`,
    } = params;
    const body = JSON.stringify({
      FeesEstimateRequest: {
        MarketplaceId: marketplaceId,
        IsAmazonFulfilled: isAmazonFulfilled,
        PriceToEstimateFees: {
          ListingPrice: {
            CurrencyCode: listingPriceCurrency,
            Amount: listingPriceAmount,
          },
          Shipping: {
            CurrencyCode: listingPriceCurrency,
            Amount: 0,
          },
        },
        Identifier: identifier,
        ...(isAmazonFulfilled ? { OptionalFulfillmentProgram: 'FBA_CORE' } : {}),
      },
    });
    return this.signedSpApiRequest(credentials, {
      method: 'POST',
      path: `/products/fees/v0/items/${encodeURIComponent(asin)}/feesEstimate`,
      body,
    });
  }

  /**
   * Listings Items API v2021-08-01: getListingsItem
   * GET /listings/2021-08-01/items/{sellerId}/{sku}
   * Returns this seller's own listing (their SKU, their listed price). Not other sellers' or buy box price.
   */
  async getListingsItem(
    credentials: SpApiCredentials,
    sellerId: string,
    sku: string,
    marketplaceIds: string[],
    includedData: string[] = ['summaries', 'offers'],
  ) {
    return this.signedSpApiRequest(credentials, {
      method: 'GET',
      path: `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
      query: {
        marketplaceIds: marketplaceIds.join(','),
        includedData: includedData.join(','),
      },
    });
  }

  /**
   * Catalog Items API v2022-04-01: getCatalogItem
   * GET /catalog/2022-04-01/items/{asin}
   *
   * Used to backfill product titles (via summaries.itemName) and productType/displayGroup (via productTypes).
   * @param includedData - optional; default 'summaries,attributes,images'. Add 'productTypes' for category fields.
   */
  async getCatalogItem(
    credentials: SpApiCredentials,
    asin: string,
    marketplaceIds: string[],
    includedData = 'summaries,attributes,images',
  ) {
    return this.signedSpApiRequest(credentials, {
      method: 'GET',
      path: `/catalog/2022-04-01/items/${encodeURIComponent(asin)}`,
      query: {
        marketplaceIds: marketplaceIds.join(','),
        includedData,
      },
    });
  }

  /**
   * FBA Inventory API v1: getInventorySummaries
   * GET /fba/inventory/v1/summaries
   *
   * Used to fetch FBA inventory quantities (fulfillable, inbound, reserved, etc).
   */
  async getFbaInventorySummaries(
    credentials: SpApiCredentials,
    params: {
      marketplaceId: string;
      details?: boolean;
      nextToken?: string;
      startDateTime?: string;
      sellerSku?: string;
      sellerSkus?: string[];
    },

  ) {
    const query: Record<string, unknown> = {
      granularityType: 'Marketplace',
      granularityId: params.marketplaceId,
      marketplaceIds: params.marketplaceId,
    };
    if (params.details !== undefined) query.details = params.details;
    if (params.nextToken) query.nextToken = params.nextToken;
    if (params.startDateTime) query.startDateTime = params.startDateTime;
    if (params.sellerSku) query.sellerSku = params.sellerSku;
    if (params.sellerSkus?.length) query.sellerSkus = params.sellerSkus;

    return this.signedSpApiRequest(credentials, {
      method: 'GET',
      path: "/fba/inventory/v1/summaries",
      query,
    });
  }

  /**
   * FBA Inbound API v0: getShipments
   * GET /fba/inbound/v0/shipments
   * Requires: QueryType (SHIPMENT | DATE_RANGE | NEXT_TOKEN), MarketplaceId. For SHIPMENT, at least one of ShipmentStatusList or ShipmentIdList.
   */
  async getFbaInboundShipments(
    credentials: SpApiCredentials,
    params: {
      marketplaceId: string;
      queryType: 'SHIPMENT' | 'DATE_RANGE' | 'NEXT_TOKEN';
      lastUpdatedAfter?: string;
      lastUpdatedBefore?: string;
      shipmentStatusList?: string[];
      shipmentIdList?: string[];
      nextToken?: string;
    },
  ): Promise<unknown> {
    const query: Record<string, unknown> = {
      QueryType: params.queryType,
      MarketplaceId: params.marketplaceId,
    };
    // All FBA inbound statuses – first getShipments request must send every status to return all shipment IDs.
    const defaultStatuses = [
      'WORKING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CHECKED_IN', 'RECEIVING', 'CLOSED', 'CANCELLED', 'DELETED', 'ERROR',
    ];
    if (params.nextToken) {
      query.NextToken = params.nextToken;
    } else if (params.queryType === 'SHIPMENT') {
      const statusList = params.shipmentStatusList?.length ? params.shipmentStatusList : defaultStatuses;
      query.ShipmentStatusList = statusList.join(',');
      if (params.shipmentIdList?.length) query.ShipmentIdList = params.shipmentIdList.join(',');
      this.logger.log(
        `[getFbaInboundShipments] SHIPMENT query: queryType=${params.queryType} marketplaceId=${params.marketplaceId} ShipmentStatusList=${query.ShipmentStatusList}`,
      );
    } else if (params.queryType === 'DATE_RANGE') {
      if (params.lastUpdatedAfter) query.LastUpdatedAfter = params.lastUpdatedAfter;
      if (params.lastUpdatedBefore) query.LastUpdatedBefore = params.lastUpdatedBefore;
      const statusList = params.shipmentStatusList?.length ? params.shipmentStatusList : defaultStatuses;
      query.ShipmentStatusList = statusList.join(',');
    }
    this.logger.log(
      `[getFbaInboundShipments] query keys: ${Object.keys(query).join(', ')}`,
    );
    return this.signedSpApiRequest(credentials, {
      method: 'GET',
      path: '/fba/inbound/v0/shipments',
      query,
    });
  }

  /**
   * FBA Inbound API v0: getShipmentItemsByShipmentId
   * GET /fba/inbound/v0/shipments/{shipmentId}/items (ShipmentId in path, not query)
   */
  async getFbaInboundShipmentItemsByShipmentId(
    credentials: SpApiCredentials,
    shipmentId: string,
    params?: { nextToken?: string },
  ): Promise<unknown> {
    const query: Record<string, unknown> = {};
    if (params?.nextToken) query.NextToken = params.nextToken;
    return this.signedSpApiRequest(credentials, {
      method: 'GET',
      path: `/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/items`,
      query,
    });
  }

  /**
   * FBA Inbound API v0: getTransportDetails
   * GET /fba/inbound/v0/shipments/{shipmentId}/transportDetails
   * Path segment encoded once here; same string is used for canonical URI and request (no double-encoding).
   */
  async getFbaInboundTransportDetails(
    credentials: SpApiCredentials,
    shipmentId: string,
  ): Promise<unknown> {
    const path = `/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/transportDetails`;
    this.logger.log(
      `[getFbaInboundTransportDetails] GET path=${path} shipmentId=${shipmentId} (raw=${JSON.stringify(shipmentId)} length=${shipmentId?.length ?? 0}) query=(none)`,
    );
    return this.signedSpApiRequest(credentials, {
      method: 'GET',
      path,
      query: {},
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
    // Use options.path as-is for signing and request (caller must encode path segments once; no double-encoding).
    const canonicalUri = options.path;
    const canonicalQuerystring = queryString;
    if (options.path === '/fba/inbound/v0/shipments') {
      this.logger.log(
        `[SP-API shipments] query object keys: ${Object.keys(options.query ?? {}).join(', ')}`,
      );
      this.logger.log(
        `[SP-API shipments] built query string (length=${queryString.length}): ${queryString}`,
      );
      this.logger.log(
        `[SP-API shipments] full path with query: ${canonicalUri}?${canonicalQuerystring}`,
      );
    }
    if (options.path === '/orders/v0/orders' && this.isDebugEnabled()) {
      this.logger.debug(`[SP-API getOrders] query: ${queryString}`);
    }
    if (this.isDebugEnabled()) {
      this.logger.debug(`SP-API request host=${host} awsRegion=${region}`);
    }

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

    const fullUrl = `https://${host}${pathWithQuery}`;
    if (this.isDebugEnabled()) {
      this.logger.log(`[SP-API] ${options.method} ${canonicalUri}`);
    }

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

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const fullUrl = `https://${host}${pathWithQuery}`;
      const isCatalog404 =
        response.statusCode === 404 &&
        (options.path?.includes('/catalog/') ?? false);
      const isListings404 =
        response.statusCode === 404 &&
        (options.path?.includes('/listings/') ?? false) &&
        (response.body ?? '').includes('NOT_FOUND');
      // Listings 404 NOT_FOUND = SKU not listed in that marketplace (expected). Do not log - not related to Orders API.
      const useDebugLog = isCatalog404;
      const log = useDebugLog ? this.logger.debug?.bind(this.logger) ?? this.logger.log : this.logger.warn.bind(this.logger);
      if (!isListings404) {
        log(`[SP-API] request failed: ${options.method} ${fullUrl} -> ${response.statusCode}`);
      }
      // Skip response body / error detail logs for Listings 404 NOT_FOUND (expected for unlisted SKUs).
      if (!useDebugLog && !isListings404) {
        const bodyPreview = (response.body ?? '').slice(0, 800);
        this.logger.warn(`[SP-API] response body: ${bodyPreview}${(response.body?.length ?? 0) > 800 ? '...' : ''}`);
        try {
          const parsed = JSON.parse(response.body ?? '{}') as { errors?: Array<{ code?: string; message?: string; details?: string }> };
          if (parsed?.errors?.length) {
            parsed.errors.forEach((err, idx) => {
              this.logger.warn(`[SP-API] error[${idx}] code=${err?.code ?? 'n/a'} message=${err?.message ?? 'n/a'} details=${err?.details ?? 'n/a'}`);
            });
          }
        } catch {
          // ignore parse errors
        }
      }
      throw new Error(
        `SP-API request failed: ${options.method} ${options.path} (${response.statusCode}) ${response.body}`,
      );
    }

    try {
      return JSON.parse(response.body);
    } catch {
      return response.body;
    }
  }

  /**
   * Build query string with params sorted by name (then value for duplicates) per AWS Sig V4.
   * Ensures ShipmentStatusList and other repeated params are sent and signature matches.
   */
  private buildQueryString(query: Record<string, unknown>): string {
    const pairs: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const v of value) {
          pairs.push([key, String(v)]);
        }
      } else {
        pairs.push([key, String(value)]);
      }
    }
    pairs.sort((a, b) => {
      const cmp = a[0].localeCompare(b[0]);
      return cmp !== 0 ? cmp : a[1].localeCompare(b[1]);
    });
    return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
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
