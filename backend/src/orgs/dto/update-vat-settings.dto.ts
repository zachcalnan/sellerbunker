import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  Min,
  Max,
} from 'class-validator';

export const VAT_REGISTRATION_TYPES = [
  'NON_VAT_REGISTERED',
  'VAT_STANDARD',
  'VAT_FLAT_RATE',
] as const;
export type VatRegistrationType = (typeof VAT_REGISTRATION_TYPES)[number];

export class UpdateVatSettingsDto {
  @IsIn([...VAT_REGISTRATION_TYPES])
  @IsOptional()
  vatRegistrationType?: VatRegistrationType;

  @IsDateString()
  @IsOptional()
  vatEffectiveDate?: string; // ISO date; when to start applying VAT logic

  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  vatFlatRatePct?: number; // flat rate % (VAT_FLAT_RATE only)

  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  vatRatePct?: number; // standard VAT % for costs/revenue (VAT_STANDARD)

  @IsBoolean()
  @IsOptional()
  vatCostsIncludeVat?: boolean; // true = user enters costs incl VAT (VAT_STANDARD only)
}
