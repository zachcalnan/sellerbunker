-- Add org-level inventory sync timestamp + per-marketplace inventory breakdown table.

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "last_fba_inventory_sync_at" TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS "inventory_by_marketplace" (
  -- Keep IDs consistent with existing tables (TEXT ids; Prisma generates uuid strings)
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "marketplace_id" TEXT NOT NULL,

  "fulfillable_qty" INTEGER NOT NULL DEFAULT 0,
  "inbound_qty" INTEGER NOT NULL DEFAULT 0,
  "reserved_qty" INTEGER NOT NULL DEFAULT 0,
  "researching_qty" INTEGER NOT NULL DEFAULT 0,
  "unfulfillable_qty" INTEGER NOT NULL DEFAULT 0,
  "current_qty" INTEGER NOT NULL DEFAULT 0,

  "raw_json" JSONB,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "inventory_by_marketplace_pkey" PRIMARY KEY ("id")
);

-- Unique per product + marketplace (same across org members)
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_by_marketplace_product_id_marketplace_id_key"
  ON "inventory_by_marketplace" ("product_id", "marketplace_id");

CREATE INDEX IF NOT EXISTS "inventory_by_marketplace_user_id_idx"
  ON "inventory_by_marketplace" ("user_id");

CREATE INDEX IF NOT EXISTS "inventory_by_marketplace_product_id_idx"
  ON "inventory_by_marketplace" ("product_id");

-- Add FKs (idempotent). Postgres doesn't support IF NOT EXISTS for ADD CONSTRAINT.
DO $$
BEGIN
  ALTER TABLE "inventory_by_marketplace"
    ADD CONSTRAINT "inventory_by_marketplace_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "inventory_by_marketplace"
    ADD CONSTRAINT "inventory_by_marketplace_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END $$;

