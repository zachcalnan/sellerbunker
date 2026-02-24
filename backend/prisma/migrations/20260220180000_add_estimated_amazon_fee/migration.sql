-- Add estimated Amazon fee per unit to Product (for pre-sale fee display and order profit until actual fees settle).
-- Add last run timestamp for org-level fee estimate refresh (once per day).
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "estimated_amazon_fee_per_unit" DECIMAL(10,2);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "estimated_amazon_fee_updated_at" TIMESTAMP(3);

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "last_fees_estimate_at" TIMESTAMP(3);
