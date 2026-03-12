# How the sync progress bar gets 0%, 1%, 25%, etc.

This doc traces **when** each percentage is set and **how** the UI ends up showing it. Use it to see where the chain can break.

---

## 1. Who writes the percentage?

**Backend only.** Progress is written in **three** places so the bar keeps working even if Redis/job are missing:

| Step | Who | Where | Value |
|------|-----|--------|--------|
| User connects Amazon | `AmazonSyncService.enqueueFullSync()` | **DB** `initial_sync_progress` + Redis | **0** |
| Worker starts | `AmazonSyncProcessor` (full-sync job) | `setProgress(0)` then `setProgress(1)` | **0**, then **1** |
| Orders phase | Same processor | `syncRecentOrdersToDb(..., { onProgress: setProgress })` + `setProgress(25)` after | **2, 5, 6…25** |
| Inventory done | Same processor | `setProgress(50)` | **50** |
| Shipments done | Same processor | `setProgress(75)` | **75** |
| Job finished | Same processor | `setProgress(100)` | **100** |

`setProgress(p)` in the processor does:

1. `job.updateProgress(p)` → BullMQ job’s `progress` field.
2. `setCoreSyncProgress(userId, p)` → Redis key `amazon-initial-sync:${userId}`.
3. `amazonSyncService.setInitialSyncProgressInDb(userId, p)` → **DB** `initial_sync_progress` (single source of truth).

So **0 → 1** happens in the processor as soon as the full-sync job **starts** (first two lines after "Starting"):

```ts
// backend/src/amazon/amazon-sync.processor.ts (full-sync block)
await setProgress(0);
await setProgress(1);
// then orders, 25, 50, 75, 100...
```

---

## 2. Who reads the percentage?

**GET /api/amazon/sync-progress** (controller calls `AmazonSyncService.getSyncProgress(userId)`).

Logic in `getSyncProgress()`:

1. **Always** read **DB** `initial_sync_progress` for this user (source of truth).
2. **Job exists and is `active` or `waiting`:**
   - Use **job.progress** (live 0, 1, 2… 25, 50, 75, 100).
   - If that’s not a number: use **0**.
3. **Job exists but completed/failed:**
   - Use **DB row** if present, else Redis, else **100**.
4. **No job** (e.g. removed after complete or never enqueued):
   - Use **DB row** if present, else Redis, else **0** (so the bar always shows and keeps polling).

So **moving from 0% to 1%** in the API response means the **job** is `active` and the worker has run `setProgress(1)` (job + Redis + DB are all updated). If the job is gone, we use DB (or Redis, or 0) so the bar still shows a sensible value.

---

## 3. When does the frontend show 0% vs 1%?

**Topbar** polls **GET /api/amazon/sync-progress** every **1.2s** (and once at 800ms).

- It sends `Authorization: Bearer <Clerk token>`.
- Backend resolves `userId` from the token (ClerkAuthGuard) and calls `getSyncProgress(req.user.userId)`.

When the response is OK:

- It reads `data.progress` and clamps to 0–100.
- It does `setSyncProgress(progressNum)`.
- The bar and label use `visibleSyncProgress` (= `syncProgress ?? 0`), so the UI shows that number (e.g. **0%** or **1%**).

So **the bar moves from 0% to 1%** when:

1. The **worker** has run `setProgress(1)` (so either job.progress or Redis is 1).
2. The **next poll** hits GET /sync-progress with the **same userId** the job used.
3. The request **succeeds** (2xx) and the frontend **applies** `data.progress`.

If it stays on 0%, one of these is failing:

- Worker never runs or never calls `setProgress(1)` (e.g. old code, job not started, crash before that line).
- API uses a **different userId** than the job (e.g. token → different user than OAuth state).
- Request fails (4xx/5xx) or no token → frontend doesn’t update.
- Frontend doesn’t call the API (e.g. not signed in, or `getToken()` returns null).

---

## 4. Quick checklist: “Why is it stuck at 0%?”

| Check | Where |
|-------|--------|
| Is the full-sync job running? | Backend logs: `[full-sync] Starting for userId=...` and `[full-sync] progress 1%` |
| Is the API being called? | Backend logs: `[sync-progress] GET received userId=...` and `progress=X` |
| Same user? | Job is `full-sync-${userId}`; API uses `req.user.userId` from JWT. They must match (same Prisma user id). |
| Redis shared? | Worker and API must see the same Redis (same process or same Redis URL). |

---

## 5. File reference

| What | File |
|------|------|
| Enqueue + set 0 in Redis | `backend/src/amazon/amazon-sync.service.ts` → `enqueueFullSync()` |
| Write 0, 1, 25, 50, 75, 100 | `backend/src/amazon/amazon-sync.processor.ts` → full-sync block, `setProgress()` |
| Read progress, return to API | `backend/src/amazon/amazon-sync.service.ts` → `getSyncProgress()` |
| GET endpoint | `backend/src/amazon/amazon.controller.ts` → `getSyncProgress()` |
| Poll + set state + bar | `frontend/components/topbar.tsx` → `fetchSyncProgress`, `syncProgress`, bar % |
