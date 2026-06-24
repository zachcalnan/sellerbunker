"use client";

import { useAuth, SignedIn, SignedOut } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useDisplaySettings } from "@/contexts/display-settings-context";
import { useMarketplace } from "@/contexts/marketplace-context";
import {
  aggregateOrderRows,
  DASHBOARD_RANGE_PERIOD_SELECT_OPTIONS,
  filterOrderRowsForDashboardPreset,
  type DashboardRangePreset,
} from "@/lib/orders-period-metrics";
import { getMarketplaceIanaTimeZone } from "@/lib/marketplace-timezone";
import { marketplaceLocalDateAnchors } from "@/lib/marketplace-date-anchors";
import { SignInButtonWithReturn } from "@/components/sign-in-button-with-return";
import { getDevImpersonationHeaders } from "@/lib/impersonation";

type OrderRow = {
  id: string;
  orderId: string;
  orderDate: string;
  sku: string;
  asin: string | null;
  title: string | null;
  imageUrl: string | null;
  quantity: number;
  salePrice: number;
  profit: number | null;
  roiPct: number | null;
  amazonFeesTotal: number;
  referralFeeTotal: number | null;
  fbaFeeTotal: number | null;
  digitalServiceFeeTotal: number | null;
  feesSource: string | null; // 'finances' = settled; 'estimate_sold' = Product Fees at sale price until settlement; 'estimate' = product table estimate
  /** SP-API line FulfillmentChannel: AFN→FBA, MFN→FBM */
  fulfillmentType?: "FBA" | "FBM" | null;
  availableStock: number | null;
  totalStock: number | null;
  orderStatusLabel?: string | null;
  excludedFromSales?: boolean;
  excludedFromProfitMetrics?: boolean;
  excludedFromOrderCount?: boolean;
};

const PAGE_SIZE = 20;

export default function OrdersPage() {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const { isSignedIn, getToken } = useAuth();
  const { selectedMarketplaceId, selectedCurrency } = useMarketplace();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");

  const [rows, setRows] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState<DashboardRangePreset>("today");
  const [periodCustomStart, setPeriodCustomStart] = useState("");
  const [periodCustomEnd, setPeriodCustomEnd] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken({ template: "backend" });
      const url = new URL(`${baseUrl}/api/amazon/orders`);
      if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          ...getDevImpersonationHeaders(devImpersonate),
          ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
        },
      });
      if (!res.ok) throw new Error("Failed to load orders.");
      const data = (await res.json()) as OrderRow[];
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
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

  useEffect(() => {
    if (!isSignedIn) return;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [isSignedIn, load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.sku.toLowerCase().includes(q) ||
        (r.asin ?? "").toLowerCase().includes(q) ||
        (r.title ?? "").toLowerCase().includes(q) ||
        r.orderId.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  );

  const marketplaceTz = getMarketplaceIanaTimeZone(selectedMarketplaceId);
  const { defaultEnd, defaultStart30 } =
    marketplaceLocalDateAnchors(selectedMarketplaceId);

  const periodCustomRange = useMemo(() => {
    if (period !== "custom") return undefined;
    const start = periodCustomStart || defaultStart30;
    const end = periodCustomEnd || defaultEnd;
    return { start, end };
  }, [period, periodCustomStart, periodCustomEnd, defaultStart30, defaultEnd]);

  const rowsInPeriod = useMemo(
    () =>
      filterOrderRowsForDashboardPreset(
        rows,
        period,
        periodCustomRange,
        { timeZone: marketplaceTz },
      ),
    [rows, period, periodCustomRange, marketplaceTz],
  );

  const periodSummary = useMemo(() => {
    const a = aggregateOrderRows(rowsInPeriod);
    return {
      orderCount: a.orderCount,
      totalSales: a.totalSales,
      totalProfit: a.totalProfit,
    };
  }, [rowsInPeriod]);

  useEffect(() => {
    setPage(1);
  }, [query, period, periodCustomStart, periodCustomEnd]);

  const formatDate = (d: string) => new Date(d).toLocaleDateString(undefined, { dateStyle: "short" });
  const formatCurrency = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: selectedCurrency, minimumFractionDigits: 2 }).format(n);

  const { backgroundClass } = useDisplaySettings();

  return (
    <div className={`min-h-screen w-full ${backgroundClass} px-4 py-6`}>
      <div className="mb-4 rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--foreground)]">
              Orders
            </h1>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">
              Order line items, most recent first.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search SKU / ASIN / title / order ID…"
              className="w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none sm:w-72"
            />
          </div>
        </div>
      </div>

      <SignedOut>
        <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-4 text-sm text-[var(--muted-foreground)]">
          <div className="mb-3">Sign in to view Orders.</div>
          <SignInButtonWithReturn>
            <button className="cursor-pointer rounded-lg bg-sb-accent px-3 py-2 text-sm font-medium text-black">
              Sign in
            </button>
          </SignInButtonWithReturn>
        </div>
      </SignedOut>

      <SignedIn>
        {error ? (
          <div className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="mb-4 rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-start gap-6">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-[var(--foreground)]">Period</label>
              <select
                value={period}
                onChange={(e) => {
                  const v = e.target.value as DashboardRangePreset;
                  setPeriod(v);
                  if (v === "custom" && !periodCustomStart && !periodCustomEnd) {
                    setPeriodCustomStart(defaultStart30);
                    setPeriodCustomEnd(defaultEnd);
                  }
                }}
                className="h-8 cursor-pointer rounded-lg border border-zinc-600 bg-black px-2.5 text-xs text-white outline-none focus:ring-2 focus:ring-sb-accent/40"
              >
                {DASHBOARD_RANGE_PERIOD_SELECT_OPTIONS.map(({ value, label }) => (
                  <option key={value} className="bg-black text-white" value={value}>
                    {label}
                  </option>
                ))}
              </select>
              {period === "custom" ? (
                <>
                  <input
                    type="date"
                    value={periodCustomStart}
                    onChange={(e) => setPeriodCustomStart(e.target.value)}
                    className="h-8 rounded-lg border border-zinc-600 bg-black px-2 text-xs text-white outline-none [color-scheme:dark]"
                  />
                  <span className="text-[var(--muted-foreground)]">→</span>
                  <input
                    type="date"
                    value={periodCustomEnd}
                    onChange={(e) => setPeriodCustomEnd(e.target.value)}
                    className="h-8 rounded-lg border border-zinc-600 bg-black px-2 text-xs text-white outline-none [color-scheme:dark]"
                  />
                </>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-5 sm:gap-6">
              <div>
                <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">Orders</span>
                <div className="text-sm font-semibold tabular-nums text-[var(--foreground)]">
                  {periodSummary.orderCount}
                </div>
              </div>
              <div>
                <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">Sales</span>
                <div className="text-sm font-semibold tabular-nums text-[var(--foreground)]">{formatCurrency(periodSummary.totalSales)}</div>
              </div>
              <div>
                <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">Profit</span>
                <div className="text-sm font-semibold tabular-nums text-[var(--foreground)]">{formatCurrency(periodSummary.totalProfit)}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl bg-[var(--surface)] ring-1 ring-[var(--surface-border)]">
          <div className="min-w-0">
            <div className="grid grid-cols-[36px_1fr_0.55fr_0.45fr_0.8fr_0.52fr_0.35fr_0.45fr_0.45fr_0.35fr_0.35fr] gap-1 bg-[var(--surface)] px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              <div />
              <div>Title</div>
              <div>SKU</div>
              <div>ASIN</div>
              <div>Date / ID</div>
              <div className="text-left">Fees</div>
              <div className="text-center">Qty</div>
              <div className="text-center">Price</div>
              <div className="text-center">Profit</div>
              <div className="text-center">ROI%</div>
              <div className="text-center">Stock</div>
            </div>

            {loading ? (
              <div className="px-2.5 py-4 text-xs text-[var(--muted-foreground)]">
                Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-2.5 py-4 text-xs text-[var(--muted-foreground)]">
                No orders found.
              </div>
            ) : (
              <>
                <div className="divide-y divide-[var(--surface-border)] bg-transparent">
                  {paginated.map((r) => {
                    const excluded = Boolean(r.excludedFromSales);
                    return (
                    <div
                      key={r.id}
                      className="grid grid-cols-[36px_1fr_0.55fr_0.45fr_0.8fr_0.52fr_0.35fr_0.45fr_0.45fr_0.35fr_0.35fr] items-center gap-1 px-2.5 py-2 min-w-0 text-[11px]"
                    >
                      <div className="flex items-center justify-center shrink-0">
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
                      <div className="min-w-0 truncate text-[var(--foreground)]">
                        <span>{r.title ?? "—"}</span>
                        {r.orderStatusLabel ? (
                          <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-red-600">
                            {r.orderStatusLabel}
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate text-[var(--muted-foreground)]">
                        {r.sku}
                      </div>
                      <div className="truncate text-[var(--muted-foreground)]">
                        {r.asin ?? "—"}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-1.5 text-[var(--foreground)]">
                          <span>{formatDate(r.orderDate)}</span>
                          {r.fulfillmentType ? (
                            <span className="rounded border border-[var(--surface-border)] bg-[var(--background)] px-1 py-0 text-[9px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                              {r.fulfillmentType}
                            </span>
                          ) : null}
                        </div>
                        <div className="truncate font-mono text-[10px] text-[var(--muted-foreground)]" title={r.orderId}>
                          {r.orderId}
                        </div>
                      </div>
                      <div className={`flex flex-col tabular-nums min-w-0 ${excluded ? "text-[var(--muted-foreground)]" : "text-[var(--foreground)]"}`}>
                        {!excluded && r.amazonFeesTotal != null && Number.isFinite(r.amazonFeesTotal) ? (
                          <div className="space-y-0.5 text-left">
                            <div className="font-medium">
                              {formatCurrency(Math.abs(r.amazonFeesTotal))}
                              {r.feesSource === "finances" && <span className="text-[9px] text-[var(--muted-foreground)] font-normal ml-0.5">Settled</span>}
                              {r.feesSource === "estimate_sold" && <span className="text-[9px] text-[var(--muted-foreground)] font-normal ml-0.5">Sale est.</span>}
                              {r.feesSource === "estimate" && <span className="text-[9px] text-[var(--muted-foreground)] font-normal ml-0.5">Est.</span>}
                            </div>
                            <div className="text-[9px] text-[var(--muted-foreground)] space-y-0.5">
                              <div>Ref: {r.referralFeeTotal != null ? formatCurrency(Math.abs(r.referralFeeTotal)) : "—"}</div>
                              <div>FBA: {r.fbaFeeTotal != null ? formatCurrency(Math.abs(r.fbaFeeTotal)) : "—"}</div>
                              <div>Dig: {r.digitalServiceFeeTotal != null ? formatCurrency(Math.abs(r.digitalServiceFeeTotal)) : "—"}</div>
                            </div>
                          </div>
                        ) : excluded ? (
                          <span className="text-[10px] text-[var(--muted-foreground)]">—</span>
                        ) : (
                          "—"
                        )}
                      </div>
                      <div className="text-center text-[var(--foreground)] tabular-nums">
                        {r.quantity}
                      </div>
                      <div
                        className={`text-center tabular-nums ${excluded ? "font-semibold text-red-600" : "text-[var(--foreground)]"}`}
                      >
                        <div className="flex flex-col items-center leading-tight">
                          <span>{formatCurrency(r.salePrice)}</span>
                          {excluded && r.orderStatusLabel ? (
                            <span className="mt-0.5 text-[10px] font-semibold text-red-600">
                              {r.orderStatusLabel}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="text-center text-[var(--foreground)] tabular-nums">
                        {r.profit != null ? formatCurrency(r.profit) : "—"}
                      </div>
                      <div className="text-center text-[var(--foreground)] tabular-nums">
                        {r.roiPct != null ? `${r.roiPct}%` : "—"}
                      </div>
                      <div
                        className={`text-center tabular-nums ${
                          r.availableStock != null
                            ? r.availableStock <= 0
                              ? "text-red-600"
                              : "text-green-600"
                            : "text-[var(--foreground)]"
                        }`}
                      >
                        {r.availableStock != null ? String(r.availableStock) : "—"}
                      </div>
                    </div>
                    );
                  })}
                </div>

                {totalPages > 1 ? (
                  <div className="flex items-center justify-between gap-4 border-t border-[var(--surface-border)] bg-[var(--surface)] px-2.5 py-2">
                    <div className="text-xs text-[var(--muted-foreground)]">
                      Page {safePage} of {totalPages}
                      <span className="ml-2">
                        ({(safePage - 1) * PAGE_SIZE + 1}–
                        {Math.min(safePage * PAGE_SIZE, filtered.length)} of{" "}
                        {filtered.length})
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
                        <svg
                          className="h-5 w-5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          aria-hidden
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15 19l-7-7 7-7"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setPage((p) => Math.min(totalPages, p + 1))
                        }
                        disabled={safePage >= totalPages}
                        className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--surface-border)] bg-transparent text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:pointer-events-none disabled:opacity-40"
                        aria-label="Next page"
                      >
                        <svg
                          className="h-5 w-5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          aria-hidden
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </SignedIn>
    </div>
  );
}
