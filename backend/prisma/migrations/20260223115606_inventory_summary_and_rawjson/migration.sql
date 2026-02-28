/*
  Warnings:

  - You are about to drop the column `last_fba_inventory_sync_at` on the `organizations` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "inventory_by_marketplace_product_id_idx";

-- AlterTable (IF NOT EXISTS for robustness if columns already exist)
ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "inbound_qty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "reserved_qty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory" ALTER COLUMN "raw_json" DROP DEFAULT;

-- AlterTable
ALTER TABLE "organizations" DROP COLUMN "last_fba_inventory_sync_at",
ADD COLUMN     "lastFbaInventorySyncAt" TIMESTAMP(3);
