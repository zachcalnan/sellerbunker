import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class ProductFinderSearchDto {
  /** ASIN or product title / keywords */
  @IsString()
  @MinLength(2)
  seed: string;

  /** Max unit buy / deal price (inc VAT) you are willing to pay */
  @IsNumber()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  maxBuyPrice?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  minProfitPerUnit?: number;

  /** e.g. 0.25 = 25% ROI */
  @IsNumber()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  minRoi?: number;

  @IsBoolean()
  @IsOptional()
  @Type(() => Boolean)
  requireUngated?: boolean;

  /**
   * Optional OpenAI narrative for the top results only (costs ~1 cheap chat call).
   * Default false — keep off to avoid spend.
   */
  @IsBoolean()
  @IsOptional()
  @Type(() => Boolean)
  includeAiSummary?: boolean;

  @IsNumber()
  @Min(1)
  @Max(50)
  @IsOptional()
  @Type(() => Number)
  take?: number;
}
