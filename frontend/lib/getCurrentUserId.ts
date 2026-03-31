import { auth } from "@clerk/nextjs/server";

/**
 * DEV-ONLY override:
 * - In development, allow `?impersonate=user_xxx` to override Clerk `userId`
 * - In production, always uses Clerk `auth()`
 */
export function getCurrentUserId(req?: Request) {
  if (process.env.NODE_ENV === "development") {
    try {
      const url = new URL(req?.url || "http://localhost");
      const impersonate = url.searchParams.get("impersonate");
      if (impersonate) return impersonate;
    } catch {
      // ignore
    }
  }

  // In Next.js App Router, `auth()` is sync server-side.
  const a = auth() as unknown as { userId?: string | null };
  return a.userId ?? null;
}

