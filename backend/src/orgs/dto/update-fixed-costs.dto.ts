import { Type } from 'class-transformer';
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

class FixedCostLineItemDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  /** Stored monthly (GBP, EUR, etc. handled elsewhere); must be >= 0. */
  @IsNumber()
  @Min(0)
  monthlyCost!: number;
}

export class UpdateFixedCostsDto {
  @IsNumber()
  @Min(0)
  @IsOptional()
  softwareCosts?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FixedCostLineItemDto)
  @IsOptional()
  softwareCostItems?: FixedCostLineItemDto[];

  @IsNumber()
  @Min(0)
  @IsOptional()
  otherSubscriptions?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FixedCostLineItemDto)
  @IsOptional()
  otherSubscriptionItems?: FixedCostLineItemDto[];

  @IsNumber()
  @Min(0)
  @IsOptional()
  otherFixedCosts?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FixedCostLineItemDto)
  @IsOptional()
  otherFixedCostItems?: FixedCostLineItemDto[];
}
