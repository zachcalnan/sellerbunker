-- Purchases / inbound costs ledger
CREATE TABLE "purchases" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,

  -- Metadata
  "fulfilment" TEXT NOT NULL DEFAULT 'Amazon',
  "supplier" TEXT,
  "purchase_date" TIMESTAMP(3) NOT NULL,
  "order_number" TEXT,
  "shipment_id" TEXT,

  -- Quantities
  "qty_purchased" INTEGER NOT NULL DEFAULT 0,
  "qty_delivered" INTEGER NOT NULL DEFAULT 0,

  -- Costs (inc VAT where applicable)
  "currency" TEXT NOT NULL DEFAULT 'GBP',
  "vat_rate_pct" DECIMAL(7,4) NOT NULL DEFAULT 0,
  "unit_cost_inc_vat" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "delivery_cost_inc_vat" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "prep_cost_inc_vat" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "total_cost_inc_vat" DECIMAL(14,2) NOT NULL DEFAULT 0,

  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

CREATE INDEX "purchases_user_id_idx" ON "purchases" ("user_id");
CREATE INDEX "purchases_user_id_purchase_date_idx" ON "purchases" ("user_id", "purchase_date");
CREATE INDEX "purchases_product_id_idx" ON "purchases" ("product_id");
CREATE INDEX "purchases_shipment_id_idx" ON "purchases" ("shipment_id");

ALTER TABLE "purchases"
  ADD CONSTRAINT "purchases_pkey" PRIMARY KEY ("id");

ALTER TABLE "purchases"
  ADD CONSTRAINT "purchases_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchases"
  ADD CONSTRAINT "purchases_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

