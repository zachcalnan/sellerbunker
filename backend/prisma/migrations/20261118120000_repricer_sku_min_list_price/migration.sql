-- Per-SKU hard list-price floor, applied on top of the assigned repricer rule.
ALTER TABLE "repricer_selected_skus"
ADD COLUMN "min_list_price" DECIMAL(14,2);
