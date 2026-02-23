-- Inventory: summary buckets (available, reserved, inbound, issue, total) + rawJson for modal drilldown.
-- Primary key becomes product_id; id column removed.

-- Add new bucket columns if not present (idempotent for existing tables that already have some)
ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "available_qty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "issue_qty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "total_qty" INTEGER NOT NULL DEFAULT 0;

-- Backfill from old column names (when they exist)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'inventory' AND column_name = 'fulfillable_qty') THEN
    UPDATE "inventory" SET "available_qty" = COALESCE("fulfillable_qty", 0);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'inventory' AND column_name = 'researching_qty') AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'inventory' AND column_name = 'unfulfillable_qty') THEN
    UPDATE "inventory" SET "issue_qty" = COALESCE("researching_qty", 0) + COALESCE("unfulfillable_qty", 0);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'inventory' AND column_name = 'current_qty') THEN
    UPDATE "inventory" SET "total_qty" = COALESCE("current_qty", 0);
  END IF;
END $$;

-- Ensure raw_json column exists (older migrations may not have it)
ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "raw_json" JSONB DEFAULT '[]'::jsonb;
-- Ensure raw_json has a value so we can make it NOT NULL
UPDATE "inventory" SET "raw_json" = COALESCE("raw_json", '[]'::jsonb) WHERE "raw_json" IS NULL;

-- Make raw_json required
ALTER TABLE "inventory" ALTER COLUMN "raw_json" SET NOT NULL;

-- Drop old columns if they exist
ALTER TABLE "inventory" DROP COLUMN IF EXISTS "fulfillable_qty";
ALTER TABLE "inventory" DROP COLUMN IF EXISTS "current_qty";
ALTER TABLE "inventory" DROP COLUMN IF EXISTS "researching_qty";
ALTER TABLE "inventory" DROP COLUMN IF EXISTS "unfulfillable_qty";

-- Replace primary key: drop old PK and id, make product_id the primary key
ALTER TABLE "inventory" DROP CONSTRAINT IF EXISTS "inventory_pkey";
ALTER TABLE "inventory" DROP COLUMN IF EXISTS "id";
DROP INDEX IF EXISTS "inventory_product_id_key";
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_pkey" PRIMARY KEY ("product_id");
