-- AlterTable Organization: VAT settings
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "vat_registration_type" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "vat_effective_date" TIMESTAMP(3);
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "vat_flat_rate_pct" DECIMAL(7,4);
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "vat_rate_pct" DECIMAL(7,4);
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "vat_costs_include_vat" BOOLEAN;

-- AlterTable OrderItem: VAT breakdown (revenue + costs inc/excl)
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "sale_price_inc_vat" DECIMAL(14,2);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "sale_price_ex_vat" DECIMAL(14,2);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "sale_vat_amount" DECIMAL(14,2);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "estimated_sale_price_inc_vat" DECIMAL(14,2);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "estimated_sale_price_ex_vat" DECIMAL(14,2);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "estimated_sale_vat_amount" DECIMAL(14,2);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "unit_cost_inc_vat" DECIMAL(14,2);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "unit_cost_ex_vat" DECIMAL(14,2);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "unit_vat_amount" DECIMAL(14,2);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "delivery_inc_vat" DECIMAL(14,2);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "delivery_ex_vat" DECIMAL(14,2);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "delivery_vat_amount" DECIMAL(14,2);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "prep_inc_vat" DECIMAL(14,2);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "prep_ex_vat" DECIMAL(14,2);
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "prep_vat_amount" DECIMAL(14,2);

-- AlterTable Purchase: costs excl VAT + toggle
ALTER TABLE "purchases" ADD COLUMN IF NOT EXISTS "costs_entered_incl_vat" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "purchases" ADD COLUMN IF NOT EXISTS "unit_cost_ex_vat" DECIMAL(14,2);
ALTER TABLE "purchases" ADD COLUMN IF NOT EXISTS "delivery_cost_ex_vat" DECIMAL(14,2);
ALTER TABLE "purchases" ADD COLUMN IF NOT EXISTS "prep_cost_ex_vat" DECIMAL(14,2);
ALTER TABLE "purchases" ADD COLUMN IF NOT EXISTS "total_cost_ex_vat" DECIMAL(14,2);
