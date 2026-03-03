-- AlterTable: replace category with productType and displayGroup
ALTER TABLE "products" DROP COLUMN IF EXISTS "category";
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "product_type" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "display_group" TEXT;
