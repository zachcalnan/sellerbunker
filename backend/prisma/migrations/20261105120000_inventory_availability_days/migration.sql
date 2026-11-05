-- Daily Amazon fulfillable snapshots for replenish demand (units / in-stock days).
CREATE TABLE "inventory_availability_days" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "available_qty" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_availability_days_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_availability_days_product_id_day_key" ON "inventory_availability_days"("product_id", "day");
CREATE INDEX "inventory_availability_days_user_id_day_idx" ON "inventory_availability_days"("user_id", "day");
CREATE INDEX "inventory_availability_days_product_id_day_idx" ON "inventory_availability_days"("product_id", "day");

ALTER TABLE "inventory_availability_days" ADD CONSTRAINT "inventory_availability_days_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_availability_days" ADD CONSTRAINT "inventory_availability_days_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
