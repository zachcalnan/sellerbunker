import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class ExtractPurchaseScreenshotDto {
  /** Raw base64 (no data: URL prefix) or a full data URL. */
  @IsString()
  @IsNotEmpty()
  imageBase64: string;

  @IsString()
  @IsOptional()
  @IsIn(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

  /** Optional hint, e.g. "Healf order confirmation". */
  @IsString()
  @IsOptional()
  hint?: string;
}
