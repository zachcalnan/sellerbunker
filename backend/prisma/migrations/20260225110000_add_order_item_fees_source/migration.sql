-- Track whether order item fees are settled (Finances API) or estimated. Never overwrite settled with estimate.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "fees_source" TEXT;
