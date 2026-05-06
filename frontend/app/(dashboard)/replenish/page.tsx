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

type SmartReplenishRow = {
  productId: string;
  imageUrl: string | null;
  title: string | null;
  sku: string;
  asin: string | null;
  lastSold: string | null;
  fulfillableQty: number;
  inboundQty: number;
  effectiveStock: number;
  avgDailyUnits: number;
  daysOfCover: number | null;
  avgGrossProfitPerUnit: number | null;
  roi: number | null;
  suggestedBuyQty: number;
  maxBuyPriceBreakEvenPerUnit: number | null;
  maxBuyPriceForTargetsPerUnit: number | null;
  supplier: string | null;
  supplierLink: string | null;
  latestCogsEntry:
    | {
        purchaseDate: string;
        currency: string;
        vatRatePct: number;
        bundleSize: number;
        qtyPurchased: number;
        qtyDelivered: number;
        unitCostIncVat: number;
        deliveryCostIncVat: number;
        prepCostIncVat: number;
        totalCostIncVat: number;
      }
    | null;
  lastBuyUnitCostIncVat: number | null;
  expectedProfitPerUnitAtLastBuy: number | null;
  expectedProfitTotalAtLastBuy: number | null;
  rationale: string;
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
  const SMART_PERIOD_DAYS = 30;
  const SMART_SNOOZE_DAYS = 7;

  const [rows, setRows] = useState<ReplenishRow[]>([]);
  const [smart, setSmart] = useState<SmartReplenishRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const [smartTargetCoverDays, setSmartTargetCoverDays] = useState(45);
  const [smartTargetProfitPerUnit, setSmartTargetProfitPerUnit] = useState(1);
  const [smartTargetRoiPct, setSmartTargetRoiPct] = useState(15);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsItem, setDetailsItem] = useState<SmartReplenishRow | null>(null);
  const [smartStatusByProductId, setSmartStatusByProductId] = useState<
    Record<string, { status: "replenished" | "unavailable"; untilMs: number } | undefined>
  >({});
  const [smartStatusLoaded, setSmartStatusLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken({ template: "backend" });
      const url = new URL(`${baseUrl}/api/amazon/replenish`);
      url.searchParams.set("limit", "10000");
      if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
      const smartUrl = new URL(`${baseUrl}/api/amazon/replenish/smart`);
      smartUrl.searchParams.set("take", "12");
      smartUrl.searchParams.set("periodDays", String(SMART_PERIOD_DAYS));
      smartUrl.searchParams.set("targetCoverDays", String(smartTargetCoverDays));
      smartUrl.searchParams.set("minProfitPerUnit", String(smartTargetProfitPerUnit));
      smartUrl.searchParams.set("minRoi", String((smartTargetRoiPct || 0) / 100));
      if (devImpersonate) smartUrl.searchParams.set("impersonate", devImpersonate);

      const headers = {
        Authorization: `Bearer ${token}`,
        ...getDevImpersonationHeaders(devImpersonate),
        ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
      };

      const [res, smartRes] = await Promise.all([
        fetch(url.toString(), {
          headers,
          credentials: "include",
        }),
        fetch(smartUrl.toString(), {
          headers,
          credentials: "include",
        }),
      ]);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Request failed (${res.status})`);
      }
      const data = (await res.json()) as ReplenishRow[];
      setRows(data);

      if (smartRes.ok) {
        const smartData = (await smartRes.json()) as SmartReplenishRow[];
        setSmart(Array.isArray(smartData) ? smartData : []);
      } else {
        setSmart([]);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Error";
      setError(message === "Failed to fetch" ? "Could not reach the API. Ensure the backend is running." : message);
    } finally {
      setLoading(false);
    }
  }, [
    getToken,
    baseUrl,
    selectedMarketplaceId,
    devImpersonate,
    smartTargetCoverDays,
    smartTargetProfitPerUnit,
    smartTargetRoiPct,
  ]);

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

  const smartNow = Date.now();
  const smartStatusActiveByProductId = useMemo(() => {
    const out: Record<string, { status: "replenished" | "unavailable"; untilMs: number }> = {};
    for (const [productId, v] of Object.entries(smartStatusByProductId)) {
      if (!v) continue;
      if (v.untilMs > smartNow) out[productId] = v;
    }
    return out;
  }, [smartStatusByProductId, smartNow]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("sb.smartReplenishStatus.v1");
    if (!raw) {
      setSmartStatusLoaded(true);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Record<
        string,
        { status: "replenished" | "unavailable"; untilMs: number }
      >;
      if (!parsed || typeof parsed !== "object") return;
      setSmartStatusByProductId(parsed);
    } catch {
      // ignore
    }
    setSmartStatusLoaded(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!smartStatusLoaded) return;
    // Persist, but only active entries.
    window.localStorage.setItem(
      "sb.smartReplenishStatus.v1",
      JSON.stringify(smartStatusActiveByProductId)
    );
  }, [smartStatusActiveByProductId, smartStatusLoaded]);

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

  const clampNum = (raw: string, { min, max }: { min: number; max: number }) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, n));
  };

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

        {!loading && smart.length > 0 && (
          <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3">
            <div className="flex flex-col items-start gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-[var(--foreground)]">
                  Smart replenishment
                </h2>
                <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                  Suggestions based on sales velocity, inbound pipeline, profit and ROI. Target cover:{" "}
                  <span className="font-medium text-[var(--foreground)]">
                    {smartTargetCoverDays}d
                  </span>
                </p>
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setTargetsOpen(true)}
                    className="rounded-lg border border-white/40 bg-white/10 px-3 py-2 text-xs font-semibold text-[var(--foreground)] shadow-sm hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-sb-accent"
                  >
                    Smart replenishment targets
                  </button>
                </div>
              </div>
            </div>

            {targetsOpen && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
                role="dialog"
                aria-modal="true"
                aria-label="Smart replenishment targets"
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) setTargetsOpen(false);
                }}
              >
                <div className="w-full max-w-lg rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-4 shadow-lg">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-[var(--foreground)]">
                        Smart replenishment targets
                      </div>
                      <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                        Adjust targets and the suggestions (and max buy targets) will update.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTargetsOpen(false)}
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--surface-border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                      aria-label="Close targets"
                    >
                      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-medium text-[var(--muted-foreground)]">
                        Target cover (days)
                      </span>
                      <input
                        inputMode="numeric"
                        value={String(smartTargetCoverDays)}
                        onChange={(e) => {
                          const v = clampNum(e.target.value, { min: 7, max: 180 });
                          if (v == null) return;
                          setSmartTargetCoverDays(Math.round(v));
                        }}
                        className="h-9 rounded-lg border border-[var(--surface-border)] bg-white px-3 text-sm text-black focus:outline-none focus:ring-2 focus:ring-sb-accent dark:bg-white"
                      />
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-medium text-[var(--muted-foreground)]">
                        Target ROI (%)
                      </span>
                      <input
                        inputMode="decimal"
                        value={String(smartTargetRoiPct)}
                        onChange={(e) => {
                          const v = clampNum(e.target.value, { min: 0, max: 1000 });
                          if (v == null) return;
                          setSmartTargetRoiPct(Math.round(v * 100) / 100);
                        }}
                        className="h-9 rounded-lg border border-[var(--surface-border)] bg-white px-3 text-sm text-black focus:outline-none focus:ring-2 focus:ring-sb-accent dark:bg-white"
                      />
                    </label>

                    <label className="flex flex-col gap-1 sm:col-span-2">
                      <span className="text-[11px] font-medium text-[var(--muted-foreground)]">
                        Target profit / unit
                      </span>
                      <input
                        inputMode="decimal"
                        value={String(smartTargetProfitPerUnit)}
                        onChange={(e) => {
                          const v = clampNum(e.target.value, { min: 0, max: 9999 });
                          if (v == null) return;
                          setSmartTargetProfitPerUnit(Math.round(v * 100) / 100);
                        }}
                        className="h-9 rounded-lg border border-[var(--surface-border)] bg-white px-3 text-sm text-black focus:outline-none focus:ring-2 focus:ring-sb-accent dark:bg-white"
                      />
                    </label>
                  </div>

                  <div className="mt-4 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setTargetsOpen(false)}
                      className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                    >
                      Done
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {smart.slice(0, 12).map((s) => {
                const active = smartStatusActiveByProductId[s.productId];
                const isRepl = active?.status === "replenished";
                const isUnav = active?.status === "unavailable";
                const cardBorder = isRepl
                  ? "border-emerald-500/70"
                  : isUnav
                    ? "border-red-500/70"
                    : "border-[var(--surface-border)]";
                const cardOpacity = active ? "opacity-50" : "opacity-100";
                return (
                <div
                  key={s.productId}
                  className={`flex cursor-pointer gap-3 rounded-lg border bg-[var(--background)] p-3 ${cardBorder} ${cardOpacity} hover:bg-[var(--foreground)]/5`}
                  onClick={(e) => {
                    const target = e.target as HTMLElement | null;
                    if (target?.closest("button, a")) return;
                    setDetailsItem(s);
                    setDetailsOpen(true);
                  }}
                >
                  <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-md border border-[var(--surface-border)] bg-[var(--surface)]">
                    {s.imageUrl ? (
                      <img src={s.imageUrl} alt="" className="h-full w-full object-contain" />
                    ) : (
                      <span className="text-[10px] text-[var(--muted-foreground)]">No image</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-1 text-xs font-medium text-[var(--foreground)]">
                      {s.title ?? s.sku}
                    </div>
                    {s.asin && (
                      <div className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
                        ASIN{" "}
                        <span className="font-mono text-[var(--foreground)]">
                          {s.asin}
                        </span>
                      </div>
                    )}
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--muted-foreground)]">
                      <span className="tabular-nums">
                        Suggest{" "}
                        <span className="font-semibold text-[var(--foreground)]">
                          {s.suggestedBuyQty}
                        </span>
                      </span>
                      {s.daysOfCover != null && (
                        <span className="tabular-nums">
                          Current cover{" "}
                          <span className="text-[var(--foreground)]">
                            {s.daysOfCover}d
                          </span>
                        </span>
                      )}
                      {s.roi != null && (
                        <span className="tabular-nums">
                          ROI{" "}
                          <span className="text-[var(--foreground)]">
                            {Math.round(s.roi * 100)}%
                          </span>
                        </span>
                      )}
                      {s.lastBuyUnitCostIncVat != null && (
                        <span className="tabular-nums">
                          Last buy{" "}
                          <span className="text-[var(--foreground)]">
                            {new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(s.lastBuyUnitCostIncVat)}
                          </span>
                        </span>
                      )}
                      {s.lastSold && (
                        <span className="tabular-nums">
                          Last sold{" "}
                          <span className="text-[var(--foreground)]">{formatDate(s.lastSold)}</span>
                        </span>
                      )}
                      {s.maxBuyPriceBreakEvenPerUnit != null && (
                        <span className="tabular-nums">
                          Max buy (break-even){" "}
                          <span className="text-[var(--foreground)]">
                            {new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(s.maxBuyPriceBreakEvenPerUnit)}
                          </span>
                        </span>
                      )}
                      {s.maxBuyPriceForTargetsPerUnit != null && (
                        <span className="tabular-nums">
                          Target buy ≤{" "}
                          <span className="text-[var(--foreground)]">
                            {new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(s.maxBuyPriceForTargetsPerUnit)}
                          </span>
                        </span>
                      )}
                    </div>
                    {(s.supplier || s.expectedProfitTotalAtLastBuy != null) && (
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--muted-foreground)]">
                        {s.supplier && (
                          <span className="line-clamp-1">
                            Supplier{" "}
                            <span className="text-[var(--foreground)]">
                              {s.supplier}
                            </span>
                          </span>
                        )}
                        {s.supplierLink && (
                          <a
                            href={s.supplierLink}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[11px] font-medium text-sb-accent hover:underline"
                          >
                            Supplier link
                          </a>
                        )}
                        {s.expectedProfitTotalAtLastBuy != null && (
                          <span className="tabular-nums">
                            Exp. profit{" "}
                            <span className="text-[var(--foreground)]">
                              {new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(s.expectedProfitTotalAtLastBuy)}
                            </span>
                          </span>
                        )}
                      </div>
                    )}
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1 truncate text-[11px] text-[var(--muted-foreground)]">
                        demand={(Math.round((s.avgDailyUnits ?? 0) * 100) / 100).toFixed(2)}/day • stock=
                        {Math.max(0, Math.round((s.fulfillableQty ?? 0) + (s.inboundQty ?? 0)))} •
                        {s.daysOfCover != null ? ` cover≈${Math.round(s.daysOfCover)}d` : ""}
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            const untilMs = Date.now() + SMART_SNOOZE_DAYS * 24 * 60 * 60 * 1000;
                            setSmartStatusByProductId((prev) => {
                              const curr = prev[s.productId];
                              if (curr?.status === "replenished" && curr.untilMs > Date.now()) {
                                const next = { ...prev };
                                delete next[s.productId];
                                return next;
                              }
                              return { ...prev, [s.productId]: { status: "replenished", untilMs } };
                            });
                          }}
                          className="rounded-md bg-emerald-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-emerald-600"
                        >
                          Replenished
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            const untilMs = Date.now() + SMART_SNOOZE_DAYS * 24 * 60 * 60 * 1000;
                            setSmartStatusByProductId((prev) => {
                              const curr = prev[s.productId];
                              if (curr?.status === "unavailable" && curr.untilMs > Date.now()) {
                                const next = { ...prev };
                                delete next[s.productId];
                                return next;
                              }
                              return { ...prev, [s.productId]: { status: "unavailable", untilMs } };
                            });
                          }}
                          className="rounded-md bg-red-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-red-600"
                        >
                          Unavailable
                        </button>
                        {active && (
                          <span className="text-[10px] text-[var(--muted-foreground)]">
                            Snoozed {SMART_SNOOZE_DAYS}d
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                );
              })}
            </div>

            {detailsOpen && detailsItem && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
                role="dialog"
                aria-modal="true"
                aria-label="Smart replenishment details"
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) setDetailsOpen(false);
                }}
              >
                <div className="w-full max-w-2xl rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-4 shadow-lg">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[var(--foreground)]">
                        {detailsItem.title ?? detailsItem.sku}
                      </div>
                      <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                        {detailsItem.asin ? (
                          <>
                            ASIN{" "}
                            <span className="font-mono text-[var(--foreground)]">
                              {detailsItem.asin}
                            </span>
                          </>
                        ) : (
                          <span className="font-mono">{detailsItem.sku}</span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDetailsOpen(false)}
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--surface-border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                      aria-label="Close details"
                    >
                      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                        Suggested restock
                      </div>
                      <div className="mt-1 text-sm text-[var(--foreground)]">
                        Buy{" "}
                        <span className="font-semibold tabular-nums">
                          {detailsItem.suggestedBuyQty}
                        </span>{" "}
                        units
                      </div>
                      <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                        Current cover{" "}
                        <span className="tabular-nums text-[var(--foreground)]">
                          {detailsItem.daysOfCover ?? "—"}d
                        </span>{" "}
                        · Target cover{" "}
                        <span className="tabular-nums text-[var(--foreground)]">
                          {smartTargetCoverDays}d
                        </span>
                      </div>
                    </div>

                    <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                        Pricing caps
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--muted-foreground)]">
                        {detailsItem.maxBuyPriceBreakEvenPerUnit != null && (
                          <span className="tabular-nums">
                            Break-even{" "}
                            <span className="text-[var(--foreground)]">
                              {new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(detailsItem.maxBuyPriceBreakEvenPerUnit)}
                            </span>
                          </span>
                        )}
                        {detailsItem.maxBuyPriceForTargetsPerUnit != null && (
                          <span className="tabular-nums">
                            Targets{" "}
                            <span className="text-[var(--foreground)]">
                              {new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(detailsItem.maxBuyPriceForTargetsPerUnit)}
                            </span>
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                        Targets: profit/unit{" "}
                        <span className="tabular-nums text-[var(--foreground)]">
                          {new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(smartTargetProfitPerUnit)}
                        </span>{" "}
                        · ROI{" "}
                        <span className="tabular-nums text-[var(--foreground)]">
                          {smartTargetRoiPct}%
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 rounded-lg border border-[var(--surface-border)] bg-[var(--background)] p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                      COGS (latest ledger entry)
                    </div>
                    {detailsItem.latestCogsEntry ? (
                      <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                          <span className="tabular-nums">
                            Unit{" "}
                            <span className="text-[var(--foreground)]">
                              {new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(detailsItem.latestCogsEntry.unitCostIncVat)}
                            </span>
                          </span>
                          <span className="tabular-nums">
                            Delivery{" "}
                            <span className="text-[var(--foreground)]">
                              {new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(detailsItem.latestCogsEntry.deliveryCostIncVat)}
                            </span>
                          </span>
                          <span className="tabular-nums">
                            Prep{" "}
                            <span className="text-[var(--foreground)]">
                              {new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(detailsItem.latestCogsEntry.prepCostIncVat)}
                            </span>
                          </span>
                          <span className="tabular-nums">
                            Total{" "}
                            <span className="text-[var(--foreground)]">
                              {new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency }).format(detailsItem.latestCogsEntry.totalCostIncVat)}
                            </span>
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                          <span>Currency {detailsItem.latestCogsEntry.currency}</span>
                          <span className="tabular-nums">VAT {detailsItem.latestCogsEntry.vatRatePct}%</span>
                          <span className="tabular-nums">Bundle {detailsItem.latestCogsEntry.bundleSize}</span>
                          <span className="tabular-nums">Qty purchased {detailsItem.latestCogsEntry.qtyPurchased}</span>
                          <span className="tabular-nums">Qty delivered {detailsItem.latestCogsEntry.qtyDelivered}</span>
                          <span>
                            Date{" "}
                            <span className="tabular-nums">
                              {new Date(detailsItem.latestCogsEntry.purchaseDate).toLocaleDateString("en-GB")}
                            </span>
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                        No ledger entry found for this SKU.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

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
