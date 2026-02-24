"use client";

import { useAuth, SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  feesSource: string | null; // 'finances' = settled (exact); 'estimate' = from product estimate
  availableStock: number | null;
  totalStock: number | null;
};

type PeriodKey = "today" | "7" | "14" | "30";
const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
];

const PAGE_SIZE = 20;

export default function OrdersPage() {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const { isSignedIn, getToken } = useAuth();

  const [rows, setRows] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshingFees, setRefreshingFees] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState<PeriodKey>("today");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${baseUrl}/api/amazon/orders`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load orders.");
      const data = (await res.json()) as OrderRow[];
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

  const rowsInPeriod = useMemo(() => {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    let startMs: number;
    if (period === "today") {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      startMs = d.getTime();
    } else {
      const days = Number(period) || 30;
      startMs = now - days * oneDayMs;
    }
    return rows.filter((r) => {
      const t = new Date(r.orderDate).getTime();
      return period === "today" ? t >= startMs && t < startMs + oneDayMs : t >= startMs && t <= now;
    });
  }, [rows, period]);

  const periodSummary = useMemo(() => {
    const orderCount = rowsInPeriod.length;
    const totalSales = rowsInPeriod.reduce((sum, r) => sum + r.salePrice * r.quantity, 0);
    const totalProfit = rowsInPeriod.reduce((sum, r) => sum + (r.profit ?? 0), 0);
    return { orderCount, totalSales, totalProfit };
  }, [rowsInPeriod]);

  useEffect(() => {
    setPage(1);
  }, [query]);

  const refreshFeeEstimates = async () => {
    setRefreshingFees(true);
    setError(null);
    setNotice(null);
    try {
      const token = await getToken();
      const res = await fetch(`${baseUrl}/api/amazon/fees-estimate/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string })?.message ?? "Failed to refresh fee estimates.");
      }
      const data = (await res.json()) as { skipped?: boolean; reason?: string; updatedCount?: number; errorCount?: number };
      if (data.skipped && data.reason === "already_run_today") {
        setNotice("Fee estimates were already refreshed in the last 24 hours. Try again tomorrow.");
      } else if (data.updatedCount != null) {
        setNotice(`Updated fee estimates for ${data.updatedCount} product(s).${data.errorCount ? ` ${data.errorCount} error(s).` : ""}`);
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh fee estimates.");
    } finally {
      setRefreshingFees(false);
    }
  };

  const formatDate = (d: string) => new Date(d).toLocaleDateString(undefined, { dateStyle: "short" });
  const formatCurrency = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: "GBP", minimumFractionDigits: 2 }).format(n);
  const nil = (v: string | number | null | undefined) => (v == null || v === "" ? "—" : String(v));

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
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
            className="w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none sm:w-72"
          />
          <button
            type="button"
            onClick={refreshFeeEstimates}
            disabled={!isSignedIn || refreshingFees}
            className="cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:cursor-not-allowed disabled:opacity-60"
            title="Refresh estimated Amazon fees (once per day)"
          >
            {refreshingFees ? "Refreshing…" : "Refresh fee estimates"}
          </button>
        </div>
      </div>

      <SignedOut>
        <div className="rounded-xl border border-[var(--surface-border)] bg-transparent p-4 text-sm text-[var(--muted-foreground)]">
          <div className="mb-3">Sign in to view Orders.</div>
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
          <div className="flex flex-wrap items-center justify-start gap-8">
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-[var(--foreground)]">Period</label>
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value as PeriodKey)}
                className="rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-[var(--foreground)]/20"
              >
                {PERIOD_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-6 sm:gap-8">
              <div>
                <span className="text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">Orders</span>
                <div className="text-lg font-semibold tabular-nums text-[var(--foreground)]">{periodSummary.orderCount}</div>
              </div>
              <div>
                <span className="text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">Sales</span>
                <div className="text-lg font-semibold tabular-nums text-[var(--foreground)]">{formatCurrency(periodSummary.totalSales)}</div>
              </div>
              <div>
                <span className="text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">Profit</span>
                <div className="text-lg font-semibold tabular-nums text-[var(--foreground)]">{formatCurrency(periodSummary.totalProfit)}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl ring-1 ring-[var(--surface-border)]">
          <div className="min-w-[1200px]">
            <div className="grid grid-cols-[44px_1.2fr_0.7fr_0.6fr_1fr_0.9fr_0.5fr_0.6fr_0.5fr_0.5fr_0.5fr] gap-2 bg-[var(--surface)] px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
              <div />
              <div>Title</div>
              <div>SKU</div>
              <div>ASIN</div>
              <div>Date & ID</div>
              <div className="text-center pl-3">Amazon fees</div>
              <div className="text-center pl-3">Qty</div>
              <div className="text-center pl-3">Sale Price</div>
              <div className="text-center pl-3">Profit</div>
              <div className="text-center pl-3">ROI%</div>
              <div className="text-center pl-3">Avail. Stock</div>
            </div>

            {loading ? (
              <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
                Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
                No orders found.
              </div>
            ) : (
              <>
                <div className="divide-y divide-[var(--surface-border)] bg-transparent">
                  {paginated.map((r) => (
                    <div
                      key={r.id}
                      className="grid grid-cols-[44px_1.2fr_0.7fr_0.6fr_1fr_0.9fr_0.5fr_0.6fr_0.5fr_0.5fr_0.5fr] items-center gap-2 px-4 py-3 min-w-0 text-sm"
                    >
                      <div className="flex items-center justify-center shrink-0">
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
                      <div className="truncate text-[var(--foreground)]">
                        {r.title ?? "—"}
                      </div>
                      <div className="truncate text-[var(--muted-foreground)]">
                        {r.sku}
                      </div>
                      <div className="truncate text-[var(--muted-foreground)]">
                        {r.asin ?? "—"}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm text-[var(--foreground)]">
                          <span className="font-semibold">Order date: </span>{formatDate(r.orderDate)}
                        </div>
                        <div className="truncate font-mono text-xs text-[var(--foreground)]">
                          <span className="font-semibold">Order ID: </span>{r.orderId}
                        </div>
                      </div>
                      <div className="text-left pl-3 text-[var(--foreground)] tabular-nums min-w-0">
                        {r.amazonFeesTotal != null && Number.isFinite(r.amazonFeesTotal) ? (
                          <>
                            <div className="font-semibold">
                              {formatCurrency(r.amazonFeesTotal)}
                              {r.feesSource === "finances" && (
                                <span className="font-normal text-[var(--muted-foreground)] text-xs ml-1">Settled</span>
                              )}
                              {r.feesSource === "estimate" && (
                                <span className="font-normal text-[var(--muted-foreground)] text-xs ml-1">Est.</span>
                              )}
                            </div>
                            <div className="text-xs text-[var(--muted-foreground)] mt-0.5">
                              <div><span className="font-semibold">Referral fee: </span>{r.referralFeeTotal != null ? formatCurrency(r.referralFeeTotal) : "—"}</div>
                              <div><span className="font-semibold">FBA fee: </span>{r.fbaFeeTotal != null ? formatCurrency(r.fbaFeeTotal) : "—"}</div>
                            </div>
                          </>
                        ) : (
                          "—"
                        )}
                      </div>
                      <div className="text-center pl-3 text-[var(--foreground)]">
                        {r.quantity}
                      </div>
                      <div className="text-center pl-3 text-[var(--foreground)]">
                        {formatCurrency(r.salePrice)}
                      </div>
                      <div className="text-center pl-3 text-[var(--foreground)]">
                        {r.profit != null ? formatCurrency(r.profit) : "—"}
                      </div>
                      <div className="text-center pl-3 text-[var(--foreground)]">
                        {r.roiPct != null ? `${r.roiPct}%` : "—"}
                      </div>
                      <div className="text-center pl-3 text-[var(--foreground)]">
                        {r.availableStock != null ? String(r.availableStock) : "—"}
                      </div>
                    </div>
                  ))}
                </div>

                {totalPages > 1 ? (
                  <div className="flex items-center justify-between gap-4 border-t border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3">
                    <div className="text-sm text-[var(--muted-foreground)]">
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
