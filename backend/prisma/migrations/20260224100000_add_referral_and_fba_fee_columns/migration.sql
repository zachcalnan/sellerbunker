-- Add estimated referral and FBA fee per unit (from same Product Fees API FeeDetailList).
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "estimated_referral_fee_per_unit" DECIMAL(10,2);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "estimated_fba_fee_per_unit" DECIMAL(10,2);
