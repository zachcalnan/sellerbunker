"use client";

import { useAuth, SignedIn, SignedOut } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useDisplaySettings } from "@/contexts/display-settings-context";
import { useMarketplace } from "@/contexts/marketplace-context";
import { SignInButtonWithReturn } from "@/components/sign-in-button-with-return";
import { getDevImpersonationHeaders } from "@/lib/impersonation";

type ReplenishRow = {
  productId: string;
  imageUrl: string | null;
  title: string | null;
  sku: string;
  asin: string | null;
  lastSold: string | null;
  outOfStock: boolean;
  unitsSold: number;
  estimatedProfit: number;
};

const PAGE_SIZE = 12;

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
}

export default function ReplenishPage() {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const { isSignedIn, getToken } = useAuth();
  const { selectedMarketplaceId, selectedCurrency } = useMarketplace();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");

  const [rows, setRows] = useState<ReplenishRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken({ template: "backend" });
      const url = new URL(`${baseUrl}/api/amazon/replenish`);
      url.searchParams.set("limit", "10000");
      if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          ...getDevImpersonationHeaders(devImpersonate),
          ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
        },
        credentials: "include",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Request failed (${res.status})`);
      }
      const data = (await res.json()) as ReplenishRow[];
      setRows(data);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Error";
      setError(message === "Failed to fetch" ? "Could not reach the API. Ensure the backend is running." : message);
    } finally {
      setLoading(false);
    }
  }, [getToken, baseUrl, selectedMarketplaceId, devImpersonate]);

  useEffect(() => {
    if (!isSignedIn) {
      setRows([]);
      setError(null);
      return;
    }
    void load();
  }, [isSignedIn, load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.sku.toLowerCase().includes(q) ||
        (r.asin ?? "").toLowerCase().includes(q) ||
        (r.title ?? "").toLowerCase().includes(q)
    );
  }, [rows, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage]
  );

  useEffect(() => {
    setPage(1);
  }, [query]);

  const { backgroundClass } = useDisplaySettings();

  return (
    <div className={`flex min-h-screen flex-col gap-3 ${backgroundClass} p-3 md:p-4`}>
      <SignedOut>
        <div className="flex flex-col items-center justify-center gap-4 py-8">
          <p className="text-[var(--muted-foreground)]">
            Sign in to view replenishment suggestions.
          </p>
          <SignInButtonWithReturn>
            <button className="rounded-lg bg-sb-accent px-4 py-2 text-sm font-medium text-black">
              Sign in
            </button>
          </SignInButtonWithReturn>
        </div>
      </SignedOut>

      <SignedIn>
        <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3">
          <h1 className="text-xl font-semibold text-[var(--foreground)]">
            Replenish
          </h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Best-selling products from your existing order data, sorted by out of stock first, then most sold, then estimated profit.
          </p>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              type="search"
              placeholder="Search by SKU, ASIN or title…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="max-w-md rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-sb-accent"
              aria-label="Search replenish list"
            />
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {loading ? (
          <div className="py-6 text-center text-sm text-[var(--muted-foreground)]">
            Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-6 text-center text-sm text-[var(--muted-foreground)]">
            No products with orders found in your database.
          </div>
        ) : (
          <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {paginated.map((r) => (
              <div
                key={r.productId}
                className="flex flex-col overflow-hidden rounded-lg border border-[var(--surface-border)] bg-[var(--surface)]"
              >
                <div className="relative flex h-40 shrink-0 items-center justify-center bg-[var(--background)] p-3">
                  {r.imageUrl ? (
                    <img
                      src={r.imageUrl}
                      alt=""
                      className="max-h-full w-auto max-w-full object-contain"
                    />
                  ) : (
                    <span className="text-xs text-[var(--muted-foreground)]">
                      No image
                    </span>
                  )}
                  {r.outOfStock && (
                    <span className="absolute right-2 top-2 rounded bg-red-500/90 px-2 py-0.5 text-[10px] font-medium text-white">
                      Out of stock
                    </span>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-1.5 p-3">
                  <div className="line-clamp-2 min-h-[2.5rem] text-sm font-medium text-[var(--foreground)]">
                    {r.title ?? r.sku}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--muted-foreground)]">
                    <span>SKU: <span className="font-mono text-[var(--foreground)]">{r.sku}</span></span>
                    {r.asin && (
                      <span>ASIN: <span className="font-mono text-[var(--foreground)]">{r.asin}</span></span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                    Last sold: {formatDate(r.lastSold)}
                  </div>
                  <div className="mt-auto flex gap-3 pt-1 text-xs">
                    <span className="tabular-nums text-[var(--foreground)]">
                      {r.unitsSold} sold
                    </span>
                    <span className="tabular-nums text-[var(--muted-foreground)]">
                      Profit: {new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(r.estimatedProfit)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-4 border-t border-[var(--surface-border)] pt-4">
              <div className="text-sm text-[var(--muted-foreground)]">
                Page {safePage} of {totalPages}
                <span className="ml-2">
                  ({(safePage - 1) * PAGE_SIZE + 1}–
                  {Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length})
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--surface-border)] bg-transparent text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:pointer-events-none disabled:opacity-40"
                  aria-label="Previous page"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage >= totalPages}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--surface-border)] bg-transparent text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:pointer-events-none disabled:opacity-40"
                  aria-label="Next page"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>
          )}
          </>
        )}
      </SignedIn>
    </div>
  );
}
