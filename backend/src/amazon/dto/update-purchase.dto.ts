import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class UpdatePurchaseDto {
  @IsString()
  @IsOptional()
  fulfilment?: string;

  @IsString()
  @IsOptional()
  supplier?: string;

  @IsString()
  @IsOptional()
  supplierLink?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  bundleSize?: number;

  @IsDateString()
  @IsOptional()
  purchaseDate?: string;

  @IsString()
  @IsOptional()
  orderNumber?: string;

  @IsString()
  @IsOptional()
  shipmentId?: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  qtyPurchased?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  qtyDelivered?: number;

  @IsString()
  @IsOptional()
  currency?: string;

  @Min(0)
  @IsOptional()
  vatRatePct?: number;

  @Min(0)
  @IsOptional()
  unitCostIncVat?: number;

  @Min(0)
  @IsOptional()
  deliveryCostIncVat?: number;

  @Min(0)
  @IsOptional()
  prepCostIncVat?: number;
}
