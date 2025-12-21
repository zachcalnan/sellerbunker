import type * as types from './types';
import type { ConfigOptions, FetchResponse } from 'api/dist/core'
import Oas from 'oas';
import APICore from 'api/dist/core';
import definition from './openapi.json';

class SDK {
  spec: Oas;
  core: APICore;

  constructor() {
    this.spec = Oas.init(definition);
    this.core = new APICore(this.spec, 'sp-api/v0 (api/6.1.3)');
  }

  /**
   * Optionally configure various options that the SDK allows.
   *
   * @param config Object of supported SDK options and toggles.
   * @param config.timeout Override the default `fetch` request timeout of 30 seconds. This number
   * should be represented in milliseconds.
   */
  config(config: ConfigOptions) {
    this.core.setConfig(config);
  }

  /**
   * If the API you're using requires authentication you can supply the required credentials
   * through this method and the library will magically determine how they should be used
   * within your API request.
   *
   * With the exception of OpenID and MutualTLS, it supports all forms of authentication
   * supported by the OpenAPI specification.
   *
   * @example <caption>HTTP Basic auth</caption>
   * sdk.auth('username', 'password');
   *
   * @example <caption>Bearer tokens (HTTP or OAuth 2)</caption>
   * sdk.auth('myBearerToken');
   *
   * @example <caption>API Keys</caption>
   * sdk.auth('myApiKey');
   *
   * @see {@link https://spec.openapis.org/oas/v3.0.3#fixed-fields-22}
   * @see {@link https://spec.openapis.org/oas/v3.1.0#fixed-fields-22}
   * @param values Your auth credentials for the API; can specify up to two strings or numbers.
   */
  auth(...values: string[] | number[]) {
    this.core.setAuth(...values);
    return this;
  }

  /**
   * If the API you're using offers alternate server URLs, and server variables, you can tell
   * the SDK which one to use with this method. To use it you can supply either one of the
   * server URLs that are contained within the OpenAPI definition (along with any server
   * variables), or you can pass it a fully qualified URL to use (that may or may not exist
   * within the OpenAPI definition).
   *
   * @example <caption>Server URL with server variables</caption>
   * sdk.server('https://{region}.api.example.com/{basePath}', {
   *   name: 'eu',
   *   basePath: 'v14',
   * });
   *
   * @example <caption>Fully qualified server URL</caption>
   * sdk.server('https://eu.api.example.com/v14');
   *
   * @param url Server URL
   * @param variables An object of variables to replace into the server URL.
   */
  server(url: string, variables = {}) {
    this.core.setServer(url, variables);
  }

  /**
   * Returns orders that are created or updated during the specified time period. If you want
   * to return specific types of orders, you can apply filters to your request. `NextToken`
   * doesn't affect any filters that you include in your request; it only impacts the
   * pagination for the filtered orders response. 
   *
   * **Usage Plan:**
   *
   * | Rate (requests per second) | Burst |
   * | ---- | ---- |
   * | 0.0167 | 20 |
   *
   * The `x-amzn-RateLimit-Limit` response header contains the usage plan rate limits for the
   * operation, when available. The preceding table contains the default rate and burst
   * values for this operation. Selling partners whose business demands require higher
   * throughput might have higher rate and burst values than those shown here. For more
   * information, refer to [Usage Plans and Rate
   * Limits](https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits-in-the-sp-api).
   *
   * @summary getOrders
   * @throws FetchError<400, types.GetOrdersResponse400> Request has missing or invalid parameters and cannot be parsed.
   * @throws FetchError<403, types.GetOrdersResponse403> Indicates access to the resource is forbidden. Possible reasons include Access Denied,
   * Unauthorized, Expired Token, or Invalid Signature.
   * @throws FetchError<404, types.GetOrdersResponse404> The resource specified does not exist.
   * @throws FetchError<429, types.GetOrdersResponse429> The frequency of requests was greater than allowed.
   * @throws FetchError<500, types.GetOrdersResponse500> An unexpected condition occurred that prevented the server from fulfilling the request.
   * @throws FetchError<503, types.GetOrdersResponse503> Temporary overloading or maintenance of the server.
   */
  getOrders(metadata: types.GetOrdersMetadataParam): Promise<FetchResponse<200, types.GetOrdersResponse200>> {
    return this.core.fetch('/orders/v0/orders', 'get', metadata);
  }

  /**
   * Returns the order that you specify.
   *
   * **Usage Plan:**
   *
   * | Rate (requests per second) | Burst |
   * | ---- | ---- |
   * | 0.5 | 30 |
   *
   * The `x-amzn-RateLimit-Limit` response header contains the usage plan rate limits for the
   * operation, when available. The preceding table contains the default rate and burst
   * values for this operation. Selling partners whose business demands require higher
   * throughput might have higher rate and burst values than those shown here. For more
   * information, refer to [Usage Plans and Rate
   * Limits](https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits-in-the-sp-api).
   *
   * @summary getOrder
   * @throws FetchError<400, types.GetOrderResponse400> Request has missing or invalid parameters and cannot be parsed.
   * @throws FetchError<403, types.GetOrderResponse403> Indicates access to the resource is forbidden. Possible reasons include Access Denied,
   * Unauthorized, Expired Token, or Invalid Signature.
   * @throws FetchError<404, types.GetOrderResponse404> The resource specified does not exist.
   * @throws FetchError<429, types.GetOrderResponse429> The frequency of requests was greater than allowed.
   * @throws FetchError<500, types.GetOrderResponse500> An unexpected condition occurred that prevented the server from fulfilling the request.
   * @throws FetchError<503, types.GetOrderResponse503> Temporary overloading or maintenance of the server.
   */
  getOrder(metadata: types.GetOrderMetadataParam): Promise<FetchResponse<200, types.GetOrderResponse200>> {
    return this.core.fetch('/orders/v0/orders/{orderId}', 'get', metadata);
  }

  /**
   * Returns buyer information for the order that you specify.
   *
   * **Usage Plan:**
   *
   * | Rate (requests per second) | Burst |
   * | ---- | ---- |
   * | 0.5 | 30 |
   *
   * The `x-amzn-RateLimit-Limit` response header contains the usage plan rate limits for the
   * operation, when available. The preceding table contains the default rate and burst
   * values for this operation. Selling partners whose business demands require higher
   * throughput might have higher rate and burst values than those shown here. For more
   * information, refer to [Usage Plans and Rate
   * Limits](https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits-in-the-sp-api).
   *
   * @summary getOrderBuyerInfo
   * @throws FetchError<400, types.GetOrderBuyerInfoResponse400> Request has missing or invalid parameters and cannot be parsed.
   * @throws FetchError<403, types.GetOrderBuyerInfoResponse403> Indicates access to the resource is forbidden. Possible reasons include Access Denied,
   * Unauthorized, Expired Token, or Invalid Signature.
   * @throws FetchError<404, types.GetOrderBuyerInfoResponse404> The resource specified does not exist.
   * @throws FetchError<429, types.GetOrderBuyerInfoResponse429> The frequency of requests was greater than allowed.
   * @throws FetchError<500, types.GetOrderBuyerInfoResponse500> An unexpected condition occurred that prevented the server from fulfilling the request.
   * @throws FetchError<503, types.GetOrderBuyerInfoResponse503> Temporary overloading or maintenance of the server.
   */
  getOrderBuyerInfo(metadata: types.GetOrderBuyerInfoMetadataParam): Promise<FetchResponse<200, types.GetOrderBuyerInfoResponse200>> {
    return this.core.fetch('/orders/v0/orders/{orderId}/buyerInfo', 'get', metadata);
  }

  /**
   * Returns the shipping address for the order that you specify.
   *
   * **Usage Plan:**
   *
   * | Rate (requests per second) | Burst |
   * | ---- | ---- |
   * | 0.5 | 30 |
   *
   * The `x-amzn-RateLimit-Limit` response header contains the usage plan rate limits for the
   * operation, when available. The preceding table contains the default rate and burst
   * values for this operation. Selling partners whose business demands require higher
   * throughput might have higher rate and burst values than those shown here. For more
   * information, refer to [Usage Plans and Rate
   * Limits](https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits-in-the-sp-api).
   *
   * @summary getOrderAddress
   * @throws FetchError<400, types.GetOrderAddressResponse400> Request has missing or invalid parameters and cannot be parsed.
   * @throws FetchError<403, types.GetOrderAddressResponse403> Indicates access to the resource is forbidden. Possible reasons include Access Denied,
   * Unauthorized, Expired Token, or Invalid Signature.
   * @throws FetchError<404, types.GetOrderAddressResponse404> The resource specified does not exist.
   * @throws FetchError<429, types.GetOrderAddressResponse429> The frequency of requests was greater than allowed.
   * @throws FetchError<500, types.GetOrderAddressResponse500> An unexpected condition occurred that prevented the server from fulfilling the request.
   * @throws FetchError<503, types.GetOrderAddressResponse503> Temporary overloading or maintenance of the server.
   */
  getOrderAddress(metadata: types.GetOrderAddressMetadataParam): Promise<FetchResponse<200, types.GetOrderAddressResponse200>> {
    return this.core.fetch('/orders/v0/orders/{orderId}/address', 'get', metadata);
  }

  /**
   * Returns detailed order item information for the order that you specify. If `NextToken`
   * is provided, it's used to retrieve the next page of order items.
   *
   * __Note__: When an order is in the Pending state (the order has been placed but payment
   * has not been authorized), the getOrderItems operation does not return information about
   * pricing, taxes, shipping charges, gift status or promotions for the order items in the
   * order. After an order leaves the Pending state (this occurs when payment has been
   * authorized) and enters the Unshipped, Partially Shipped, or Shipped state, the
   * getOrderItems operation returns information about pricing, taxes, shipping charges, gift
   * status and promotions for the order items in the order.
   *
   * **Usage Plan:**
   *
   * | Rate (requests per second) | Burst |
   * | ---- | ---- |
   * | 0.5 | 30 |
   *
   * The `x-amzn-RateLimit-Limit` response header contains the usage plan rate limits for the
   * operation, when available. The preceding table contains the default rate and burst
   * values for this operation. Selling partners whose business demands require higher
   * throughput might have higher rate and burst values than those shown here. For more
   * information, refer to [Usage Plans and Rate
   * Limits](https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits-in-the-sp-api).
   *
   * @summary getOrderItems
   * @throws FetchError<400, types.GetOrderItemsResponse400> Request has missing or invalid parameters and cannot be parsed.
   * @throws FetchError<403, types.GetOrderItemsResponse403> Indicates access to the resource is forbidden. Possible reasons include Access Denied,
   * Unauthorized, Expired Token, or Invalid Signature.
   * @throws FetchError<404, types.GetOrderItemsResponse404> The resource specified does not exist.
   * @throws FetchError<429, types.GetOrderItemsResponse429> The frequency of requests was greater than allowed.
   * @throws FetchError<500, types.GetOrderItemsResponse500> An unexpected condition occurred that prevented the server from fulfilling the request.
   * @throws FetchError<503, types.GetOrderItemsResponse503> Temporary overloading or maintenance of the server.
   */
  getOrderItems(metadata: types.GetOrderItemsMetadataParam): Promise<FetchResponse<200, types.GetOrderItemsResponse200>> {
    return this.core.fetch('/orders/v0/orders/{orderId}/orderItems', 'get', metadata);
  }

  /**
   * Returns buyer information for the order items in the order that you specify.
   *
   * **Usage Plan:**
   *
   * | Rate (requests per second) | Burst |
   * | ---- | ---- |
   * | 0.5 | 30 |
   *
   * The `x-amzn-RateLimit-Limit` response header contains the usage plan rate limits for the
   * operation, when available. The preceding table contains the default rate and burst
   * values for this operation. Selling partners whose business demands require higher
   * throughput might have higher rate and burst values than those shown here. For more
   * information, refer to [Usage Plans and Rate
   * Limits](https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits-in-the-sp-api).
   *
   * @summary getOrderItemsBuyerInfo
   * @throws FetchError<400, types.GetOrderItemsBuyerInfoResponse400> Request has missing or invalid parameters and cannot be parsed.
   * @throws FetchError<403, types.GetOrderItemsBuyerInfoResponse403> Indicates access to the resource is forbidden. Possible reasons include Access Denied,
   * Unauthorized, Expired Token, or Invalid Signature.
   * @throws FetchError<404, types.GetOrderItemsBuyerInfoResponse404> The resource specified does not exist.
   * @throws FetchError<429, types.GetOrderItemsBuyerInfoResponse429> The frequency of requests was greater than allowed.
   * @throws FetchError<500, types.GetOrderItemsBuyerInfoResponse500> An unexpected condition occurred that prevented the server from fulfilling the request.
   * @throws FetchError<503, types.GetOrderItemsBuyerInfoResponse503> Temporary overloading or maintenance of the server.
   */
  getOrderItemsBuyerInfo(metadata: types.GetOrderItemsBuyerInfoMetadataParam): Promise<FetchResponse<200, types.GetOrderItemsBuyerInfoResponse200>> {
    return this.core.fetch('/orders/v0/orders/{orderId}/orderItems/buyerInfo', 'get', metadata);
  }

  /**
   * Update the shipment status for an order that you specify.
   *
   * **Usage Plan:**
   *
   * | Rate (requests per second) | Burst |
   * | ---- | ---- |
   * | 5 | 15 |
   *
   * The `x-amzn-RateLimit-Limit` response header contains the usage plan rate limits for the
   * operation, when available. The preceding table contains the default rate and burst
   * values for this operation. Selling partners whose business demands require higher
   * throughput might have higher rate and burst values than those shown here. For more
   * information, refer to [Usage Plans and Rate
   * Limits](https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits-in-the-sp-api).
   *
   * @summary updateShipmentStatus
   * @throws FetchError<400, types.UpdateShipmentStatusResponse400> Request has missing or invalid parameters and cannot be parsed.
   * @throws FetchError<403, types.UpdateShipmentStatusResponse403> Indicates that access to the resource is forbidden. Possible reasons include Access
   * Denied, Unauthorized, Expired Token, or Invalid Signature.
   * @throws FetchError<404, types.UpdateShipmentStatusResponse404> The resource specified does not exist.
   * @throws FetchError<413, types.UpdateShipmentStatusResponse413> The request size exceeded the maximum accepted size.
   * @throws FetchError<415, types.UpdateShipmentStatusResponse415> The request payload is in an unsupported format.
   * @throws FetchError<429, types.UpdateShipmentStatusResponse429> The frequency of requests was greater than allowed.
   * @throws FetchError<500, types.UpdateShipmentStatusResponse500> An unexpected condition occurred that prevented the server from fulfilling the request.
   * @throws FetchError<503, types.UpdateShipmentStatusResponse503> Temporary overloading or maintenance of the server.
   */
  updateShipmentStatus(body: types.UpdateShipmentStatusBodyParam, metadata: types.UpdateShipmentStatusMetadataParam): Promise<FetchResponse<204, types.UpdateShipmentStatusResponse204>> {
    return this.core.fetch('/orders/v0/orders/{orderId}/shipment', 'post', body, metadata);
  }

  /**
   * Returns regulated information for the order that you specify.
   *
   * **Usage Plan:**
   *
   * | Rate (requests per second) | Burst |
   * | ---- | ---- |
   * | 0.5 | 30 |
   *
   * The `x-amzn-RateLimit-Limit` response header contains the usage plan rate limits for the
   * operation, when available. The preceding table contains the default rate and burst
   * values for this operation. Selling partners whose business demands require higher
   * throughput might have higher rate and burst values than those shown here. For more
   * information, refer to [Usage Plans and Rate
   * Limits](https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits-in-the-sp-api).
   *
   * @summary getOrderRegulatedInfo
   * @throws FetchError<400, types.GetOrderRegulatedInfoResponse400> Request has missing or invalid parameters and cannot be parsed.
   * @throws FetchError<403, types.GetOrderRegulatedInfoResponse403> Indicates access to the resource is forbidden. Possible reasons include Access Denied,
   * Unauthorized, Expired Token, or Invalid Signature.
   * @throws FetchError<404, types.GetOrderRegulatedInfoResponse404> The resource specified does not exist.
   * @throws FetchError<429, types.GetOrderRegulatedInfoResponse429> The frequency of requests was greater than allowed.
   * @throws FetchError<500, types.GetOrderRegulatedInfoResponse500> An unexpected condition occurred that prevented the server from fulfilling the request.
   * @throws FetchError<503, types.GetOrderRegulatedInfoResponse503> Temporary overloading or maintenance of the server.
   */
  getOrderRegulatedInfo(metadata: types.GetOrderRegulatedInfoMetadataParam): Promise<FetchResponse<200, types.GetOrderRegulatedInfoResponse200>> {
    return this.core.fetch('/orders/v0/orders/{orderId}/regulatedInfo', 'get', metadata);
  }

  /**
   * Updates (approves or rejects) the verification status of an order containing regulated
   * products.
   *
   * **Usage Plan:**
   *
   * | Rate (requests per second) | Burst |
   * | ---- | ---- |
   * | 0.5 | 30 |
   *
   * The `x-amzn-RateLimit-Limit` response header contains the usage plan rate limits for the
   * operation, when available. The preceding table contains the default rate and burst
   * values for this operation. Selling partners whose business demands require higher
   * throughput might have higher rate and burst values than those shown here. For more
   * information, refer to [Usage Plans and Rate
   * Limits](https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits-in-the-sp-api).
   *
   * @summary updateVerificationStatus
   * @throws FetchError<400, types.UpdateVerificationStatusResponse400> Request has missing or invalid parameters and cannot be parsed.
   * @throws FetchError<403, types.UpdateVerificationStatusResponse403> Indicates that access to the resource is forbidden. Possible reasons include Access
   * Denied, Unauthorized, Expired Token, or Invalid Signature.
   * @throws FetchError<404, types.UpdateVerificationStatusResponse404> The resource specified does not exist.
   * @throws FetchError<413, types.UpdateVerificationStatusResponse413> The request size exceeded the maximum accepted size.
   * @throws FetchError<415, types.UpdateVerificationStatusResponse415> The request payload is in an unsupported format.
   * @throws FetchError<429, types.UpdateVerificationStatusResponse429> The frequency of requests was greater than allowed.
   * @throws FetchError<500, types.UpdateVerificationStatusResponse500> An unexpected condition occurred that prevented the server from fulfilling the request.
   * @throws FetchError<503, types.UpdateVerificationStatusResponse503> Temporary overloading or maintenance of the server.
   */
  updateVerificationStatus(body: types.UpdateVerificationStatusBodyParam, metadata: types.UpdateVerificationStatusMetadataParam): Promise<FetchResponse<204, types.UpdateVerificationStatusResponse204>> {
    return this.core.fetch('/orders/v0/orders/{orderId}/regulatedInfo', 'patch', body, metadata);
  }

  /**
   * Updates the shipment confirmation status for a specified order.
   *
   * **Usage Plan:**
   *
   * | Rate (requests per second) | Burst |
   * | ---- | ---- |
   * | 2 | 10 |
   *
   * The `x-amzn-RateLimit-Limit` response header contains the usage plan rate limits for the
   * operation, when available. The preceding table contains the default rate and burst
   * values for this operation. Selling partners whose business demands require higher
   * throughput might have higher rate and burst values than those shown here. For more
   * information, refer to [Usage Plans and Rate
   * Limits](https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits-in-the-sp-api).
   *
   * @summary confirmShipment
   * @throws FetchError<400, types.ConfirmShipmentResponse400> Request has missing or invalid parameters and cannot be parsed.
   * @throws FetchError<401, types.ConfirmShipmentResponse401> The request's Authorization header is not formatted correctly or does not contain a
   * valid token.
   * @throws FetchError<403, types.ConfirmShipmentResponse403> Indicates that access to the resource is forbidden. Possible reasons include Access
   * Denied, Unauthorized, Expired Token, or Invalid Signature.
   * @throws FetchError<404, types.ConfirmShipmentResponse404> The specified resource does not exist.
   * @throws FetchError<429, types.ConfirmShipmentResponse429> The frequency of requests was greater than allowed.
   * @throws FetchError<500, types.ConfirmShipmentResponse500> An unexpected condition occurred that prevented the server from fulfilling the request.
   * @throws FetchError<503, types.ConfirmShipmentResponse503> Temporary overloading or maintenance of the server.
   */
  confirmShipment(body: types.ConfirmShipmentBodyParam, metadata: types.ConfirmShipmentMetadataParam): Promise<FetchResponse<204, types.ConfirmShipmentResponse204>> {
    return this.core.fetch('/orders/v0/orders/{orderId}/shipmentConfirmation', 'post', body, metadata);
  }
}

const createSDK = (() => { return new SDK(); })()
;

export default createSDK;

export type { ConfirmShipmentBodyParam, ConfirmShipmentMetadataParam, ConfirmShipmentResponse204, ConfirmShipmentResponse400, ConfirmShipmentResponse401, ConfirmShipmentResponse403, ConfirmShipmentResponse404, ConfirmShipmentResponse429, ConfirmShipmentResponse500, ConfirmShipmentResponse503, GetOrderAddressMetadataParam, GetOrderAddressResponse200, GetOrderAddressResponse400, GetOrderAddressResponse403, GetOrderAddressResponse404, GetOrderAddressResponse429, GetOrderAddressResponse500, GetOrderAddressResponse503, GetOrderBuyerInfoMetadataParam, GetOrderBuyerInfoResponse200, GetOrderBuyerInfoResponse400, GetOrderBuyerInfoResponse403, GetOrderBuyerInfoResponse404, GetOrderBuyerInfoResponse429, GetOrderBuyerInfoResponse500, GetOrderBuyerInfoResponse503, GetOrderItemsBuyerInfoMetadataParam, GetOrderItemsBuyerInfoResponse200, GetOrderItemsBuyerInfoResponse400, GetOrderItemsBuyerInfoResponse403, GetOrderItemsBuyerInfoResponse404, GetOrderItemsBuyerInfoResponse429, GetOrderItemsBuyerInfoResponse500, GetOrderItemsBuyerInfoResponse503, GetOrderItemsMetadataParam, GetOrderItemsResponse200, GetOrderItemsResponse400, GetOrderItemsResponse403, GetOrderItemsResponse404, GetOrderItemsResponse429, GetOrderItemsResponse500, GetOrderItemsResponse503, GetOrderMetadataParam, GetOrderRegulatedInfoMetadataParam, GetOrderRegulatedInfoResponse200, GetOrderRegulatedInfoResponse400, GetOrderRegulatedInfoResponse403, GetOrderRegulatedInfoResponse404, GetOrderRegulatedInfoResponse429, GetOrderRegulatedInfoResponse500, GetOrderRegulatedInfoResponse503, GetOrderResponse200, GetOrderResponse400, GetOrderResponse403, GetOrderResponse404, GetOrderResponse429, GetOrderResponse500, GetOrderResponse503, GetOrdersMetadataParam, GetOrdersResponse200, GetOrdersResponse400, GetOrdersResponse403, GetOrdersResponse404, GetOrdersResponse429, GetOrdersResponse500, GetOrdersResponse503, UpdateShipmentStatusBodyParam, UpdateShipmentStatusMetadataParam, UpdateShipmentStatusResponse204, UpdateShipmentStatusResponse400, UpdateShipmentStatusResponse403, UpdateShipmentStatusResponse404, UpdateShipmentStatusResponse413, UpdateShipmentStatusResponse415, UpdateShipmentStatusResponse429, UpdateShipmentStatusResponse500, UpdateShipmentStatusResponse503, UpdateVerificationStatusBodyParam, UpdateVerificationStatusMetadataParam, UpdateVerificationStatusResponse204, UpdateVerificationStatusResponse400, UpdateVerificationStatusResponse403, UpdateVerificationStatusResponse404, UpdateVerificationStatusResponse413, UpdateVerificationStatusResponse415, UpdateVerificationStatusResponse429, UpdateVerificationStatusResponse500, UpdateVerificationStatusResponse503 } from './types';
