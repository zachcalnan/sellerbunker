-- AlterTable
ALTER TABLE "shipments" ADD COLUMN "checked_in_date" TIMESTAMP(3),
ADD COLUMN "checked_in_date_is_closed_date" BOOLEAN;
