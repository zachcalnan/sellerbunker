-- CreateTable
CREATE TABLE "repricer_selected_skus" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "repricer_selected_skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repricer_rule_sets" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "rule1_min_profit" DECIMAL(14,2),
    "rule1_min_roi_pct" DECIMAL(7,4),
    "rule1_max_roi_pct" DECIMAL(7,4),
    "rule1_ends_at" TIMESTAMP(3),
    "rule2_min_profit" DECIMAL(14,2),
    "rule2_min_roi_pct" DECIMAL(7,4),
    "rule2_max_roi_pct" DECIMAL(7,4),
    "rule2_ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "repricer_rule_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repricer_logs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'decision',
    "message" TEXT NOT NULL,
    "prev_price" DECIMAL(10,2),
    "next_price" DECIMAL(10,2),
    "context" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "repricer_logs_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "repricer_selected_skus_org_id_product_id_key" ON "repricer_selected_skus"("org_id", "product_id");
CREATE INDEX "repricer_selected_skus_org_id_idx" ON "repricer_selected_skus"("org_id");
CREATE INDEX "repricer_selected_skus_product_id_idx" ON "repricer_selected_skus"("product_id");

CREATE INDEX "repricer_rule_sets_org_id_idx" ON "repricer_rule_sets"("org_id");

CREATE INDEX "repricer_logs_org_id_idx" ON "repricer_logs"("org_id");
CREATE INDEX "repricer_logs_product_id_idx" ON "repricer_logs"("product_id");
CREATE INDEX "repricer_logs_org_id_created_at_idx" ON "repricer_logs"("org_id", "created_at");

-- Foreign keys
ALTER TABLE "repricer_selected_skus"
ADD CONSTRAINT "repricer_selected_skus_product_id_fkey"
FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "repricer_logs"
ADD CONSTRAINT "repricer_logs_product_id_fkey"
FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

