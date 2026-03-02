-- Add granular inventory status columns to inventory_by_marketplace (from FBA API details breakdown)
ALTER TABLE "inventory_by_marketplace" ADD COLUMN IF NOT EXISTS "fc_processing_qty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory_by_marketplace" ADD COLUMN IF NOT EXISTS "customer_orders_qty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory_by_marketplace" ADD COLUMN IF NOT EXISTS "transshipment_qty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory_by_marketplace" ADD COLUMN IF NOT EXISTS "inbound_working_qty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory_by_marketplace" ADD COLUMN IF NOT EXISTS "inbound_shipped_qty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory_by_marketplace" ADD COLUMN IF NOT EXISTS "inbound_receiving_qty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory_by_marketplace" ADD COLUMN IF NOT EXISTS "warehouse_damaged_qty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory_by_marketplace" ADD COLUMN IF NOT EXISTS "expired_qty" INTEGER NOT NULL DEFAULT 0;
