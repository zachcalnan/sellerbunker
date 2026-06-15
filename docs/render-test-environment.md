# Render Test Environment

This repo now includes a Render Blueprint at `render.yaml` plus test-focused env templates in `backend/.env.render.example` and `frontend/.env.render.example`.

The goal is to give you a second environment that is safe to wipe, reconnect, and re-sync without touching production data, queues, or auth state.

## What The Blueprint Creates

Import `render.yaml` into Render to create:

- `seller-bunker-test-backend`
- `seller-bunker-test-frontend`
- `seller-bunker-test-db`
- `seller-bunker-test-redis`

The backend is wired to:

- use the test Postgres instance for `DATABASE_URL`
- use the test Redis instance for `REDIS_URL`
- run Prisma migrations before each deploy with `npm run db:deploy`
- keep `ENABLE_AMAZON_SYNC_SCHEDULER=false` by default so test jobs do not start automatically
- bypass billing with `BYPASS_BILLING=true` so test users can reach the dashboard without Stripe

The frontend is wired to:

- call `https://seller-bunker-test-backend.onrender.com` via `NEXT_PUBLIC_API_URL`
- use `https://seller-bunker-test-frontend.onrender.com` as `NEXT_PUBLIC_APP_URL`

## Exact Env Var Inventory

These are the env vars currently used by the app code or required by the frameworks it depends on.

### Backend

Required now for a basic isolated test stack:

- `DATABASE_URL`
- `REDIS_URL`
- `FRONTEND_URL`
- `JWT_SECRET`
- `ENABLE_AMAZON_SYNC_SCHEDULER`
- `BYPASS_BILLING`

Required now if test sign-in is enabled with Clerk:

- `CLERK_SECRET_KEY`

Optional now:

- `CORS_ORIGINS`
- `PORT`
- `JWT_EXPIRES_IN`

Optional later for Amazon OAuth and SP-API:

- `AMAZON_APP_ID`
- `AMAZON_REDIRECT_URI`
- `LWA_CLIENT_ID`
- `LWA_CLIENT_SECRET`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_ROLE_ARN`
- `SPAPI_USE_SANDBOX`
- `SPAPI_DEBUG_LOGS`
- `SPAPI_THROTTLE_MS`

Optional sync tuning (defaults are tiered — hot orders every 5 min; most other jobs nightly):

- `AMAZON_ORDERS_HOT_SYNC_EVERY_MS` — recent orders only (default 5 min)
- `AMAZON_ORDERS_FULL_SYNC_CRON` — full 30d orders + finances (default `0 2 * * *`)
- `AMAZON_INVENTORY_SYNC_CRON` — FBA inventory (default `0 3 * * *`)
- `AMAZON_SHIPMENTS_SYNC_CRON` — inbound shipments (default `0 4 * * *`)
- `AMAZON_TITLES_BACKFILL_CRON` — product titles/images (default `0 5 * * *`)
- `FEE_ESTIMATE_REFRESH_CRON` — Product Fees API (default `0 6 * * *`)
- `LISTING_PRICE_REFRESH_HOT_EVERY_MS` — in-stock / recently sold prices (default 30 min)
- `LISTING_PRICE_REFRESH_COLD_CRON` — other SKU list prices (default `0 7 * * *`)

Optional later for Stripe and webhook handling:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `CLERK_WEBHOOK_SECRET`

Compatibility fallback already supported in code:

- `CLERK_SECRETKEY`

### Frontend

Required now for a basic isolated test stack:

- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_BYPASS_BILLING`

Required now if test sign-in is enabled with Clerk:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`

Optional later for Stripe:

- `STRIPE_SECRET_KEY`
- `STRIPE_BASIC_PLAN_PRODUCT_ID`

Optional later for Clerk webhook handling:

- `CLERK_WEBHOOK_SIGNING_SECRET`
- `CLERK_WEBHOOK_SECRET`

Optional later for contact email:

- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`

## Bootstrap Order

1. In Render, create the Blueprint from `render.yaml`.
2. Let Render provision the four resources.
3. Fill any `sync: false` secrets in the Render dashboard for both services.
4. Deploy the backend first and confirm `https://seller-bunker-test-backend.onrender.com/api` responds.
5. Deploy the frontend and confirm it loads and points at the test backend.
6. Verify the backend is using the test Postgres and test Redis only.

## URL Wiring

These values are intentionally prewired in `render.yaml`:

- backend `FRONTEND_URL` -> `https://seller-bunker-test-frontend.onrender.com`
- frontend `NEXT_PUBLIC_API_URL` -> `https://seller-bunker-test-backend.onrender.com`
- frontend `NEXT_PUBLIC_APP_URL` -> `https://seller-bunker-test-frontend.onrender.com`
- backend `BYPASS_BILLING` -> `true`
- frontend `NEXT_PUBLIC_BYPASS_BILLING` -> `true`
- backend `AMAZON_REDIRECT_URI` -> `https://seller-bunker-test-backend.onrender.com/api/amazon/oauth/callback`

If you rename the Render services, update these values to match the new URLs.

## Clerk Test App Checklist

Use a separate Clerk app for test so prod sessions cannot authenticate against the test backend.

Configure the test Clerk app with:

- test publishable key -> `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- test secret key -> `CLERK_SECRET_KEY` on both frontend and backend
- a JWT template named `backend`
- allowed origins including `https://seller-bunker-test-frontend.onrender.com`
- redirect URLs for the same test frontend host

If you want deletion handling in test too:

- point Clerk webhooks to `https://seller-bunker-test-frontend.onrender.com/api/webhooks/clerk`
- set `CLERK_WEBHOOK_SIGNING_SECRET` on the frontend
- set the same shared `CLERK_WEBHOOK_SECRET` on both frontend and backend

## Amazon Enablement Checklist

Only do this after frontend, backend, Clerk, Postgres, and Redis are all confirmed healthy.

Set these backend env vars:

- `AMAZON_APP_ID`
- `AMAZON_REDIRECT_URI=https://seller-bunker-test-backend.onrender.com/api/amazon/oauth/callback`
- `LWA_CLIENT_ID`
- `LWA_CLIENT_SECRET`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_ROLE_ARN` if your SP-API setup requires it

Recommended safety choices:

- keep `ENABLE_AMAZON_SYNC_SCHEDULER=false` at first
- optionally set `SPAPI_USE_SANDBOX=true` if you are testing against Amazon sandbox behavior
- leave `SPAPI_DEBUG_LOGS=false` unless you are actively debugging

Amazon app/dashboard checks:

- the OAuth callback registered with Amazon must exactly match `AMAZON_REDIRECT_URI`
- if you keep prod and test active simultaneously, a separate Amazon app is safest

## Controlled Sync Test

After Amazon env vars are in place:

1. Sign in through the test frontend.
2. Start the Amazon connect flow from `/connect-amazon`.
3. Complete OAuth and make sure you land on `/dashboard?amazon_connected=1` on the test frontend.
4. Confirm the backend logs show the initial `full-sync` enqueue.
5. Poll `GET /api/amazon/sync-progress` from the test frontend and verify progress changes.
6. Trigger manual syncs before enabling scheduled sync in test.
7. Only enable scheduled sync after Redis behavior looks healthy.

## Render Notes

- The frontend is a full Next.js service, not a static site, because it serves routes under `frontend/app/api/*`.
- Only `/api/amazon/*` is rewritten to the backend. Frontend routes like `/api/checkout` and `/api/contact` stay on the frontend service.
- If you use Render Key Value for BullMQ, confirm the instance is configured with `noeviction` so sync jobs do not disappear under memory pressure.
