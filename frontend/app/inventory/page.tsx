"use client";

import { useAuth, SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";

type InventoryRow = {
  productId: string;
  sku: string;
  asin: string | null;
  title: string | null;
  imageUrl: string | null;
  productUpdatedAt: string;
  fbaFulfillableQty: number | null;
  inventoryUpdatedAt: string | null;
};

const SYSTEM_SKUS = new Set(["AMAZON_GENERIC", "AMAZON_MULTI"]);

export default function InventoryPage() {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const { isSignedIn, getToken } = useAuth();

  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [backfillingTitles, setBackfillingTitles] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${baseUrl}/api/amazon/inventory`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load inventory.");
      const data = (await res.json()) as InventoryRow[];
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, [getToken, baseUrl]);

  useEffect(() => {
    if (!isSignedIn) {
      setRows([]);
      setError(null);
      return;
    }
    void load();
  }, [isSignedIn, load]);

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const token = await getToken();
      const res = await fetch(`${baseUrl}/api/amazon/inventory/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const body = (await res.json()) as { message?: unknown };
          const message =
            typeof body?.message === "string"
              ? body.message
              : "Failed to sync.";
          throw new Error(message);
        }
        const msg = await res.text();
        throw new Error(msg || "Failed to sync.");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to sync.");
    } finally {
      setSyncing(false);
    }
  };

  const backfillTitles = async () => {
    setBackfillingTitles(true);
    setError(null);
    setNotice(null);
    try {
      const token = await getToken();
      const res = await fetch(
        `${baseUrl}/api/amazon/dev/backfill-product-titles?limit=200`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      if (!res.ok) {
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const body = (await res.json()) as { message?: unknown };
          const message =
            typeof body?.message === "string"
              ? body.message
              : "Failed to backfill titles.";
          throw new Error(message);
        }
        const msg = await res.text();
        throw new Error(msg || "Failed to backfill titles.");
      }

      const result = (await res.json()) as {
        requested?: number;
        updated?: number;
        skipped?: number;
        errorsCount?: number;
        errors?: Array<{ asin: string; error: string }>;
        skippedSamples?: Array<{
          asin: string;
          marketplacesTried: number;
          sawSummaries: boolean;
          sawAttributes: boolean;
        }>;
      };

      const requested = Number(result.requested ?? 0);
      const updated = Number(result.updated ?? 0);
      const skipped = Number(result.skipped ?? 0);
      const errorsCount = Number(result.errorsCount ?? 0);

      setNotice(
        `Backfill complete: ${updated}/${requested} updated` +
          (skipped ? `, ${skipped} skipped` : "") +
          (errorsCount ? `, ${errorsCount} errors` : ""),
      );

      if (errorsCount && result.errors?.length) {
        const first = result.errors[0];
        setError(
          first?.asin && first?.error
            ? `${first.asin}: ${first.error}`
            : first?.error ?? "Some titles failed to backfill.",
        );
      }

      if (!errorsCount && updated === 0 && result.skippedSamples?.length) {
        const s = result.skippedSamples[0];
        setError(
          `No titles returned for ASIN ${s.asin} (summaries=${String(
            s.sawSummaries,
          )}, attributes=${String(s.sawAttributes)}).`,
        );
      }

      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to backfill titles.");
    } finally {
      setBackfillingTitles(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showSystem && SYSTEM_SKUS.has(r.sku)) return false;
      if (!q) return true;
      return (
        r.sku.toLowerCase().includes(q) ||
        (r.asin ?? "").toLowerCase().includes(q) ||
        (r.title ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, showSystem]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">
            Inventory
          </h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            FBA inventory only (fulfillable units) matched by SKU.
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
          <div className="flex items-center justify-between gap-3 sm:justify-start">
            <label className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
              <input
                type="checkbox"
                checked={showSystem}
                onChange={(e) => setShowSystem(e.target.checked)}
              />
              Show system SKUs
            </label>
          </div>

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search SKU / ASIN / title…"
            className="w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none sm:w-72"
          />

          <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <button
              type="button"
              onClick={syncNow}
              disabled={!isSignedIn || syncing}
              className="cursor-pointer rounded-lg bg-[rgb(2,242,170)] px-3 py-2 text-sm font-medium text-black disabled:cursor-not-allowed disabled:opacity-60"
            >
              {syncing ? "Syncing…" : "Sync now"}
            </button>
            <button
              type="button"
              onClick={backfillTitles}
              disabled={!isSignedIn || backfillingTitles}
              className="cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:cursor-not-allowed disabled:opacity-60"
              title="Backfill missing titles via Catalog Items API"
            >
              {backfillingTitles ? "Backfilling…" : "Backfill titles"}
            </button>
          </div>
        </div>
      </div>

      <SignedOut>
        <div className="rounded-xl border border-[var(--surface-border)] bg-transparent p-4 text-sm text-[var(--muted-foreground)]">
          <div className="mb-3">Sign in to view Inventory.</div>
          <SignInButton>
            <button className="cursor-pointer rounded-lg bg-[rgb(2,242,170)] px-3 py-2 text-sm font-medium text-black">
              Sign in
            </button>
          </SignInButton>
        </div>
      </SignedOut>

      <SignedIn>
        {notice ? (
          <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {notice}
          </div>
        ) : null}
        {error ? (
          <div className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="overflow-hidden rounded-xl ring-1 ring-[var(--surface-border)]">
          <div className="hidden md:grid grid-cols-[44px_1.2fr_1fr_2fr_0.8fr_1fr] gap-3 bg-[var(--surface)] px-4 py-3 text-xs font-medium uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
            <div />
            <div>SKU</div>
            <div>ASIN</div>
            <div>Title</div>
            <div className="text-right">Available</div>
            <div>Updated</div>
          </div>

          {loading ? (
            <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
              No products found.
            </div>
          ) : (
            <div className="divide-y divide-[var(--surface-border)] bg-transparent">
              {filtered.map((r) => {
                const isSystem = SYSTEM_SKUS.has(r.sku);
                const Available =
                  r.fbaFulfillableQty == null ? "—" : String(r.fbaFulfillableQty);
                const updated =
                  r.inventoryUpdatedAt == null
                    ? "—"
                    : new Date(r.inventoryUpdatedAt).toLocaleString();

                return (
                  <>
                    {/* Mobile card */}
                    <div key={`${r.productId}-mobile`} className="md:hidden px-4 py-3">
                      <div className="flex items-start gap-3">
                        <div className="flex h-11 w-11 items-center justify-center">
                          {r.imageUrl ? (
                            <img
                              src={r.imageUrl}
                              alt={r.title ?? r.sku}
                              className="h-11 w-11 rounded-md object-cover ring-1 ring-[var(--surface-border)]"
                              loading="lazy"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="h-11 w-11 rounded-md bg-[var(--surface)] ring-1 ring-[var(--surface-border)]" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-[var(--foreground)]">
                            {r.title ?? r.sku}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-[var(--muted-foreground)]">
                            SKU {r.sku} · ASIN {r.asin ?? "—"}
                          </div>
                          {isSystem ? (
                            <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                              System SKU
                            </div>
                          ) : null}
                          <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                            <div className="text-[var(--muted-foreground)]">
                              Available{" "}
                              <span className="font-medium text-[var(--foreground)]">
                                {Available}
                              </span>
                            </div>
                            <div className="truncate text-[var(--muted-foreground)]">
                              {updated}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Desktop table row */}
                    <div
                      key={`${r.productId}-desktop`}
                      className="hidden md:grid grid-cols-[44px_1.2fr_1fr_2fr_0.8fr_1fr] items-center gap-3 px-4 py-3"
                    >
                      <div className="flex items-center justify-center">
                        {r.imageUrl ? (
                          <img
                            src={r.imageUrl}
                            alt={r.title ?? r.sku}
                            className="h-9 w-9 rounded-md object-cover ring-1 ring-[var(--surface-border)]"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="h-9 w-9 rounded-md bg-[var(--surface)] ring-1 ring-[var(--surface-border)]" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-[var(--foreground)]">
                          {r.sku}
                        </div>
                        {isSystem ? (
                          <div className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                            System SKU
                          </div>
                        ) : null}
                      </div>
                      <div className="truncate text-sm text-[var(--muted-foreground)]">
                        {r.asin ?? "—"}
                      </div>
                      <div className="truncate text-sm text-[var(--muted-foreground)]">
                        {r.title ?? "—"}
                      </div>
                      <div className="text-right text-sm font-medium text-[var(--foreground)]">
                        {Available}
                      </div>
                      <div className="truncate text-sm text-[var(--muted-foreground)]">
                        {updated}
                      </div>
                    </div>
                  </>
                );
              })}
            </div>
          )}
        </div>
      </SignedIn>
    </div>
  );
}

