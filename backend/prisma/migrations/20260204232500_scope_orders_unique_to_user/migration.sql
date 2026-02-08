-- Fix tenancy: Orders must be unique per user.
-- Previously, the unique constraint was global on (order_id, marketplace),
-- which caused different users/orgs to overwrite each other's orders during sync.

DROP INDEX IF EXISTS "orders_order_id_marketplace_key";

CREATE UNIQUE INDEX IF NOT EXISTS "orders_user_id_order_id_marketplace_key"
ON "orders"("user_id", "order_id", "marketplace");

