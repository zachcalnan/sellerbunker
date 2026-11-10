import { Type } from 'class-transformer';
import {
  IsDate,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreatePushAlertDto {
  /** When to send (ISO datetime). Must be in the future. */
  @Type(() => Date)
  @IsDate()
  fireAt!: Date;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  /** Note shown in the push body (e.g. "Cancel membership"). */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  body!: string;

  /** Tap opens this URL (cancel / account page). */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;
}
