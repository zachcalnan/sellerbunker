-- AlterTable
ALTER TABLE "order_items" ADD COLUMN "amazon_fees_ex_vat" DECIMAL(14,2), ADD COLUMN "amazon_fees_inc_vat" DECIMAL(14,2), ADD COLUMN "amazon_fees_vat_amount" DECIMAL(14,2);
