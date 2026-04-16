-- AlterTable
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule1_label" TEXT;
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule2_label" TEXT;
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule1_ignore_fbm" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule2_ignore_fbm" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule1_ignore_seller_views_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule1_ignore_seller_views_below" INTEGER;
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule2_ignore_seller_views_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "rule2_ignore_seller_views_below" INTEGER;
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "chain_after_days" INTEGER;
ALTER TABLE "repricer_rule_sets" ADD COLUMN IF NOT EXISTS "follow_up_rule_set_id" TEXT;

-- AddForeignKey
DO $$ BEGIN
 ALTER TABLE "repricer_rule_sets" ADD CONSTRAINT "repricer_rule_sets_follow_up_rule_set_id_fkey" FOREIGN KEY ("follow_up_rule_set_id") REFERENCES "repricer_rule_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "repricer_rule_sets_follow_up_rule_set_id_idx" ON "repricer_rule_sets"("follow_up_rule_set_id");
