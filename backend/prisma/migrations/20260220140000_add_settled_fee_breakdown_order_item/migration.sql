-- AlterTable
ALTER TABLE "order_items" ADD COLUMN "settled_referral_fee_total" DECIMAL(14,2),
ADD COLUMN "settled_fba_fee_total" DECIMAL(14,2),
ADD COLUMN "settled_digital_service_fee_total" DECIMAL(14,2);
