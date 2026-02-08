import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreatePurchaseDto {
  @IsString()
  @IsNotEmpty()
  productId: string;

  @IsString()
  @IsOptional()
  fulfilment?: string; // e.g. "Amazon"

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
  purchaseDate: string; // ISO string

  @IsString()
  @IsOptional()
  orderNumber?: string;

  @IsString()
  @IsOptional()
  shipmentId?: string;

  @IsInt()
  @Min(0)
  qtyPurchased: number;

  @IsInt()
  @Min(0)
  qtyDelivered: number;

  @IsString()
  @IsOptional()
  currency?: string; // e.g. "GBP"

  // Stored as a number; converted to Decimal by Prisma.
  @Min(0)
  vatRatePct: number;

  @Min(0)
  unitCostIncVat: number;

  @Min(0)
  deliveryCostIncVat: number;

  @Min(0)
  prepCostIncVat: number;
}
