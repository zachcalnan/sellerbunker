-- Scheduled phone push reminders (cancel trial, etc.)
CREATE TABLE "push_alerts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "fire_at" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sent_at" TIMESTAMP(3),
    "job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_alerts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "push_alerts_user_id_status_fire_at_idx" ON "push_alerts"("user_id", "status", "fire_at");
CREATE INDEX "push_alerts_status_fire_at_idx" ON "push_alerts"("status", "fire_at");

ALTER TABLE "push_alerts" ADD CONSTRAINT "push_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
