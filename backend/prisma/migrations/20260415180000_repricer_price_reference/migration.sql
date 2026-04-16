-- buy_box vs best_offer (lowest competitive) as the reference for match/beat/stay strategies
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule1_price_reference" TEXT NOT NULL DEFAULT 'buy_box';
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule2_price_reference" TEXT NOT NULL DEFAULT 'buy_box';
