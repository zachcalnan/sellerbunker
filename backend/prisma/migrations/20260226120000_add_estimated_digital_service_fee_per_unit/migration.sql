-- Add estimated digital service fee per unit (from Product Fees API FeeDetailList, e.g. VariableClosingFee).
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "estimated_digital_service_fee_per_unit" DECIMAL(10,2);
