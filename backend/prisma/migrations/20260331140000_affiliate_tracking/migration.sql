-- Affiliate program: referred users, commissions, Stripe-backed payouts tracking

CREATE TYPE "AffiliateCommissionStatus" AS ENUM ('pending', 'paid');

CREATE TABLE "affiliates" (
    "id" TEXT NOT NULL,
    "referral_code" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "commission_rate" DECIMAL(7,4) NOT NULL DEFAULT 0.15,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "affiliates_referral_code_key" ON "affiliates"("referral_code");

CREATE TABLE "affiliate_commissions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "affiliate_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'gbp',
    "status" "AffiliateCommissionStatus" NOT NULL DEFAULT 'pending',
    "stripe_event_id" TEXT NOT NULL,
    "stripe_invoice_id" TEXT,
    "payment_number" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "affiliate_commissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "affiliate_commissions_stripe_event_id_key" ON "affiliate_commissions"("stripe_event_id");
CREATE INDEX "affiliate_commissions_affiliate_id_idx" ON "affiliate_commissions"("affiliate_id");
CREATE INDEX "affiliate_commissions_user_id_idx" ON "affiliate_commissions"("user_id");
CREATE INDEX "affiliate_commissions_status_idx" ON "affiliate_commissions"("status");

ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "users" ADD COLUMN "referred_by" TEXT;
ALTER TABLE "users" ADD COLUMN "referred_affiliate_id" TEXT;

ALTER TABLE "users" ADD CONSTRAINT "users_referred_affiliate_id_fkey" FOREIGN KEY ("referred_affiliate_id") REFERENCES "affiliates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
