-- Per-SKU hard list-price floor, applied on top of the assigned repricer rule.
-- Column may already exist from an earlier migration on this database.
ALTER TABLE "repricer_selected_skus"
ADD COLUMN IF NOT EXISTS "min_list_price" DECIMAL(14,2);
