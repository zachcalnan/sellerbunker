-- Per-SKU lines for FBA inbound shipments (sent vs received).
CREATE TABLE "shipment_item_lines" (
    "id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "seller_sku" TEXT NOT NULL DEFAULT '',
    "fnsku" TEXT NOT NULL DEFAULT '',
    "asin" TEXT,
    "product_title" TEXT,
    "quantity_shipped" INTEGER NOT NULL DEFAULT 0,
    "quantity_received" INTEGER NOT NULL DEFAULT 0,
    "quantity_damaged" INTEGER NOT NULL DEFAULT 0,
    "quantity_disposed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shipment_item_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shipment_item_lines_shipment_id_seller_sku_fnsku_key" ON "shipment_item_lines"("shipment_id", "seller_sku", "fnsku");

CREATE INDEX "shipment_item_lines_shipment_id_idx" ON "shipment_item_lines"("shipment_id");

ALTER TABLE "shipment_item_lines" ADD CONSTRAINT "shipment_item_lines_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
