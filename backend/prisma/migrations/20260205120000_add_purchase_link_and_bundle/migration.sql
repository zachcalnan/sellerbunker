-- Add supplier link + bundle size to purchases ledger.
ALTER TABLE "purchases"
  ADD COLUMN "supplier_link" TEXT,
  ADD COLUMN "bundle_size" INTEGER NOT NULL DEFAULT 1;

