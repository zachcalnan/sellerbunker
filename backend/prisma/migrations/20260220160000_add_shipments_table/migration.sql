-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "shipment_name" TEXT,
    "shipment_status" TEXT,
    "destination_fulfillment_center_id" TEXT,
    "created_date" TIMESTAMP(3),
    "last_updated_date" TIMESTAMP(3),
    "units_sent" INTEGER NOT NULL DEFAULT 0,
    "units_received" INTEGER NOT NULL DEFAULT 0,
    "units_damaged" INTEGER NOT NULL DEFAULT 0,
    "units_disposed" INTEGER NOT NULL DEFAULT 0,
    "units_missing" INTEGER NOT NULL DEFAULT 0,
    "pickup_date" TIMESTAMP(3),
    "transport_status" TEXT,
    "delivery_date" TIMESTAMP(3),
    "damage_closed_date" TIMESTAMP(3),
    "check_in_duration_days" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_user_id_shipment_id_key" ON "shipments"("user_id", "shipment_id");

-- CreateIndex
CREATE INDEX "shipments_user_id_idx" ON "shipments"("user_id");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
