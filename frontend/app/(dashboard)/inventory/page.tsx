"use client";

import { useAuth, SignedIn, SignedOut } from "@clerk/nextjs";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useDisplaySettings } from "@/contexts/display-settings-context";
import { useMarketplace } from "@/contexts/marketplace-context";
import { SignInButtonWithReturn } from "@/components/sign-in-button-with-return";
import { getDevImpersonationHeaders } from "@/lib/impersonation";

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
  currentListedPriceUpdatedAt?: string | null;
  costOfGoods: number | null;
  feeEstimateRawJson: unknown;
  availableQty: number | null;
  reservedQty: number | null;
  inboundQty: number | null;
  issueQty: number | null;
  totalQty: number | null;
  inventoryUpdatedAt: string | null;
  inventoryMarketplaceMissing?: boolean;
  rawJson: unknown;
  byMarketplace?: Array<{
    marketplaceId: string;
    fulfillableQty: number;
    inboundQty: number;
    reservedQty: number;
    researchingQty: number;
    unfulfillableQty: number;
    currentQty: number;
    fcProcessingQty?: number;
    customerOrdersQty?: number;
    transshipmentQty?: number;
    updatedAt: string | null;
  }>;
};

const SYSTEM_SKUS = new Set(["AMAZON_GENERIC", "AMAZON_MULTI"]);
const PAGE_SIZE = 20;
// When we have no fee estimate at all, use a conservative blended rate so we never show fee-less profit.
const DEFAULT_AMAZON_FEE_RATE_WHEN_UNKNOWN = 0.35;

function formatInventoryMoney(amount: number | null | undefined, currency: string) {
  if (amount == null || !Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
}

/** Per-unit potential profit (same logic as table): needs list price + COGS; Amazon fee is total estimate. */
function inventoryProfitContext(r: InventoryRow) {
  const price = r.currentListedPrice != null ? Number(r.currentListedPrice) : null;
  const cogsRaw = r.costOfGoods != null ? Number(r.costOfGoods) : null;
  const cogs = cogsRaw != null && Number.isFinite(cogsRaw) && cogsRaw > 0 ? cogsRaw : null;
  const amazonTotal =
    r.estimatedAmazonFeePerUnit != null ? Math.abs(Number(r.estimatedAmazonFeePerUnit)) : null;
  const referral =
    r.estimatedReferralFeePerUnit != null ? Math.abs(Number(r.estimatedReferralFeePerUnit)) : null;
  const fba = r.estimatedFbaFeePerUnit != null ? Math.abs(Number(r.estimatedFbaFeePerUnit)) : null;
  const fallbackFromParts =
    referral != null || fba != null ? (referral ?? 0) + (fba ?? 0) : null;
  const amazonFeeForCalc =
    amazonTotal ??
    fallbackFromParts ??
    (price != null && Number.isFinite(price) && price > 0
      ? Math.round(price * DEFAULT_AMAZON_FEE_RATE_WHEN_UNKNOWN * 100) / 100
      : 0);
  const potentialPerUnit =
    price != null && cogs != null
      ? Math.round((price - amazonFeeForCalc - cogs) * 100) / 100
      : null;
  const potentialRoiPct =
    potentialPerUnit != null && cogs != null && cogs > 0
      ? Math.round((potentialPerUnit / cogs) * 1000) / 10
      : null;
  const available = Math.max(0, r.availableQty ?? 0);
  const potentialOnAvailable =
    potentialPerUnit != null && available > 0
      ? Math.round(potentialPerUnit * available * 100) / 100
      : null;
  return {
    price,
    cogs,
    referral,
    fba,
    amazonTotal,
    potentialPerUnit,
    potentialRoiPct,
    potentialOnAvailable,
    available,
    hasCogs: cogs != null,
  };
}

export default function InventoryPage() {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const { isSignedIn, getToken } = useAuth();
  const { selectedMarketplaceId, selectedCurrency } = useMarketplace();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");

  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const fmtRelative = useCallback((iso?: string | null) => {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }, []);
  const [page, setPage] = useState(1);
  const [detailRow, setDetailRow] = useState<InventoryRow | null>(null);
  const [syncingInventory, setSyncingInventory] = useState(false);
  const didAutoSyncStale = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken({ template: "backend" });
      const url = new URL(`${baseUrl}/api/amazon/inventory`);
      if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          ...getDevImpersonationHeaders(devImpersonate),
          ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
        },
      });
      if (!res.ok) throw new Error("Failed to load inventory.");
      const data = (await res.json()) as InventoryRow[];
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, [getToken, baseUrl, selectedMarketplaceId, devImpersonate]);

  const refreshFromAmazon = useCallback(async () => {
    setSyncingInventory(true);
    setNotice(null);
    setError(null);
    try {
      const token = await getToken({ template: "backend" });
      const url = new URL(`${baseUrl}/api/amazon/inventory/sync`);
      if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...getDevImpersonationHeaders(devImpersonate),
          ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || "Inventory sync failed.");
      }
      await load();
      setNotice("Inventory refreshed from Amazon.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not refresh inventory.");
    } finally {
      setSyncingInventory(false);
    }
  }, [getToken, baseUrl, selectedMarketplaceId, devImpersonate, load]);

  useEffect(() => {
    if (!isSignedIn) {
      setRows([]);
      setError(null);
      return;
    }
    void load();
  }, [isSignedIn, load]);

  useEffect(() => {
    if (!isSignedIn || didAutoSyncStale.current || syncingInventory || rows.length === 0) return;
    const maxAgeMs = rows.reduce((max, r) => {
      if (!r.inventoryUpdatedAt) return max;
      const t = Date.parse(r.inventoryUpdatedAt);
      if (!Number.isFinite(t)) return max;
      return Math.max(max, Date.now() - t);
    }, 0);
    if (maxAgeMs > 6 * 60 * 60 * 1000) {
      didAutoSyncStale.current = true;
      void refreshFromAmazon();
    }
  }, [isSignedIn, rows, syncingInventory, refreshFromAmazon]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (SYSTEM_SKUS.has(r.sku)) return false;
      if (!q) return true;
      return (
        r.sku.toLowerCase().includes(q) ||
        (r.asin ?? "").toLowerCase().includes(q) ||
        (r.title ?? "").toLowerCase().includes(q)
      );
    });
    return [...list].sort((a, b) => (b.totalQty ?? 0) - (a.totalQty ?? 0));
  }, [rows, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(
    () =>
      filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  );

  const fcTransferQtyForRow = useCallback(
    (r: InventoryRow): number | null => {
      const list = r.byMarketplace ?? [];
      if (list.length === 0) return null;
      if (selectedMarketplaceId) {
        const mp = list.find((m) => m.marketplaceId === selectedMarketplaceId);
        const v = mp?.transshipmentQty ?? null;
        return v != null ? Number(v) : null;
      }
      const sum = list.reduce((acc, m) => acc + Number(m.transshipmentQty ?? 0), 0);
      return sum;
    },
    [selectedMarketplaceId],
  );

  const inventoryTotals = useMemo(() => {
    let available = 0;
    let reserved = 0;
    let inbound = 0;
    let fcTransfer = 0;
    let total = 0;
    for (const r of filtered) {
      available += r.availableQty ?? 0;
      reserved += r.reservedQty ?? 0;
      inbound += r.inboundQty ?? 0;
      fcTransfer += fcTransferQtyForRow(r) ?? 0;
      total += r.totalQty ?? 0;
    }
    return { available, reserved, inbound, fcTransfer, total };
  }, [filtered, fcTransferQtyForRow]);

  useEffect(() => {
    setPage(1);
  }, [query]);

  const { backgroundClass } = useDisplaySettings();

  return (
    <div className={`min-h-screen w-full ${backgroundClass} px-4 py-6`}>
      <div className="mb-4 rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Inventory</h1>
          <SignedIn>
            <button
              type="button"
              onClick={() => void refreshFromAmazon()}
              disabled={syncingInventory || loading}
              className="cursor-pointer rounded-lg bg-sb-accent px-3 py-2 text-sm font-medium text-black disabled:cursor-not-allowed disabled:opacity-50"
            >
              {syncingInventory ? "Refreshing from Amazon…" : "Refresh from Amazon"}
            </button>
          </SignedIn>
        </div>
        <SignedIn>
          <label className="mt-3 block text-xs font-medium text-[var(--muted-foreground)]" htmlFor="inventory-search">
            Search
          </label>
          <input
            id="inventory-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by SKU, ASIN, or title…"
            autoComplete="off"
            className="mt-1.5 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm text-neutral-900 shadow-sm outline-none placeholder:text-neutral-500 focus:border-neutral-300 focus:ring-2 focus:ring-neutral-400/30"
          />
        </SignedIn>
      </div>

      <SignedOut>
        <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-4 text-sm text-[var(--muted-foreground)]">
          <div className="mb-3">Sign in to view Inventory.</div>
          <SignInButtonWithReturn>
            <button className="cursor-pointer rounded-lg bg-sb-accent px-3 py-2 text-sm font-medium text-black">
              Sign in
            </button>
          </SignInButtonWithReturn>
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
              <span className="text-sm text-[var(--muted-foreground)]">FC transfer </span>
              <span className="text-lg font-semibold tabular-nums text-[var(--foreground)]">{inventoryTotals.fcTransfer.toLocaleString()}</span>
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl bg-[var(--surface)] ring-1 ring-[var(--surface-border)]">
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
            <div className="hidden md:grid grid-cols-[40px_1.6fr_0.9fr_0.7fr_0.65fr_0.5fr_0.5fr_0.5fr_0.5fr_0.5fr_0.5fr_0.5fr_0.5fr_0.45fr_32px] gap-2 bg-[var(--surface)] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              <div />
              <div className="text-left">Title</div>
              <div className="text-left">SKU</div>
              <div className="text-left">ASIN</div>
              <div className="text-left">Type / Group</div>
              <div className="text-center">Total</div>
              <div className="text-center">Available</div>
              <div className="text-center">Reserved</div>
              <div className="text-center">Inbound</div>
              <div className="text-center">FC transfer</div>
              <div className="text-left pl-2">
                <div>List</div>
                <div>price</div>
              </div>
              <div className="text-right leading-tight">
                <div>Potential</div>
                <div>profit</div>
              </div>
              <div className="text-right leading-tight">
                <div>Potential</div>
                <div>ROI</div>
              </div>
              <div />
            </div>

            <div className="divide-y divide-[var(--surface-border)] bg-transparent">
              {paginated.map((r) => {
                const isSystem = SYSTEM_SKUS.has(r.sku);
                const num = (n: number | null) => (n == null ? "—" : String(n));
                const profitCtx = inventoryProfitContext(r);
                const estProfit = profitCtx.potentialPerUnit;
                const marketplaceLine =
                  r.byMarketplace && r.byMarketplace.length > 0
                    ? r.byMarketplace
                        .filter((m) => (m.fulfillableQty ?? 0) > 0)
                        .map((m) => `${marketplaceShortLabel(m.marketplaceId)} ${m.fulfillableQty}`)
                        .join(" · ")
                    : null;

                return (
                  <Fragment key={r.productId}>
                    {/* Mobile card */}
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
                          <div className="truncate text-sm font-medium text-[var(--foreground)]">{r.title ?? r.sku}</div>
                          <div className="mt-0.5 truncate text-xs text-[var(--muted-foreground)]">SKU {r.sku} · ASIN {r.asin ?? "—"}</div>
                          {marketplaceLine ? (
                            <div className="mt-1 truncate text-xs text-[var(--muted-foreground)]">{marketplaceLine}</div>
                          ) : null}
                          {isSystem ? (
                            <div className="mt-1 text-xs text-[var(--muted-foreground)]">System SKU</div>
                          ) : null}
                          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted-foreground)]">
                            <span className="font-medium text-[var(--foreground)]">Total {num(r.totalQty)}</span>
                            <span>Available {num(r.availableQty)}</span>
                            <span>Reserved {num(r.reservedQty)}</span>
                            <span>Inbound {num(r.inboundQty)}</span>
                            <span>FC transfer {fcTransferQtyForRow(r) == null ? "—" : String(fcTransferQtyForRow(r))}</span>
                            {r.currentListedPrice != null && (
                              <span>
                                Price:{" "}
                                {new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(Number(r.currentListedPrice))}
                                {fmtRelative(r.currentListedPriceUpdatedAt) ? (
                                  <span className="ml-1 text-[10px] text-[var(--muted-foreground)]">
                                    (refreshed {fmtRelative(r.currentListedPriceUpdatedAt)})
                                  </span>
                                ) : null}
                              </span>
                            )}
                            {estProfit != null && (
                              <span>
                                Potential profit:{" "}
                                {new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(estProfit)}
                              </span>
                            )}
                            {profitCtx.potentialRoiPct != null && (
                              <span>
                                Potential ROI:{" "}
                                <span className="font-medium text-[var(--foreground)] tabular-nums">
                                  {profitCtx.potentialRoiPct.toFixed(1)}%
                                </span>
                              </span>
                            )}
                          </div>
                        </div>
                        <svg className="h-5 w-5 shrink-0 text-[var(--muted-foreground)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>

                    {/* Desktop row — one row div with 12 cells inside */}
                    <div
                      key={`${r.productId}-desktop`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setDetailRow(r)}
                      onKeyDown={(e) => e.key === "Enter" && setDetailRow(r)}
                      className="hidden md:grid grid-cols-[40px_1.6fr_0.9fr_0.7fr_0.65fr_0.5fr_0.5fr_0.5fr_0.5fr_0.5fr_0.5fr_0.5fr_0.5fr_0.45fr_32px] items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[var(--foreground)]/5 transition-colors"
                    >
                      <div className="flex items-center justify-center">
                        {r.imageUrl ? (
                          <img
                            src={r.imageUrl}
                            alt={r.title ?? r.sku}
                            className="h-8 w-8 rounded-md object-cover ring-1 ring-[var(--surface-border)]"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="h-8 w-8 rounded-md bg-[var(--surface)] ring-1 ring-[var(--surface-border)]" />
                        )}
                      </div>
                      <div className="min-w-0 truncate text-[11px] text-[var(--foreground)] text-left">
                        {r.title ?? "—"}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-medium text-[var(--foreground)]">{r.sku}</div>
                        {marketplaceLine ? (
                          <div className="mt-0.5 truncate text-[10px] text-[var(--muted-foreground)]">{marketplaceLine}</div>
                        ) : null}
                        {isSystem ? (
                          <div className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">System SKU</div>
                        ) : null}
                      </div>
                      <div className="truncate text-[11px] text-[var(--muted-foreground)] text-left">{r.asin ?? "—"}</div>
                      <div className="truncate text-[10px] text-[var(--muted-foreground)] text-left">
                        {[r.productType, r.displayGroup].filter(Boolean).join(" · ") || "—"}
                      </div>
                      <div className="text-center text-[11px] font-medium text-[var(--foreground)] tabular-nums">{num(r.totalQty)}</div>
                      <div className="text-center text-[11px] text-[var(--foreground)] tabular-nums">{num(r.availableQty)}</div>
                      <div className="text-center text-[11px] text-[var(--foreground)] tabular-nums">{num(r.reservedQty)}</div>
                      <div className="text-center text-[11px] text-[var(--foreground)] tabular-nums">{num(r.inboundQty)}</div>
                      <div className="text-center text-[11px] text-[var(--foreground)] tabular-nums">
                        {fcTransferQtyForRow(r) == null ? "—" : String(fcTransferQtyForRow(r))}
                      </div>
                      <div className="text-left min-w-0 pl-2">
                        <div className="text-[11px] text-[var(--foreground)] tabular-nums">
                          {r.currentListedPrice != null
                            ? new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(Number(r.currentListedPrice))
                            : "—"}
                        </div>
                        {fmtRelative(r.currentListedPriceUpdatedAt) ? (
                          <div className="mt-0.5 truncate text-[9px] text-[var(--muted-foreground)]">
                            refreshed {fmtRelative(r.currentListedPriceUpdatedAt)}
                          </div>
                        ) : null}
                      </div>
                      <div className="text-right text-[11px] text-[var(--foreground)] tabular-nums min-w-0">
                        {estProfit != null ? new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(estProfit) : "—"}
                      </div>
                      <div className="text-right text-[11px] text-[var(--foreground)] tabular-nums min-w-0">
                        {profitCtx.potentialRoiPct != null ? `${profitCtx.potentialRoiPct.toFixed(1)}%` : "—"}
                      </div>
                      <div className="flex items-center justify-center">
                        <svg className="h-4 w-4 text-[var(--muted-foreground)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
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

        {/* Inventory detail modal */}
        {detailRow ? (
          <InventoryDetailModal
            row={detailRow}
            currency={selectedCurrency}
            marketplaceId={selectedMarketplaceId}
            fmtRelative={fmtRelative}
            onClose={() => setDetailRow(null)}
            onRefreshFromAmazon={() => void refreshFromAmazon()}
            refreshing={syncingInventory}
          />
        ) : null}
      </SignedIn>
    </div>
  );
}

function marketplaceShortLabel(marketplaceId: string): string {
  if (marketplaceId === "A1F83G8C2ARO7P") return "UK";
  if (marketplaceId === "A1PA6795UKMFR9") return "DE";
  if (marketplaceId === "A13V1IB3VIYZZH") return "FR";
  if (marketplaceId === "APJ6JRA9NG5V4") return "IT";
  if (marketplaceId === "A1RKKUPIHCS9HS") return "ES";
  if (marketplaceId === "ATVPDKIKX0DER") return "US";
  return marketplaceId;
}

type MpSlice = NonNullable<InventoryRow["byMarketplace"]>[number];

const MP_METRIC_FIELDS: Array<{ key: keyof Pick<MpSlice, "fulfillableQty" | "inboundQty" | "reservedQty" | "researchingQty" | "unfulfillableQty" | "currentQty">; label: string }> = [
  { key: "fulfillableQty", label: "Fulfillable" },
  { key: "inboundQty", label: "Inbound" },
  { key: "reservedQty", label: "Reserved" },
  { key: "researchingQty", label: "Researching" },
  { key: "unfulfillableQty", label: "Unfulfillable" },
  { key: "currentQty", label: "Current" },
];

/** Only columns where at least one marketplace has a non-zero value; only rows with activity in those columns. */
function activeMarketplaceTable(rows: NonNullable<InventoryRow["byMarketplace"]>) {
  const fields = MP_METRIC_FIELDS.filter((f) =>
    rows.some((m) => Number(m[f.key] ?? 0) !== 0),
  );
  const activeRows = rows.filter((m) =>
    fields.some((f) => Number(m[f.key] ?? 0) !== 0),
  );
  return { fields, activeRows };
}

function inventoryStaleHours(iso?: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 3600000;
}

function InventoryDetailModal({
  row,
  currency,
  marketplaceId,
  fmtRelative,
  onClose,
  onRefreshFromAmazon,
  refreshing,
}: {
  row: InventoryRow;
  currency: string;
  marketplaceId: string | null;
  fmtRelative: (iso?: string | null) => string | null;
  onClose: () => void;
  onRefreshFromAmazon: () => void;
  refreshing: boolean;
}) {
  const p = inventoryProfitContext(row);
  const num = (n: number | null) => (n == null ? "—" : String(n));
  const fcTransferQty =
    marketplaceId && row.byMarketplace
      ? row.byMarketplace.find((m) => m.marketplaceId === marketplaceId)?.transshipmentQty ?? null
      : row.byMarketplace
        ? row.byMarketplace.reduce((acc, m) => acc + Number(m.transshipmentQty ?? 0), 0)
        : null;
  const mpSlice = marketplaceId
    ? row.byMarketplace?.find((m) => m.marketplaceId === marketplaceId)
    : row.byMarketplace?.[0];
  const staleHours = inventoryStaleHours(row.inventoryUpdatedAt);
  const isStale = staleHours != null && staleHours >= 6;

  const profitRow = (label: string, value: string, sub?: string) => (
    <div className="flex justify-between gap-4 border-b border-[var(--surface-border)]/60 py-2 last:border-0">
      <div>
        <span className="text-[var(--foreground)]">{label}</span>
        {sub ? <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">{sub}</p> : null}
      </div>
      <span className="shrink-0 font-medium tabular-nums text-[var(--foreground)]">{value}</span>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="inventory-detail-title"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--surface-border)] bg-[var(--background)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--surface-border)] px-4 py-3">
          <div className="flex min-w-0 flex-1 gap-3">
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg ring-1 ring-[var(--surface-border)]">
              {row.imageUrl ? (
                <img
                  src={row.imageUrl}
                  alt={row.title ?? row.sku}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="h-full w-full bg-[var(--surface)]" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="inventory-detail-title" className="text-lg font-semibold leading-snug text-[var(--foreground)]">
                {row.title ?? row.sku}
              </h2>
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                SKU {row.sku}
                {row.asin ? ` · ASIN ${row.asin}` : ""}
              </p>
              {(row.productType ?? row.displayGroup) ? (
                <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                  {[row.productType, row.displayGroup].filter(Boolean).join(" · ")}
                </p>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg p-2 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 text-sm">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              Inventory status
            </h3>
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-[var(--surface-border)] bg-[var(--surface)]/40 p-3 sm:grid-cols-5">
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Total</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums text-[var(--foreground)]">{num(row.totalQty)}</div>
              </div>
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Available</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums text-[var(--foreground)]">{num(row.availableQty)}</div>
              </div>
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Reserved</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums text-[var(--foreground)]">{num(row.reservedQty)}</div>
              </div>
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Inbound</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums text-[var(--foreground)]">{num(row.inboundQty)}</div>
              </div>
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">FC transfer</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums text-[var(--foreground)]">
                  {fcTransferQty == null ? "—" : String(fcTransferQty)}
                </div>
              </div>
            </div>
            {row.inventoryMarketplaceMissing ? (
              <p className="mt-2 text-xs text-amber-200">
                No FBA inventory row for {marketplaceId ? marketplaceShortLabel(marketplaceId) : "this marketplace"} yet — refresh from Amazon.
              </p>
            ) : null}
            {row.inventoryUpdatedAt ? (
              <p className="mt-2 text-xs text-[var(--muted-foreground)]">
                Inventory figures updated {fmtRelative(row.inventoryUpdatedAt) ?? row.inventoryUpdatedAt}
                {marketplaceId ? ` (${marketplaceShortLabel(marketplaceId)})` : ""}
                {" · "}
                Reserved = customer orders (matches Seller Central)
              </p>
            ) : null}
            {isStale ? (
              <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                <p>
                  These counts may not match Seller Central — last Amazon sync was{" "}
                  {fmtRelative(row.inventoryUpdatedAt) ?? "a while ago"}. Reserved/available change when
                  orders sell or ship; refresh to pull live FBA numbers.
                </p>
                <button
                  type="button"
                  onClick={onRefreshFromAmazon}
                  disabled={refreshing}
                  className="mt-2 cursor-pointer rounded-md bg-sb-accent px-2.5 py-1 text-[11px] font-semibold text-black disabled:opacity-50"
                >
                  {refreshing ? "Refreshing…" : "Refresh from Amazon"}
                </button>
              </div>
            ) : null}
            {mpSlice &&
            ((mpSlice.fcProcessingQty ?? 0) > 0 || (mpSlice.transshipmentQty ?? 0) > 0) ? (
              <p className="mt-2 text-[10px] text-[var(--muted-foreground)]">
                Other FBA holds: FC processing {num(mpSlice.fcProcessingQty ?? 0)}
                {(mpSlice.transshipmentQty ?? 0) > 0
                  ? ` · transshipment ${num(mpSlice.transshipmentQty ?? 0)}`
                  : ""}
                {" "}(shown under FC transfer on the grid)
              </p>
            ) : null}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              Potential profit breakdown (per unit)
            </h3>
            <p className="mb-3 text-xs text-[var(--muted-foreground)]">
              Uses your listed price, estimated Amazon fees (referral + FBA when split out, or combined total), and cost of goods from your ledger. Without COGS, potential profit is not shown on the grid.
            </p>
            <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)]/40 px-3 py-1">
              {profitRow(
                "Listed price",
                formatInventoryMoney(p.price, currency),
                row.currentListedPriceUpdatedAt
                  ? `Refreshed ${fmtRelative(row.currentListedPriceUpdatedAt) ?? ""}`.trim()
                  : undefined,
              )}
              {profitRow(
                "Est. referral fee (per unit)",
                p.referral != null ? formatInventoryMoney(p.referral, currency) : "—",
                "From product fee estimates",
              )}
              {profitRow(
                "Est. FBA fee (per unit)",
                p.fba != null ? formatInventoryMoney(p.fba, currency) : "—",
                "From product fee estimates",
              )}
              {profitRow(
                "Total est. Amazon fees (per unit)",
                p.amazonTotal != null ? formatInventoryMoney(p.amazonTotal, currency) : "—",
                row.estimatedAmazonFeeUpdatedAt
                  ? `Updated ${fmtRelative(row.estimatedAmazonFeeUpdatedAt) ?? ""}`.trim()
                  : undefined,
              )}
              {profitRow(
                "Cost of goods (per unit)",
                p.cogs != null ? formatInventoryMoney(p.cogs, currency) : "—",
                p.hasCogs ? undefined : "Add COGS in Cost of goods to see potential profit",
              )}
              {profitRow(
                "Potential profit (per unit)",
                p.potentialPerUnit != null ? formatInventoryMoney(p.potentialPerUnit, currency) : "—",
                "Listed price − Amazon fees − COGS",
              )}
              {profitRow(
                "Potential ROI (per unit)",
                p.potentialRoiPct != null ? `${p.potentialRoiPct.toFixed(1)}%` : "—",
                "Potential profit ÷ COGS",
              )}
            </div>
            {p.potentialPerUnit != null && p.available > 0 ? (
              <div className="mt-3 rounded-lg border border-[var(--surface-border)] bg-[var(--foreground)]/5 px-3 py-2">
                <div className="flex justify-between gap-4">
                  <span className="font-medium text-[var(--foreground)]">
                    On {p.available.toLocaleString()} available unit{p.available === 1 ? "" : "s"}
                  </span>
                  <span className="font-semibold tabular-nums text-[var(--foreground)]">
                    {formatInventoryMoney(p.potentialOnAvailable, currency)}
                  </span>
                </div>
                <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
                  Potential profit per unit × fulfillable quantity (same marketplace view as the table).
                </p>
              </div>
            ) : null}
          </section>

          {row.byMarketplace && row.byMarketplace.length > 0 ? (() => {
            const { fields, activeRows } = activeMarketplaceTable(row.byMarketplace);
            if (fields.length === 0 || activeRows.length === 0) return null;
            return (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                  By marketplace
                </h3>
                <div className="overflow-x-auto rounded-lg border border-[var(--surface-border)]">
                  <table className="w-full min-w-0 text-left text-xs">
                    <thead>
                      <tr className="border-b border-[var(--surface-border)] bg-[var(--surface)]/50 text-[var(--muted-foreground)]">
                        <th className="px-3 py-2 font-semibold">Marketplace</th>
                        {fields.map((f) => (
                          <th key={f.key} className="px-3 py-2 text-right font-semibold">
                            {f.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {activeRows.map((m) => (
                        <tr key={m.marketplaceId} className="border-b border-[var(--surface-border)]/60 last:border-0">
                          <td className="px-3 py-2 font-medium text-[var(--foreground)]">
                            {marketplaceShortLabel(m.marketplaceId)}
                          </td>
                          {fields.map((f) => (
                            <td
                              key={f.key}
                              className={`px-3 py-2 text-right tabular-nums text-[var(--foreground)]${f.key === "currentQty" ? " font-medium" : ""}`}
                            >
                              {Number(m[f.key] ?? 0)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })() : null}
        </div>
      </div>
    </div>
  );
}
