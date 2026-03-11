import { IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateFixedCostsDto {
  @IsNumber()
  @Min(0)
  @IsOptional()
  softwareCosts?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  otherSubscriptions?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  otherFixedCosts?: number;
}
