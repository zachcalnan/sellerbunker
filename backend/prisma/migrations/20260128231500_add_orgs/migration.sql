-- Add organizations + memberships, and active org pointer on users.

CREATE TABLE "organizations" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "organization_memberships" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'member',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "users"
  ADD COLUMN "active_org_id" TEXT;

CREATE UNIQUE INDEX "organization_memberships_org_id_user_id_key"
  ON "organization_memberships" ("org_id", "user_id");
CREATE INDEX "organization_memberships_user_id_idx"
  ON "organization_memberships" ("user_id");
CREATE INDEX "organization_memberships_org_id_idx"
  ON "organization_memberships" ("org_id");

ALTER TABLE "organization_memberships"
  ADD CONSTRAINT "organization_memberships_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "organization_memberships"
  ADD CONSTRAINT "organization_memberships_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "users"
  ADD CONSTRAINT "users_active_org_id_fkey"
  FOREIGN KEY ("active_org_id") REFERENCES "organizations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

