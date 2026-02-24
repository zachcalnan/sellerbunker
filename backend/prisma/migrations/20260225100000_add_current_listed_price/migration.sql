-- Store this seller's current listed price (from Listings API). Updated on fee-estimate refresh; used for estimated fees/profit. Concluded fees/profit come from orders after sale.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "current_listed_price" DECIMAL(10,2);
