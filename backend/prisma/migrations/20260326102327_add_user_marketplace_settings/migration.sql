-- CreateEnum
CREATE TYPE "MarketplaceRegion" AS ENUM ('NA', 'EU', 'AUSTRALASIA');

-- CreateEnum
CREATE TYPE "MarketplaceActivityClass" AS ENUM ('HIGH', 'MEDIUM', 'INACTIVE');

-- CreateTable
CREATE TABLE "user_marketplace_settings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "marketplace_id" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "region" "MarketplaceRegion" NOT NULL,
    "currency_code" TEXT NOT NULL,
    "is_base" BOOLEAN NOT NULL DEFAULT false,
    "is_enabled_by_user" BOOLEAN NOT NULL DEFAULT false,
    "detected_by_system" BOOLEAN NOT NULL DEFAULT false,
    "activity_class" "MarketplaceActivityClass" NOT NULL DEFAULT 'INACTIVE',
    "order_count_24h" INTEGER NOT NULL DEFAULT 0,
    "last_activity_check_at" TIMESTAMP(3),
    "next_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_marketplace_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_marketplace_settings_user_id_region_idx" ON "user_marketplace_settings"("user_id", "region");

-- CreateIndex
CREATE INDEX "user_marketplace_settings_user_id_is_enabled_by_user_idx" ON "user_marketplace_settings"("user_id", "is_enabled_by_user");

-- CreateIndex
CREATE UNIQUE INDEX "user_marketplace_settings_user_id_marketplace_id_key" ON "user_marketplace_settings"("user_id", "marketplace_id");

-- AddForeignKey
ALTER TABLE "user_marketplace_settings" ADD CONSTRAINT "user_marketplace_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
