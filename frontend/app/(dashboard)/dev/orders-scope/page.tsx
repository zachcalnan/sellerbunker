"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getDevImpersonationHeaders } from "@/lib/impersonation";

/**
 * Authenticated view of GET /api/amazon/dev/orders-scope-debug (same token as Orders).
 * Open while signed in: /dev/orders-scope  (local or live)
 */
export default function OrdersScopeDebugPage() {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const { isSignedIn, getToken } = useAuth();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");

  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken({ template: "backend" });
      if (!token) {
        setError("No session token.");
        return;
      }
      const url = new URL(`${baseUrl}/api/amazon/dev/orders-scope-debug`);
      if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          ...getDevImpersonationHeaders(devImpersonate),
        },
      });
      const body = await res.text();
      if (!res.ok) {
        setError(`${res.status} ${res.statusText}\n${body}`);
        setText("");
        return;
      }
      try {
        setText(JSON.stringify(JSON.parse(body), null, 2));
      } catch {
        setText(body);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setText("");
    } finally {
      setLoading(false);
    }
  }, [getToken, baseUrl, devImpersonate]);

  useEffect(() => {
    if (!isSignedIn) {
      setText("");
      setError(null);
      return;
    }
    void load();
  }, [isSignedIn, load]);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="mb-2 text-lg font-semibold">Orders scope (debug)</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Same auth as the Orders tab. Compare{" "}
        <code className="rounded bg-muted px-1">canonicalAggregateUserIds</code> vs{" "}
        <code className="rounded bg-muted px-1">orderReadUserIds</code> and{" "}
        <code className="rounded bg-muted px-1">orderRowCountsByUserId</code>.
      </p>
      {!isSignedIn ? (
        <p className="text-sm">Sign in to load.</p>
      ) : (
        <>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="mb-4 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
          {error ? (
            <pre className="whitespace-pre-wrap rounded-md border border-destructive/50 bg-destructive/5 p-4 text-sm">
              {error}
            </pre>
          ) : (
            <pre className="max-h-[70vh] overflow-auto rounded-md border bg-muted/30 p-4 text-xs">
              {text || (loading ? "…" : "")}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
