/**
 * Resolve a safe in-app path for post–sign-in / sign-up redirects.
 * Rejects open redirects (e.g. //evil.com) and only allows same-origin paths or relative paths.
 */
export function safeAppRedirectPath(
  candidate: string | null | undefined,
  fallback: string,
): string {
  if (!candidate || typeof candidate !== "string") return fallback;
  const trimmed = candidate.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }
  if (typeof window === "undefined") return fallback;
  try {
    const u = new URL(trimmed, window.location.origin);
    if (u.origin === window.location.origin) {
      return `${u.pathname}${u.search}${u.hash}`;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

/**
 * Full-page navigation after auth so the next request includes Clerk session cookies.
 * Client-side `router.push` can reach middleware before cookies are visible (common on mobile).
 */
export function navigateAfterAuth(path: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(path);
}
