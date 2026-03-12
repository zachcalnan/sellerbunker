# Where user and org get re-created / re-linked

If you delete the **user** row and/or **organization** row from the DB and data still appears linked to the account, it’s because the backend **recreates** the user and/or org on the next authenticated request. There is no separate “save” of linked data; the same auth flow that runs on every request is what recreates them.

---

## 1. Every Clerk request: `ClerkAuthGuard`

**File:** `backend/src/auth/clerk-auth.guard.ts`

On every request that uses the Clerk Bearer token, the guard:

1. Verifies the token and reads **clerkId** and **email** from Clerk.
2. Looks up the user by **clerkId**.
3. If **no user is found** → calls `usersService.createFromClerk({ clerkId, email })` (see below).
4. Then calls `usersService.ensureActiveOrg(user.id, user.email)` (see below).

So: **if you delete the user row, the next API call that hits a protected route will create a new user again** (and then ensure an org).

---

## 2. Creating / linking the user: `createFromClerk`

**File:** `backend/src/users/users.service.ts` → `createFromClerk()`

When the guard doesn’t find a user by **clerkId**, it calls this. Logic:

1. **Find by clerkId** → if found, return that user (no create).
2. **Find by email** (email from Clerk) → if found, **update that user’s `clerkId`** and return them. So an existing user with that email gets “re-linked” to the Clerk account.
3. **Otherwise** → **create a new user** with `clerkId`, `email`, and empty `passwordHash`.

So:

- Deleting the **user** row: next request creates a **new** user (new UUID). Old data (orders, seller accounts, etc.) is still tied to the **old** user id and is not automatically attached to the new one.
- If there is **another** user row with the **same email** (e.g. from an old sign-up), that row gets its **clerkId** set and is used again — so that “other” user (and all their linked data) becomes the one linked to the Clerk account.

---

## 3. Creating / fixing the org: `ensureActiveOrg`

**File:** `backend/src/users/users.service.ts` → `ensureActiveOrg()`

After resolving the user, the guard calls this to make sure they have an active org:

1. If the user has **activeOrgId** set:
   - We now **check that the organization still exists**.
   - If it exists: upsert membership and return that org id.
   - If it **does not** exist (e.g. you deleted the org row): we **clear** `user.activeOrgId` and then fall through to step 2.
2. If the user has **no** active org (or we just cleared a stale one):
   - **Create** a new **Organization**.
   - **Create** an **OrganizationMembership** (user as owner).
   - **Update** the user’s **activeOrgId** to that org.

So:

- Deleting the **organization** row (and optionally memberships) but **keeping** the user: the next request will see that the org is missing, clear **activeOrgId**, and **create a new org** and membership. The **user** (and all their data: orders, seller accounts, etc.) is unchanged; only the org is new.
- If you **also** delete the user and they get re-created by `createFromClerk`, the new user gets a new id and a new org from `ensureActiveOrg`; old data stays on the old user id unless something else (e.g. same email re-link above) attaches it.

---

## 4. Summary: why “data is still linked” after deletes

| What you deleted | What happens on next request | Why data can still look “linked” |
|------------------|------------------------------|-----------------------------------|
| **Only organization** | User still exists. We detect missing org, clear `activeOrgId`, create a **new** org. | All data is still on the **same user** (orders, seller accounts, products, etc.). The app shows that user’s data in the new org. |
| **User only** | No user by clerkId → `createFromClerk` runs. If no other user has same email → **new user** (new id) + new org. If **some other row** has same email → that row gets **clerkId** set and is used; that user’s data is what you see. | Either you’re seeing a **new** user with no legacy data, or you’re seeing the **other** user that was matched by email and re-linked. |
| **User + org** | New user (new id) + new org. | Old data is still in DB under the **old** user id; it’s not linked to the new user unless something else (e.g. email match) reuses that user. |

So “data is still linked” usually means either:

- You didn’t delete the **user** row (only org), so the same user and all their data are still there and we just gave them a new org, or  
- You deleted the user but another user with the **same email** exists and got **re-linked** via `createFromClerk` (step 2), so you’re seeing that user’s data.

---

## 5. How to fully “reset” an account for testing

If you want a clean slate for a given Clerk account:

1. **Delete or unlink in DB (in dependency order if using raw SQL):**
   - Delete rows that depend on the user: e.g. `organization_memberships`, `seller_accounts`, `orders`, `order_items`, `products`, `shipments`, `inventory`, `initial_sync_progress`, etc., for that user (or rely on Prisma `onDelete: Cascade` when you delete the user).
   - Delete the **organization** row(s) that belong to that user (or that you care about).
   - Delete the **user** row (or at least set **clerkId** to `NULL` for that user so the next request won’t find them by clerkId and will create a new user instead of reusing this one).
2. **In Clerk:** If you want the same Clerk user to get a brand‑new app user, the app will do that automatically once there is no user with that `clerkId` and no user with the same email to re-link. So clearing `clerkId` or deleting the user (and cascades) is enough from the app’s side.

The places that “save” or “re-link” are exactly: **ClerkAuthGuard** → **createFromClerk** (user) and **ensureActiveOrg** (org). There isn’t another path that re-attaches existing data to a different user; the only re-link is by **email** in `createFromClerk`.
