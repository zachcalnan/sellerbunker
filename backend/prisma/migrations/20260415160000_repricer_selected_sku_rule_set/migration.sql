-- Per-SKU assignment to a saved pricing preset (FK must match TEXT ids on repricer_rule_sets)

-- Recover from a failed attempt that used UUID instead of TEXT
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'repricer_selected_skus'
      AND c.column_name = 'rule_set_id'
      AND c.data_type <> 'text'
  ) THEN
    ALTER TABLE "repricer_selected_skus" DROP COLUMN "rule_set_id";
  END IF;
END $$;

ALTER TABLE "repricer_selected_skus" ADD COLUMN IF NOT EXISTS "rule_set_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repricer_selected_skus_rule_set_id_fkey'
  ) THEN
    ALTER TABLE "repricer_selected_skus"
      ADD CONSTRAINT "repricer_selected_skus_rule_set_id_fkey"
      FOREIGN KEY ("rule_set_id") REFERENCES "repricer_rule_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "repricer_selected_skus_rule_set_id_idx" ON "repricer_selected_skus"("rule_set_id");

-- Backfill: prefer active preset per org
UPDATE "repricer_selected_skus" rss
SET "rule_set_id" = x."id"
FROM (
  SELECT DISTINCT ON ("org_id") "id", "org_id"
  FROM "repricer_rule_sets"
  WHERE "is_active" = true
  ORDER BY "org_id", "updated_at" DESC
) x
WHERE rss."org_id" = x."org_id" AND rss."rule_set_id" IS NULL;

-- Fallback: latest preset per org
UPDATE "repricer_selected_skus" rss
SET "rule_set_id" = x."id"
FROM (
  SELECT DISTINCT ON ("org_id") "id", "org_id"
  FROM "repricer_rule_sets"
  ORDER BY "org_id", "updated_at" DESC
) x
WHERE rss."org_id" = x."org_id" AND rss."rule_set_id" IS NULL;
