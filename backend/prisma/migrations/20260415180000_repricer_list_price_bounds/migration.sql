-- Optional listing-price floor/ceiling per rule (listing currency, e.g. GBP).
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule1_min_list_price" DECIMAL(14,2);
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule1_max_list_price" DECIMAL(14,2);
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule2_min_list_price" DECIMAL(14,2);
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule2_max_list_price" DECIMAL(14,2);
