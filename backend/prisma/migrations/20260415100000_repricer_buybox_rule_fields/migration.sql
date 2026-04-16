-- AlterTable
ALTER TABLE "repricer_rule_sets"
ADD COLUMN "rule1_strategy" TEXT,
ADD COLUMN "rule1_beat_type" TEXT,
ADD COLUMN "rule1_beat_value" DECIMAL(14,4),
ADD COLUMN "rule1_only_when_buy_box_fba" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "rule1_ignore_amazon" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "rule1_ignore_seller_ids" JSONB,
ADD COLUMN "rule1_min_seller_feedback_pct" DECIMAL(7,4),
ADD COLUMN "rule1_cooldown_minutes" INTEGER,
ADD COLUMN "rule1_smart_delay_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "rule2_strategy" TEXT,
ADD COLUMN "rule2_beat_type" TEXT,
ADD COLUMN "rule2_beat_value" DECIMAL(14,4),
ADD COLUMN "rule2_only_when_buy_box_fba" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "rule2_ignore_amazon" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "rule2_ignore_seller_ids" JSONB,
ADD COLUMN "rule2_min_seller_feedback_pct" DECIMAL(7,4),
ADD COLUMN "rule2_cooldown_minutes" INTEGER,
ADD COLUMN "rule2_smart_delay_enabled" BOOLEAN NOT NULL DEFAULT true;

