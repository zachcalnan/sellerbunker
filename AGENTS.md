# Agent notes (seller-dashboard)

## Amazon order-line fees (Finances API)

When changing anything under `backend/src/amazon/` that touches **settled fees**, **profit**, or **listOrders** display:

1. **Run** (from `backend/`):  
   `npx jest finances-item-fee-parse.util.spec.ts`  
   These tests include a **golden fixture** (`amazon-fees-golden.fixtures.ts`) aligned to Seller Central for a UK FBA example (~£13.29 total fees). If parsing regresses, this fails first.

1b. **Practical “does the app agree with the DB?”** (no half-hour UI stare): while logged in as the seller user, open  
   `GET /api/amazon/dev/order-fee-sanity?amazonOrderId=<Amazon-order-id>`  
   Response includes `summary.ok`, `checks[]` (what’s wrong), `dbLines` vs `listOrdersLines`. Same mapping as the orders UI; compares stored breakdown sum to `amazonFeesTotal`.

2. **Do not** sum `ItemChargeList` into seller fee totals — it holds **Principal / revenue-side charges**, not Amazon fee lines. Shipment fee totals = `ItemFeeList` + `ItemFeeAdjustmentList` only (`parseFinancesShipmentItemFeesSignedTotal`).

3. **Do not** stack duplicate **full** fees for the same `OrderItemId` across Finances lists — `addFee` is **first-wins** on signed total. **Referral/FBA/digital breakdown** is **last-wins** so later rows (e.g. `ShipmentSettle` after `ShipmentEvent`) replace a bad split. Shipment iteration order: `ShipmentEventList` then `ShipmentSettleEventList` (sync + backfill).

4. **Boot coordination**: `AmazonOrderLineFeeBackfillBootstrap` waits for `AMAZON_EXTENDED_ORDER_HISTORY_*` Redis lock / done keys before hammering Finances; extended sync retries on 429. Changing Redis key versions must stay in sync in `amazon-extended-sync.constants.ts`.

5. **DB vs Prisma**: after schema changes run `npx prisma migrate deploy` on every environment. `RepricerService.touchRepricerEngineAt` uses raw SQL to avoid failing when the DB lags `schema.prisma`.

6. **Estimate fees vs Finances (settled)** — there is **no fixed delay** (e.g. not “30 days then swap”). A line stays `feesSource='estimate'` until the **next** `syncRecentOrdersToDb` / `backfillOrderItems` run successfully gets **Finances-backed** fees for that line (`listFinancialEventsByOrderId` itemization, same-ASIN settled fallback, or order-level Finances allocation when itemization is missing). When that happens, the row is written as `feesSource='finances'` with `settledReferralFeeTotal` / `settledFbaFeeTotal` / `settledDigitalServiceFeeTotal` and `amazonFeesTotal` from the Finances parser; **at-sale estimate snapshot columns** are cleared. Until Finances wins, **stored estimate totals and `at_sale_estimate_*` snapshots do not follow live listing or `products` fee columns** (frozen at first non-zero estimate write).

7. **Orders UI** is production data only: `GET /api/amazon/orders` (`listOrders`). Do not wire the customer Orders page to `dev/*` Finances JSON or manual backfill buttons — keep those on dev/admin routes for debugging.

## Personal VPS deploy (Cloud / mobile agents)

Live site is the Hetzner VPS (`www.sellerbunker.com`), **not** auto-deployed from GitHub push alone.

1. Runtime secrets (Cursor dashboard → Cloud Agents): `VPS_SSH_PRIVATE_KEY` (required), optional `VPS_SSH_HOST` / `VPS_SSH_USER`.
2. After code is committed on the working branch, deploy with:
   `bash scripts/vps-deploy-from-agent.sh`
3. That script bundles the branch, uploads to the VPS, `git reset --hard`, then runs `deploy/scripts/update-app.sh` (Docker rebuild). Do **not** force-push or wipe Postgres volumes.

## Handing work to an agent without “days in chat”

- Open a **single thread** with: goal, **order id** example, **Seller Central screenshot or numbers**, and “run `npx jest finances-item-fee-parse.util.spec.ts` until green”.
- **CI**: `.github/workflows/backend-ci.yml` runs `npm test` in `backend/` (includes `finances-item-fee-parse.util.spec.ts`) on PRs/pushes that touch `backend/`.
- Neither Cursor nor Claude runs **autonomously for hours** after you disconnect; the durable check is **automated tests + CI**, not the brand of model.
