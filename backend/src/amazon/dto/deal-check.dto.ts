import { Transform, Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class DealCheckDto {
  @IsString()
  @Length(10, 10)
  @Transform(({ value }) => String(value ?? '').trim().toUpperCase())
  asin!: string;

  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  buyPrice!: number;

  @IsOptional()
  @IsString()
  marketplaceId?: string;

  @IsOptional()
  @IsNumber()
  @Min(30)
  @Max(365)
  @Type(() => Number)
  lookbackDays?: number;
}
