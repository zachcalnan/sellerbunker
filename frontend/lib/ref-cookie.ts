const REF_COOKIE = "ref";
/** 60 days */
const MAX_AGE_SEC = 60 * 24 * 60 * 60;

export function readRefCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const parts = document.cookie.split(";");
  for (const part of parts) {
    const [k, ...rest] = part.trim().split("=");
    if (k === REF_COOKIE && rest.length) {
      try {
        const v = decodeURIComponent(rest.join("="));
        return v.trim() || undefined;
      } catch {
        return rest.join("=").trim() || undefined;
      }
    }
  }
  return undefined;
}

export function hasRefCookie(): boolean {
  return readRefCookie() !== undefined;
}

export function setRefCookieIfAbsent(raw: string): void {
  if (typeof document === "undefined") return;
  const value = raw.trim();
  if (!value) return;
  if (hasRefCookie()) return;
  const secure =
    typeof window !== "undefined" && window.location.protocol === "https:";
  document.cookie = `${REF_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${MAX_AGE_SEC}; SameSite=Lax${secure ? "; Secure" : ""}`;
}
