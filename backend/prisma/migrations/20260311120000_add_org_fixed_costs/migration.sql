-- AlterTable
ALTER TABLE "organizations" ADD COLUMN "fixed_costs_software" DECIMAL(14,2),
ADD COLUMN "fixed_costs_other_subs" DECIMAL(14,2),
ADD COLUMN "fixed_costs_other" DECIMAL(14,2);
