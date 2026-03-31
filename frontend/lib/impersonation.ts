export function getImpersonateClerkIdFromBrowserUrl(): string | null {
  if (typeof window === "undefined") return null;
  if (process.env.NODE_ENV !== "development") return null;
  try {
    const url = new URL(window.location.href);
    const v = url.searchParams.get("impersonate");
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function getDevImpersonationHeaders(
  impersonateClerkId?: string | null,
): Record<string, string> {
  if (process.env.NODE_ENV !== "development") return {};
  const clerkId =
    impersonateClerkId && impersonateClerkId.trim()
      ? impersonateClerkId.trim()
      : getImpersonateClerkIdFromBrowserUrl();
  return clerkId ? { "x-impersonate-clerk-id": clerkId } : {};
}

export function withImpersonateParam(
  href: string,
  impersonateClerkId?: string | null,
) {
  if (process.env.NODE_ENV !== "development") return href;
  const id = impersonateClerkId && impersonateClerkId.trim() ? impersonateClerkId.trim() : null;
  if (!id) return href;
  try {
    const u = new URL(href, "http://localhost");
    u.searchParams.set("impersonate", id);
    return u.pathname + (u.search ? u.search : "") + (u.hash ? u.hash : "");
  } catch {
    return href;
  }
}

