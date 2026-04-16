-- AlterTable
ALTER TABLE "repricer_logs" ADD COLUMN "last_checked_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "repricer_logs_org_id_product_id_idx" ON "repricer_logs"("org_id", "product_id");
