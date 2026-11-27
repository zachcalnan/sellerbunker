import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

export const FEES_ESTIMATE_API_KEY_MAX_ITEMS = 20;

export class FeesEstimateApiKeyItemDto {
  /** Amazon ASIN (10 alphanumeric). Does not need to be in the seller's catalog. */
  @IsString()
  @Matches(/^[A-Za-z0-9]{10}$/, { message: 'asin must be a 10-character ASIN' })
  asin: string;

  /** Sell price to estimate fees against. */
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  price: number;

  /** Overrides the request-level fulfilment for this item only. Defaults to FBA. */
  @IsIn(['FBA', 'FBM'])
  @IsOptional()
  fulfilment?: 'FBA' | 'FBM';

  /** Alias of `fulfilment` (American spelling). */
  @IsIn(['FBA', 'FBM'])
  @IsOptional()
  fulfillment?: 'FBA' | 'FBM';
}

/**
 * Body for POST /api/amazon/fees-estimate-api-key
 * (server-to-server, x-api-key). At most 20 items, matching
 * SP-API getMyFeesEstimates.
 */
export class FeesEstimateApiKeyDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(FEES_ESTIMATE_API_KEY_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => FeesEstimateApiKeyItemDto)
  items: FeesEstimateApiKeyItemDto[];

  /** Default fulfilment for items that omit it. Defaults to FBA. */
  @IsIn(['FBA', 'FBM'])
  @IsOptional()
  fulfilment?: 'FBA' | 'FBM';

  /** Alias of `fulfilment` (American spelling). */
  @IsIn(['FBA', 'FBM'])
  @IsOptional()
  fulfillment?: 'FBA' | 'FBM';

  /** Defaults to Amazon UK `A1F83G8C2ARO7P`. */
  @IsString()
  @IsOptional()
  marketplaceId?: string;

  /** Defaults to the marketplace currency (GBP for UK). */
  @IsString()
  @IsOptional()
  currency?: string;
}
