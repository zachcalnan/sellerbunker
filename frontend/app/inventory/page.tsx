"use client";

import { useAuth, SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

type InventoryRow = {
  productId: string;
  sku: string;
  asin: string | null;
  title: string | null;
  imageUrl: string | null;
  productUpdatedAt: string;
  availableQty: number | null;
  reservedQty: number | null;
  inboundQty: number | null;
  issueQty: number | null;
  totalQty: number | null;
  inventoryUpdatedAt: string | null;
  rawJson: unknown;
  byMarketplace?: Array<{
    marketplaceId: string;
    fulfillableQty: number;
    inboundQty: number;
    reservedQty: number;
    researchingQty: number;
    unfulfillableQty: number;
    currentQty: number;
    updatedAt: string | null;
  }>;
};

const SYSTEM_SKUS = new Set(["AMAZON_GENERIC", "AMAZON_MULTI"]);
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const AUTO_SYNC_COOLDOWN_MS = 5 * 60 * 1000; // 5 min
const AUTO_SYNC_STORAGE_KEY = "inventory_last_auto_sync";
const AUTO_BACKFILL_STORAGE_KEY = "inventory_last_auto_backfill";

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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [detailRow, setDetailRow] = useState<InventoryRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken({ skipCache: true });
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

  // Auto sync when page loads (with cooldown)
  useEffect(() => {
    if (!isSignedIn || loading || syncing) return;

    const lastStr = typeof window !== "undefined" ? sessionStorage.getItem(AUTO_SYNC_STORAGE_KEY) : null;
    const lastTime = lastStr ? parseInt(lastStr, 10) : 0;
    if (Date.now() - lastTime < AUTO_SYNC_COOLDOWN_MS) return;

    const run = async () => {
      if (typeof window !== "undefined") sessionStorage.setItem(AUTO_SYNC_STORAGE_KEY, String(Date.now()));
      setSyncing(true);
      setError(null);
      try {
        const token = await getToken({ skipCache: true });
        const syncRes = await fetch(`${baseUrl}/api/amazon/inventory/sync`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!syncRes.ok) {
          const msg = syncRes.headers.get("content-type")?.includes("application/json")
            ? ((await syncRes.json()) as { message?: unknown })?.message
            : await syncRes.text();
          throw new Error(typeof msg === "string" ? msg : "Failed to sync.");
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Auto-sync failed.");
        if (typeof window !== "undefined") sessionStorage.setItem(AUTO_SYNC_STORAGE_KEY, "0");
      } finally {
        setSyncing(false);
      }
    };

    void run();
  }, [isSignedIn, loading, syncing, getToken, baseUrl, load]);

  // Auto backfill when we have rows with missing images (separate effect, own cooldown)
  useEffect(() => {
    if (!isSignedIn || loading || syncing || backfillingTitles || rows.length === 0) return;
    const needsBackfill = rows.some((r) => !r.imageUrl || !r.title);
    if (!needsBackfill) return;

    const lastStr = typeof window !== "undefined" ? sessionStorage.getItem(AUTO_BACKFILL_STORAGE_KEY) : null;
    const lastTime = lastStr ? parseInt(lastStr, 10) : 0;
    if (Date.now() - lastTime < AUTO_SYNC_COOLDOWN_MS) return;

    const run = async () => {
      if (typeof window !== "undefined") sessionStorage.setItem(AUTO_BACKFILL_STORAGE_KEY, String(Date.now()));
      setBackfillingTitles(true);
      setError(null);
      try {
        const token = await getToken({ skipCache: true });
        const res = await fetch(
          `${baseUrl}/api/amazon/dev/backfill-product-titles?limit=200`,
          { method: "POST", headers: { Authorization: `Bearer ${token}` } },
        );
        if (res.ok) await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Auto-backfill failed.");
        if (typeof window !== "undefined") sessionStorage.setItem(AUTO_BACKFILL_STORAGE_KEY, "0");
      } finally {
        setBackfillingTitles(false);
      }
    };

    void run();
  }, [isSignedIn, loading, syncing, backfillingTitles, rows, getToken, baseUrl, load]);

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const token = await getToken({ skipCache: true });
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
      if (typeof window !== "undefined") sessionStorage.setItem(AUTO_SYNC_STORAGE_KEY, String(Date.now()));
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
      const token = await getToken({ skipCache: true });
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

      if (typeof window !== "undefined") sessionStorage.setItem(AUTO_BACKFILL_STORAGE_KEY, String(Date.now()));

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
    const list = rows.filter((r) => {
      if (!showSystem && SYSTEM_SKUS.has(r.sku)) return false;
      if (!q) return true;
      return (
        r.sku.toLowerCase().includes(q) ||
        (r.asin ?? "").toLowerCase().includes(q) ||
        (r.title ?? "").toLowerCase().includes(q)
      );
    });
    return [...list].sort((a, b) => (b.totalQty ?? 0) - (a.totalQty ?? 0));
  }, [rows, query, showSystem]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(
    () =>
      filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filtered, safePage, pageSize],
  );

  const inventoryTotals = useMemo(() => {
    let available = 0;
    let reserved = 0;
    let inbound = 0;
    let issue = 0;
    let total = 0;
    for (const r of filtered) {
      available += r.availableQty ?? 0;
      reserved += r.reservedQty ?? 0;
      inbound += r.inboundQty ?? 0;
      issue += r.issueQty ?? 0;
      total += r.totalQty ?? 0;
    }
    return { available, reserved, inbound, issue, total };
  }, [filtered]);

  useEffect(() => {
    setPage(1);
  }, [query, showSystem, pageSize]);

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

        <div className="mb-4 rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3">
          <div className="text-xs font-medium uppercase tracking-[0.18em] text-[var(--muted-foreground)] mb-2">
            Inventory snapshot
          </div>
          <div className="flex flex-wrap gap-6 sm:gap-8">
            <div>
              <span className="text-sm text-[var(--muted-foreground)]">Total </span>
              <span className="text-lg font-semibold tabular-nums text-[var(--foreground)]">{inventoryTotals.total.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-sm text-[var(--muted-foreground)]">Available </span>
              <span className="text-lg font-semibold tabular-nums text-[var(--foreground)]">{inventoryTotals.available.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-sm text-[var(--muted-foreground)]">Reserved </span>
              <span className="text-lg font-semibold tabular-nums text-[var(--foreground)]">{inventoryTotals.reserved.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-sm text-[var(--muted-foreground)]">Inbound </span>
              <span className="text-lg font-semibold tabular-nums text-[var(--foreground)]">{inventoryTotals.inbound.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-sm text-[var(--muted-foreground)]">Issue </span>
              <span className="text-lg font-semibold tabular-nums text-[var(--foreground)]">{inventoryTotals.issue.toLocaleString()}</span>
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl ring-1 ring-[var(--surface-border)]">
          <div className="hidden md:grid grid-cols-[44px_1.2fr_0.9fr_1.8fr_0.6fr_0.6fr_0.6fr_0.6fr_0.6fr] gap-2 bg-[var(--surface)] px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
            <div />
            <div>SKU</div>
            <div>ASIN</div>
            <div>Title</div>
            <div className="text-center pl-3">Total</div>
            <div className="text-center pl-3">Available</div>
            <div className="text-center pl-3">Reserved</div>
            <div className="text-center pl-3">Inbound</div>
            <div className="text-center pl-3">Issue</div>
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
            <>
            <div className="divide-y divide-[var(--surface-border)] bg-transparent">
              {paginated.map((r) => {
                const isSystem = SYSTEM_SKUS.has(r.sku);
                const num = (n: number | null) => (n == null ? "—" : String(n));
                const marketplaceLine =
                  r.byMarketplace && r.byMarketplace.length > 0
                    ? r.byMarketplace
                        .filter((m) => (m.fulfillableQty ?? 0) > 0)
                        .map((m) => {
                          const short =
                            m.marketplaceId === "A1F83G8C2ARO7P"
                              ? "UK"
                              : m.marketplaceId === "A1PA6795UKMFR9"
                                ? "DE"
                                : m.marketplaceId === "A13V1IB3VIYZZH"
                                  ? "FR"
                                  : m.marketplaceId === "APJ6JRA9NG5V4"
                                    ? "IT"
                                    : m.marketplaceId === "A1RKKUPIHCS9HS"
                                      ? "ES"
                                      : m.marketplaceId === "ATVPDKIKX0DER"
                                        ? "US"
                                        : m.marketplaceId;
                          return `${short} ${m.fulfillableQty}`;
                        })
                        .join(" · ")
                    : null;

                return (
                  <Fragment key={r.productId}>
                    {/* Mobile card — clickable */}
                    <div
                      key={`${r.productId}-mobile`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setDetailRow(r)}
                      onKeyDown={(e) => e.key === "Enter" && setDetailRow(r)}
                      className="md:hidden cursor-pointer px-4 py-3 hover:bg-[var(--foreground)]/5 transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex h-11 w-11 items-center justify-center shrink-0">
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
                          {marketplaceLine ? (
                            <div className="mt-1 truncate text-xs text-[var(--muted-foreground)]">
                              {marketplaceLine}
                            </div>
                          ) : null}
                          {isSystem ? (
                            <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                              System SKU
                            </div>
                          ) : null}
                          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted-foreground)]">
                            <span className="font-medium text-[var(--foreground)]">Total {num(r.totalQty)}</span>
                            <span>Available {num(r.availableQty)}</span>
                            <span>Reserved {num(r.reservedQty)}</span>
                            <span>Inbound {num(r.inboundQty)}</span>
                            <span>Issue {num(r.issueQty)}</span>
                          </div>
                        </div>
                        <svg className="h-5 w-5 shrink-0 text-[var(--muted-foreground)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>

                    {/* Desktop table row — clickable */}
                    <div
                      key={`${r.productId}-desktop`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setDetailRow(r)}
                      onKeyDown={(e) => e.key === "Enter" && setDetailRow(r)}
                      className="hidden md:grid grid-cols-[44px_1.2fr_0.9fr_1.8fr_0.6fr_0.6fr_0.6fr_0.6fr_0.6fr] items-center gap-2 px-4 py-3 cursor-pointer hover:bg-[var(--foreground)]/5 transition-colors"
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
                        {marketplaceLine ? (
                          <div className="mt-0.5 truncate text-xs text-[var(--muted-foreground)]">
                            {marketplaceLine}
                          </div>
                        ) : null}
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
                      <div className="text-center pl-3 text-sm font-medium text-[var(--foreground)]">{num(r.totalQty)}</div>
                      <div className="text-center pl-3 text-sm text-[var(--foreground)]">{num(r.availableQty)}</div>
                      <div className="text-center pl-3 text-sm text-[var(--foreground)]">{num(r.reservedQty)}</div>
                      <div className="text-center pl-3 text-sm text-[var(--foreground)]">{num(r.inboundQty)}</div>
                      <div className="text-center pl-3 text-sm text-[var(--foreground)]">
                        {num(r.issueQty)}
                      </div>
                    </div>
                  </Fragment>
                );
              })}
            </div>

            {totalPages > 1 ? (
              <div className="flex items-center justify-between gap-4 border-t border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3">
                <div className="flex items-center gap-4">
                  <div className="text-sm text-[var(--muted-foreground)]">
                    Page {safePage} of {totalPages}
                    <span className="ml-2">
                      ({(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, filtered.length)} of {filtered.length})
                    </span>
                  </div>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value) as 20 | 50 | 100);
                      setPage(1);
                    }}
                    className="cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-2 py-1 text-sm text-[var(--foreground)] outline-none"
                    aria-label="Items per page"
                  >
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>{n} per page</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                    className="cursor-pointer flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--surface-border)] bg-transparent text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:pointer-events-none disabled:opacity-40"
                    aria-label="Previous page"
                  >
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage >= totalPages}
                    className="cursor-pointer flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--surface-border)] bg-transparent text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:pointer-events-none disabled:opacity-40"
                    aria-label="Next page"
                  >
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                </div>
              </div>
            ) : null}
            </>
          )}
        </div>

        {/* Inventory detail modal — drilldown from rawJson */}
        {detailRow ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
            onClick={() => setDetailRow(null)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="inventory-detail-title"
          >
            <div
              className="bg-[var(--background)] rounded-xl shadow-xl max-w-lg w-full max-h-[85vh] overflow-hidden flex flex-col border border-[var(--surface-border)]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-[var(--surface-border)]">
                <div className="min-w-0 flex-1">
                  <h2 id="inventory-detail-title" className="text-lg font-semibold text-[var(--foreground)] truncate">
                    {detailRow.title ?? detailRow.sku}
                  </h2>
                  <p className="text-sm text-[var(--muted-foreground)]">
                    SKU {detailRow.sku} {detailRow.asin ? `· ASIN ${detailRow.asin}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setDetailRow(null)}
                  className="shrink-0 rounded-lg p-2 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
                  aria-label="Close"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-3 text-sm">
                <InventoryDetailDrilldown rawJson={detailRow.rawJson} />
              </div>
            </div>
          </div>
        ) : null}
      </SignedIn>
    </div>
  );
}

/** Helper to safely read a number from an object (SP-API uses camelCase or PascalCase). */
function getNum(obj: Record<string, unknown> | undefined, ...keys: string[]): number {
  if (!obj || typeof obj !== 'object') return 0;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
  }
  return 0;
}

/** Parses SP-API rawJson (array of summary payloads) into the drilldown tree for the modal. */
function InventoryDetailDrilldown({ rawJson }: { rawJson: unknown }) {
  const payloads: Record<string, unknown>[] = Array.isArray(rawJson)
    ? rawJson.filter((x): x is Record<string, unknown> => x != null && typeof x === 'object')
    : rawJson != null && typeof rawJson === 'object' ? [rawJson as Record<string, unknown>] : [];
  if (payloads.length === 0) {
    return (
      <p className="text-[var(--muted-foreground)]">No inventory detail data. Run a sync to populate.</p>
    );
  }

  let fulfillable = 0;
  let reservedTotal = 0;
  let fcProcessing = 0;
  let customerOrders = 0;
  let transshipment = 0;
  let inboundWorking = 0;
  let inboundShipped = 0;
  let inboundReceiving = 0;
  let unfulfillable = 0;
  let researching = 0;
  let lost = 0;
  let aged = 0;

  for (const p of payloads) {
    const raw = p as Record<string, unknown>;
    const d = (raw.inventoryDetails ?? raw.InventoryDetails ?? {}) as Record<string, unknown>;
    const r = (d.reservedQuantity ?? d.ReservedQuantity ?? {}) as Record<string, unknown>;
    const res = (d.researchingQuantity ?? d.ResearchingQuantity ?? {}) as Record<string, unknown>;
    const u = (d.unfulfillableQuantity ?? d.UnfulfillableQuantity ?? {}) as Record<string, unknown>;

    fulfillable += getNum(d, 'afnFulfillableQuantity', 'fulfillableQuantity');
    reservedTotal += getNum(r, 'totalReservedQuantity', 'total');
    fcProcessing += getNum(r, 'fcProcessingQuantity', 'fcProcessing');
    customerOrders += getNum(r, 'customerOrderQuantity', 'customerOrder');
    transshipment += getNum(r, 'transshipmentQuantity', 'transshipment');
    inboundWorking += getNum(d, 'afnInboundWorkingQuantity');
    inboundShipped += getNum(d, 'afnInboundShippedQuantity');
    inboundReceiving += getNum(d, 'afnInboundReceivingQuantity');
    unfulfillable += getNum(u, 'totalUnfulfillableQuantity', 'total');
    researching += getNum(res, 'totalResearchingQuantity', 'total');
    lost += getNum(u, 'lostQuantity', 'lost');
    aged += getNum(u, 'agedQuantity', 'aged');
  }

  const total =
    fulfillable + reservedTotal + inboundWorking + inboundShipped + inboundReceiving + unfulfillable + researching;
  const issueTotal = unfulfillable + researching + lost + aged;
  const inboundTotal = inboundWorking + inboundShipped + inboundReceiving;

  const line = (label: string, qty: number, prefix: string) => (
    <div
      key={label}
      className={prefix ? "flex justify-between gap-4 pl-6 py-0.5 text-[var(--muted-foreground)]" : "flex justify-between gap-4 py-1"}
    >
      <span className={prefix ? "text-[var(--muted-foreground)]" : ""}>
        {prefix}{label}
      </span>
      <span className="font-medium tabular-nums text-[var(--foreground)]">{qty}</span>
    </div>
  );
  const branch = (label: string, qty: number, children: React.ReactNode) => (
    <div key={label} className="border-b border-[var(--surface-border)]/50 pb-2 mb-2 last:border-0 last:mb-0">
      <div className="flex justify-between gap-4 py-1 font-medium">
        <span>{label}</span>
        <span className="tabular-nums text-[var(--foreground)]">{qty}</span>
      </div>
      {children}
    </div>
  );

  return (
    <div className="space-y-1 font-mono text-sm">
      {branch("Available", fulfillable, line("Fulfillable", fulfillable, "└ "))}
      {branch("Reserved", reservedTotal, (
        <>
          {line("FC Processing", fcProcessing, "├ ")}
          {line("Customer Orders", customerOrders, "├ ")}
          {line("Transshipment", transshipment, "└ ")}
        </>
      ))}
      {branch("Inbound", inboundTotal, (
        <>
          {line("Working", inboundWorking, "├ ")}
          {line("Shipped", inboundShipped, "├ ")}
          {line("Receiving", inboundReceiving, "└ ")}
        </>
      ))}
      {branch("Issue", issueTotal, (
        <>
          {line("Unfulfillable", unfulfillable, "├ ")}
          {line("Researching", researching, "├ ")}
          {line("Lost", lost, "├ ")}
          {line("Aged", aged, "└ ")}
        </>
      ))}
      {total === 0 ? (
        <div className="flex justify-between gap-4 py-2 font-medium text-[var(--muted-foreground)]">
          <span>Out of Stock</span>
          <span>—</span>
        </div>
      ) : null}
    </div>
  );
}

