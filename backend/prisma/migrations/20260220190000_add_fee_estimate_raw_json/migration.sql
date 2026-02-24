-- Add raw fee estimate API response to Product for debugging (FeeDetailList, TotalFeesEstimate, etc.).
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "fee_estimate_raw_json" JSONB;
