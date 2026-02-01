-- Add OrderItem table for accurate per-product analytics
CREATE TABLE "order_items" (
  -- NOTE: existing tables in this project use TEXT ids (String @default(uuid()) without @db.Uuid).
  -- Keep FK column types compatible with users/orders/products.
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "order_db_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "order_item_id" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "asin" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "revenue_total" DECIMAL(14,2) NOT NULL,
  "shipping_charged_total" DECIMAL(14,2) NOT NULL,
  "tax_charged_total" DECIMAL(14,2) NOT NULL,
  "amazon_fees_total" DECIMAL(14,2) NOT NULL,
  "cogs_total" DECIMAL(14,2),
  "profit" DECIMAL(14,2),
  "raw_response" JSONB,
  "order_date" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_items_order_db_id_order_item_id_key"
  ON "order_items" ("order_db_id", "order_item_id");
CREATE INDEX "order_items_user_id_idx" ON "order_items" ("user_id");
CREATE INDEX "order_items_user_id_order_date_idx" ON "order_items" ("user_id", "order_date");
CREATE INDEX "order_items_product_id_idx" ON "order_items" ("product_id");

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_order_db_id_fkey"
  FOREIGN KEY ("order_db_id") REFERENCES "orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

