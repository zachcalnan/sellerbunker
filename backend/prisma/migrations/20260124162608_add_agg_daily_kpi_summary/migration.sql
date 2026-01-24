-- CreateTable
CREATE TABLE "agg_daily_kpi_summary" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "fulfilment_channel" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "revenue" DECIMAL(14,2) NOT NULL,
    "unitsSold" INTEGER NOT NULL,
    "orders_count" INTEGER NOT NULL,
    "amazon_fees_total" DECIMAL(14,2) NOT NULL,
    "refunds_total" DECIMAL(14,2) NOT NULL,
    "cogs_total" DECIMAL(14,2) NOT NULL,
    "prep_fees_total" DECIMAL(14,2) NOT NULL,
    "shipping_costs_total" DECIMAL(14,2) NOT NULL,
    "advertising_total" DECIMAL(14,2) NOT NULL,
    "vat_on_amazon_fees_total" DECIMAL(14,2) NOT NULL,
    "vat_estimate_total" DECIMAL(14,2) NOT NULL,
    "software_subs_total" DECIMAL(14,2) NOT NULL,
    "other_subs_total" DECIMAL(14,2) NOT NULL,
    "vat_total" DECIMAL(14,2) NOT NULL,
    "other_costs_total" DECIMAL(14,2) NOT NULL,
    "profit" DECIMAL(14,2) NOT NULL,
    "roi_pct" DECIMAL(7,4) NOT NULL,
    "margin_pct" DECIMAL(7,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agg_daily_kpi_summary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agg_daily_kpi_summary_user_id_idx" ON "agg_daily_kpi_summary"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "agg_daily_kpi_summary_user_id_marketplace_fulfilment_channe_key" ON "agg_daily_kpi_summary"("user_id", "marketplace", "fulfilment_channel", "date");
