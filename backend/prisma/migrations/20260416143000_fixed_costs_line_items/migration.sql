-- Add optional JSONB line-item breakdowns for fixed costs (stored monthly).
ALTER TABLE "organizations"
ADD COLUMN IF NOT EXISTS "fixed_costs_software_items" JSONB,
ADD COLUMN IF NOT EXISTS "fixed_costs_other_subs_items" JSONB,
ADD COLUMN IF NOT EXISTS "fixed_costs_other_items" JSONB;

