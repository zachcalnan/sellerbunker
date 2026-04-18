-- AlterTable
ALTER TABLE "order_items" ADD COLUMN "at_sale_estimate_referral_fee_total" DECIMAL(14,2),
ADD COLUMN "at_sale_estimate_fba_fee_total" DECIMAL(14,2),
ADD COLUMN "at_sale_estimate_digital_service_fee_total" DECIMAL(14,2);
