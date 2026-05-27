-- Track successful Brevo contact upsert (retry on next login if null).
ALTER TABLE "users" ADD COLUMN "brevo_synced_at" TIMESTAMP(3);
