import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LinkAmazonAccountDto {
  @IsIn(['na', 'eu', 'fe'])
  region: 'na' | 'eu' | 'fe';

  @IsString()
  @IsNotEmpty()
  sellerId: string;

  @IsString()
  @IsNotEmpty()
  lwaClientId: string;

  @IsString()
  @IsNotEmpty()
  lwaClientSecret: string;

  @IsString()
  @IsNotEmpty()
  refreshToken: string;

  @IsString()
  @IsNotEmpty()
  awsAccessKeyId: string;

  @IsString()
  @IsNotEmpty()
  awsSecretAccessKey: string;

  @IsString()
  @IsOptional()
  awsRoleArn?: string;
}
