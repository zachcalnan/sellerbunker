import { auth } from "@clerk/nextjs/server";

/**
 * DEV-ONLY override:
 * - In development, allow `?impersonate=user_xxx` to override Clerk `userId`
 * - In production, always uses Clerk `auth()`
 *
 * `auth()` is async in @clerk/nextjs v6 — must be awaited or userId is always missing.
 */
export async function getCurrentUserId(req?: Request) {
  if (process.env.NODE_ENV === "development") {
    try {
      const url = new URL(req?.url || "http://localhost");
      const impersonate = url.searchParams.get("impersonate");
      if (impersonate) return impersonate;
    } catch {
      // ignore
    }
  }

  const a = await auth();
  return a.userId ?? null;
}

