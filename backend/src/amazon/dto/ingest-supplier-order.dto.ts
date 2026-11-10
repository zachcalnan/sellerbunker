import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class SupplierOrderPromoDto {
  @IsIn(['none', 'buy_3_get_1_free'])
  type: 'none' | 'buy_3_get_1_free';
}

export class IngestSupplierOrderLineDto {
  @IsString()
  @IsOptional()
  asin?: string;

  @IsString()
  @IsOptional()
  sku?: string;

  /** Used when creating a missing product (screenshot / bot flows). */
  @IsString()
  @IsOptional()
  productTitle?: string;

  @IsInt()
  @Min(1)
  qty: number;

  /** Shelf / list price per unit (inc VAT) before promo. */
  @IsNumber()
  @Min(0)
  @IsOptional()
  unitRrpIncVat?: number;

  /** Override computed promo unit cost (inc VAT). */
  @IsNumber()
  @Min(0)
  @IsOptional()
  unitCostIncVat?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  deliveryCostIncVat?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  prepCostIncVat?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  qtyDelivered?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  bundleSize?: number;
}

export class IngestSupplierOrderDto {
  @IsString()
  @IsNotEmpty()
  supplier: string;

  @IsString()
  @IsNotEmpty()
  orderNumber: string;

  @IsDateString()
  purchaseDate: string;

  @IsString()
  @IsOptional()
  supplierLink?: string;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  vatRatePct?: number;

  @IsString()
  @IsOptional()
  fulfilment?: string;

  /**
   * Purchase-sheet Home/Prep column: HOME vs PREP CENTER
   * (ship-to home address vs prep / fulfilment centre).
   */
  @IsIn(['HOME', 'PREP CENTER'])
  @IsOptional()
  shipDestination?: 'HOME' | 'PREP CENTER';

  @IsString()
  @IsOptional()
  shipmentId?: string;

  /** Courier tracking for prep-centre Inbound sheet (optional). */
  @IsString()
  @IsOptional()
  courierTracking?: string;

  /** Free-text notes → CURRENT ORDERS Notes column. */
  @IsString()
  @IsOptional()
  notes?: string;

  /**
   * When true (and shipDestination is PREP CENTER), also write `notes` onto
   * the Blue30 Inbound Notes column. Purchase sheet always gets notes.
   */
  @IsBoolean()
  @IsOptional()
  copyNotesToPrepInbound?: boolean;

  @ValidateNested()
  @Type(() => SupplierOrderPromoDto)
  @IsOptional()
  promo?: SupplierOrderPromoDto;

  /**
   * When true, create a Product for lines with an ASIN that is not yet in the account
   * (SKU defaults to SUP-<asin tail> when omitted).
   */
  @IsBoolean()
  @IsOptional()
  createProductIfMissing?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => IngestSupplierOrderLineDto)
  lines: IngestSupplierOrderLineDto[];
}
