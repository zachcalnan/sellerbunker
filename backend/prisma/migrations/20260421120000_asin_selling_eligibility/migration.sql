-- ASIN-level selling eligibility (SP-API Listings Restrictions) for restock / gating decisions.
CREATE TABLE "asin_selling_eligibility" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "marketplace_id" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "can_restock" BOOLEAN NOT NULL DEFAULT false,
    "checked_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "raw_json" JSONB,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asin_selling_eligibility_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asin_selling_eligibility_user_id_marketplace_id_asin_key" ON "asin_selling_eligibility"("user_id", "marketplace_id", "asin");

CREATE INDEX "asin_selling_eligibility_user_id_checked_at_idx" ON "asin_selling_eligibility"("user_id", "checked_at");

CREATE INDEX "asin_selling_eligibility_user_id_can_restock_idx" ON "asin_selling_eligibility"("user_id", "can_restock");

ALTER TABLE "asin_selling_eligibility" ADD CONSTRAINT "asin_selling_eligibility_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
