-- Idempotent: fixes DBs where max-profit columns were never added (e.g. empty migration applied before ALTER).
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule1_max_profit" DECIMAL(14,2);
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule2_max_profit" DECIMAL(14,2);
