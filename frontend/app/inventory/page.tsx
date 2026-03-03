"use client";

import { useAuth, SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

type InventoryRow = {
  productId: string;
  sku: string;
  asin: string | null;
  title: string | null;
  imageUrl: string | null;
  productType: string | null;
  displayGroup: string | null;
  productUpdatedAt: string;
  estimatedAmazonFeePerUnit: number | null;
  estimatedReferralFeePerUnit: number | null;
  estimatedFbaFeePerUnit: number | null;
  estimatedAmazonFeeUpdatedAt: string | null;
  currentListedPrice: number | null;
  costOfGoods: number | null;
  feeEstimateRawJson: unknown;
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
const PAGE_SIZE = 20;

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
  const [detailRow, setDetailRow] = useState<InventoryRow | null>(null);

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

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(
    () =>
      filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
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
  }, [query, showSystem]);

  return (
    <div className="w-full px-6 py-10">
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
          <div className="hidden md:grid grid-cols-[44px_1.2fr_0.9fr_1.5fr_0.75fr_0.55fr_0.55fr_0.55fr_0.55fr_0.55fr_0.55fr_0.8fr] gap-2 bg-[var(--surface)] px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
            <div />
            <div>SKU</div>
            <div>ASIN</div>
            <div>Title</div>
            <div>Type / Group</div>
            <div className="text-center pl-3">Total</div>
            <div className="text-center pl-3">Available</div>
            <div className="text-center pl-3">Reserved</div>
            <div className="text-center pl-3">Inbound</div>
            <div className="text-center pl-3">Issue</div>
            <div className="text-center pl-3">List price & profit</div>
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
                const price = r.currentListedPrice != null ? Number(r.currentListedPrice) : null;
                const cogs = r.costOfGoods != null ? Number(r.costOfGoods) : 0;
                const amazonFee = r.estimatedAmazonFeePerUnit != null ? Number(r.estimatedAmazonFeePerUnit) : 0;
                // Estimated profit = listed price - Amazon fees (total) - COGS; show when we have a listed price
                const estProfit =
                  price != null
                    ? Math.round((price - amazonFee - cogs) * 100) / 100
                    : null;
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
                            {r.currentListedPrice != null && (
                              <span>Price: £{Number(r.currentListedPrice).toFixed(2)}</span>
                            )}
                            {estProfit != null && (
                              <span>Est profit: £{estProfit.toFixed(2)}</span>
                            )}
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
                      className="hidden md:grid grid-cols-[44px_1.2fr_0.9fr_1.5fr_0.75fr_0.55fr_0.55fr_0.55fr_0.55fr_0.55fr_0.55fr_0.8fr] items-center gap-2 px-4 py-3 cursor-pointer hover:bg-[var(--foreground)]/5 transition-colors"
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
                      <div className="truncate text-xs text-[var(--muted-foreground)]">
                        {[r.productType, r.displayGroup].filter(Boolean).join(" · ") || "—"}
                      </div>
                      <div className="text-center pl-3 text-sm font-medium text-[var(--foreground)]">{num(r.totalQty)}</div>
                      <div className="text-center pl-3 text-sm text-[var(--foreground)]">{num(r.availableQty)}</div>
                      <div className="text-center pl-3 text-sm text-[var(--foreground)]">{num(r.reservedQty)}</div>
                      <div className="text-center pl-3 text-sm text-[var(--foreground)]">{num(r.inboundQty)}</div>
                      <div className="text-center pl-3 text-sm text-[var(--foreground)] flex items-center justify-center gap-1">
                        {num(r.issueQty)}
                        <svg className="h-4 w-4 text-[var(--muted-foreground)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                      <div className="text-left pl-3 text-sm text-[var(--foreground)] tabular-nums min-w-0">
                        <div>
                          <span className="font-semibold">Price: </span>
                          {r.currentListedPrice != null ? `£${Number(r.currentListedPrice).toFixed(2)}` : "—"}
                        </div>
                        <div className="text-xs text-[var(--muted-foreground)] mt-0.5">
                          <span className="font-semibold">Est profit: </span>
                          {estProfit != null ? `£${estProfit.toFixed(2)}` : "—"}
                        </div>
                      </div>
                    </div>
                  </Fragment>
                );
              })}
            </div>

            {totalPages > 1 ? (
              <div className="flex items-center justify-end gap-4 border-t border-[var(--surface-border)] bg-[var(--surface)] px-4 py-2">
                <div className="text-sm text-[var(--muted-foreground)]">
                  Page {safePage} of {totalPages}
                  <span className="ml-2">
                    ({(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length})
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
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
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
                  {(detailRow.productType ?? detailRow.displayGroup) ? (
                    <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
                      {[detailRow.productType, detailRow.displayGroup].filter(Boolean).join(" · ")}
                    </p>
                  ) : null}
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
                {detailRow.feeEstimateRawJson != null ? (
                  <div className="mt-4 pt-4 border-t border-[var(--surface-border)]">
                    <h3 className="font-medium text-[var(--foreground)] mb-2">Fee estimate raw response</h3>
                    <pre className="bg-[var(--muted)]/30 rounded-lg p-3 text-xs overflow-x-auto overflow-y-auto max-h-64 whitespace-pre-wrap break-all">
                      {JSON.stringify(detailRow.feeEstimateRawJson, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </SignedIn>
    </div>
  );
}

/** Parses SP-API rawJson (array of summary payloads) into the drilldown tree for the modal. */
function InventoryDetailDrilldown({ rawJson }: { rawJson: unknown }) {
  const payloads = Array.isArray(rawJson) ? rawJson : rawJson != null ? [rawJson] : [];
  if (payloads.length === 0) {
    return (
      <p className="text-[var(--muted-foreground)]">No inventory detail data. Run a sync to populate.</p>
    );
  }

  // Aggregate details across marketplaces
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
    const d = (p as any)?.inventoryDetails ?? (p as any)?.InventoryDetails ?? {};
    const r = d?.reservedQuantity ?? d?.ReservedQuantity ?? {};
    const res = d?.researchingQuantity ?? d?.ResearchingQuantity ?? {};
    const u = d?.unfulfillableQuantity ?? d?.UnfulfillableQuantity ?? {};
    fulfillable += Number(d?.afnFulfillableQuantity ?? d?.fulfillableQuantity ?? 0);
    reservedTotal += Number(r?.totalReservedQuantity ?? r?.total ?? 0);
    fcProcessing += Number(r?.fcProcessingQuantity ?? r?.fcProcessing ?? 0);
    customerOrders += Number(r?.customerOrderQuantity ?? r?.customerOrder ?? 0);
    transshipment += Number(r?.transshipmentQuantity ?? r?.transshipment ?? 0);
    inboundWorking += Number(d?.afnInboundWorkingQuantity ?? 0);
    inboundShipped += Number(d?.afnInboundShippedQuantity ?? 0);
    inboundReceiving += Number(d?.afnInboundReceivingQuantity ?? 0);
    unfulfillable += Number(u?.totalUnfulfillableQuantity ?? u?.total ?? 0);
    researching += Number(res?.totalResearchingQuantity ?? res?.total ?? 0);
    lost += Number(u?.lostQuantity ?? u?.lost ?? 0);
    aged += Number(u?.agedQuantity ?? u?.aged ?? 0);
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

