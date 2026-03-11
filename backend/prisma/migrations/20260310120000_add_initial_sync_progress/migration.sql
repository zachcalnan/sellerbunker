-- CreateTable
CREATE TABLE "initial_sync_progress" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "progress" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "initial_sync_progress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "initial_sync_progress_user_id_key" ON "initial_sync_progress"("user_id");

-- AddForeignKey
ALTER TABLE "initial_sync_progress" ADD CONSTRAINT "initial_sync_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
