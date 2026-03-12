# Sync bar works in live but stuck at 0% locally

## Workaround: redirect includes sync_progress_api

When you connect Amazon from **localhost** but your `AMAZON_REDIRECT_URI` points at **production**, Amazon sends the OAuth callback to production. The production callback then redirects your browser back to localhost (using `returnOrigin` in state). So you land on localhost, but the sync job and progress live on **production**.

To fix the bar in that case, the **production** callback now appends `sync_progress_api=<production API base URL>` to the redirect when it sends you to a different origin (e.g. localhost). The frontend reads this and polls that URL for sync progress instead of your local API, so the bar moves.

- **No config needed** if your production API is on the same host as the redirect (e.g. `AMAZON_REDIRECT_URI=https://www.sellerbunker.com/...` and API at `https://www.sellerbunker.com`). The backend derives the base URL from `AMAZON_REDIRECT_URI`.
- **Set `PUBLIC_API_URL`** on the backend that runs the callback (e.g. production) if your API is on a different host (e.g. `https://api.sellerbunker.com`). Then the redirect will use that for `sync_progress_api`.

---

## Why it used to stay at 0%

If the sync progress bar works in production but stays at **0%** when you run the app locally, the usual cause is:

**The OAuth redirect and the API are using different backends.**

- **Production:** Amazon redirects to your production backend → that backend sets Redis and enqueues the full-sync job → your frontend (production) polls the **same** backend → job and Redis are there → bar moves.
- **Local:** If `AMAZON_REDIRECT_URI` in your backend `.env` points at **production** (e.g. `https://api.sellerbunker.com/api/amazon/oauth/callback`), then when you “Connect Amazon” from localhost:
  1. Amazon redirects to **production** → production runs the callback, sets Redis and the job **on production**.
  2. Your browser then loads **localhost** (e.g. `http://localhost:3000/dashboard?amazon_connected=1`).
  3. The frontend polls **localhost** API (e.g. `NEXT_PUBLIC_API_URL=http://localhost:3001`).
  4. Your **local** backend has its own Redis/queue and never ran the callback → no job, no `amazon-initial-sync:${userId}` key → API returns `progress=0 from=default` every time → bar stuck at 0%.

So the backend that **receives the redirect** must be the **same** backend that **serves GET /api/amazon/sync-progress**.

## Fix for local dev

Use **one** of these:

### Option A: OAuth callback hits your local backend (recommended)

1. Expose your local backend with a public URL (e.g. **ngrok**: `ngrok http 3001`).
2. In backend **.env** for local, set:
   - `AMAZON_REDIRECT_URI=https://your-ngrok-url.ngrok.io/api/amazon/oauth/callback`
3. In Amazon Seller Central / SP-API app config, add that same URL as an allowed redirect URI (if required).
4. Run backend and frontend locally; set `NEXT_PUBLIC_API_URL` to your **local** backend (e.g. `http://localhost:3001`).
5. Connect Amazon from localhost → redirect goes to ngrok → your **local** backend runs the callback, sets **local** Redis and enqueues the job on **local** queue → frontend polls localhost → same backend → bar works.

### Option B: Use production API from local frontend (no bar locally)

- Set `NEXT_PUBLIC_API_URL` to your **production** API URL.
- Connect Amazon from localhost: redirect still goes to production, and your local frontend now polls **production** for sync-progress → same backend that ran the callback → bar works.
- Downside: all API calls (including sync-progress) go to production while you develop.

### Option C: Use the built-in workaround (default now)

- When the callback runs on production and redirects you to localhost, it appends `sync_progress_api` to the URL. The frontend then polls that API for progress, so the bar should move without any env changes. If your API is on a different host than the redirect (e.g. api.sellerbunker.com), set `PUBLIC_API_URL` on the backend that runs the callback.

### Option C2: Override sync-progress API in the frontend (redirect URI = production)

- If your redirect URI points at **live** (e.g. sellerbunker.com) and you run frontend/API locally, the callback runs on production so the job lives there. The bar will stay at 0% because it polls localhost.
- **Fix (frontend):** In the **frontend** `.env.local`, set:
  - `NEXT_PUBLIC_SYNC_PROGRESS_API=https://api.sellerbunker.com`  
  (use your real production API base URL, no trailing slash.)
- Then the sync bar will poll **that** URL for progress (only for the sync-progress endpoint). The rest of the app still uses `NEXT_PUBLIC_API_URL` (e.g. localhost:3001).
- **Fix (production CORS):** The browser sends the request from `http://localhost:3000`. Production API must allow that origin or the request is blocked (CORS) and the bar stays at 0%. On the **production** backend, set:
  - `CORS_ORIGINS=http://localhost:3000`  
  (or add it to the existing env; see `backend/src/main.ts` – it merges `CORS_ORIGINS` into the allowed list.)
- Restart the Next dev server after changing `.env.local`. If you see `[sync-progress] fetch failed (CORS or network?)` in the browser console, CORS on production is the blocker.

### Option D: Ignore the bar when developing locally

- Keep developing against local backend; accept that the sync bar will stay at 0% locally if the callback hits production and the workaround doesn’t apply (e.g. API not reachable from browser).
- Verify sync bar behaviour in a deployed (staging/production) environment.

## Quick check

When you connect Amazon from localhost, look at the **URL in the browser** right after Amazon redirects you back. Is it:

- `http://localhost:3000/dashboard?amazon_connected=1` (or similar with a local host)?
- Or `https://your-production-domain.com/...`?

If it’s production, your **callback ran on production**. If your frontend then calls `http://localhost:3001/api/amazon/sync-progress`, that’s a **different** backend → no job/Redis there → bar stays at 0%.

## Redis and worker

- Backend and BullMQ worker run in the **same** Nest process (`nest start --watch`), so the worker runs when you run the backend. No separate worker process needed locally.
- Redis: default is `redis://localhost:6379`. If Redis isn’t running locally, the queue and `amazon-initial-sync:*` keys won’t work. Install and start Redis (e.g. Docker: `docker run -p 6379:6379 redis`) for local dev.
