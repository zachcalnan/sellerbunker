"use client";

import { useAuth, SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDisplaySettings } from "@/contexts/display-settings-context";

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
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState<PeriodKey>("today");
  const [debug, setDebug] = useState<Record<string, unknown> | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [testFetch, setTestFetch] = useState<Record<string, unknown> | null>(null);
  const [testFetchLoading, setTestFetchLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken({ template: "backend" });
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

  const formatDate = (d: string) => new Date(d).toLocaleDateString(undefined, { dateStyle: "short" });
  const formatCurrency = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: "GBP", minimumFractionDigits: 2 }).format(n);
  const nil = (v: string | number | null | undefined) => (v == null || v === "" ? "—" : String(v));

  const fetchDebug = useCallback(async () => {
    setDebugLoading(true);
    setDebug(null);
    try {
      const token = await getToken({ template: "backend" });
      const res = await fetch(`${baseUrl}/api/amazon/dev/orders-debug`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setDebug(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to fetch";
      setDebug({
        error: msg,
        hint: "Check the backend is running and NEXT_PUBLIC_API_URL is correct (e.g. http://localhost:3001).",
      });
    } finally {
      setDebugLoading(false);
    }
  }, [getToken, baseUrl]);

  const fetchTestFetch = useCallback(async () => {
    setTestFetchLoading(true);
    setTestFetch(null);
    try {
      const token = await getToken({ template: "backend" });
      const res = await fetch(`${baseUrl}/api/amazon/dev/orders-test-fetch`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setTestFetch(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to fetch";
      setTestFetch({ error: msg });
    } finally {
      setTestFetchLoading(false);
    }
  }, [getToken, baseUrl]);

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
            {isSignedIn && (
              <>
                <button
                  type="button"
                  onClick={() => void fetchDebug()}
                  disabled={debugLoading}
                  className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none hover:bg-[var(--surface-border)]/50 disabled:opacity-50"
                >
                  {debugLoading ? "Loading…" : "Debug orders"}
                </button>
                <button
                  type="button"
                  onClick={() => void fetchTestFetch()}
                  disabled={testFetchLoading}
                  className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none hover:bg-[var(--surface-border)]/50 disabled:opacity-50"
                >
                  {testFetchLoading ? "…" : "Test orders API"}
                </button>
              </>
            )}
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
          <SignInButton>
            <button className="cursor-pointer rounded-lg bg-[rgb(2,242,170)] px-3 py-2 text-sm font-medium text-black">
              Sign in
            </button>
          </SignInButton>
        </div>
      </SignedOut>

      <SignedIn>
        {debug != null ? (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-black dark:text-red-200">Orders debug (this org)</span>
              <button
                type="button"
                onClick={() => setDebug(null)}
                className="text-xs text-red-700 hover:underline dark:text-red-300"
              >
                Dismiss
              </button>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-white/80 p-3 text-xs text-black dark:bg-black/40 dark:text-red-100">
              {JSON.stringify(debug, null, 2)}
            </pre>
            {debug && !("error" in debug) && (
              <p className="mt-2 text-xs text-black dark:text-red-200">
                memberHasSellerAccount: no Amazon connected in this org if false. memberUserIds: users in this org (sync runs for users with a seller account).
              </p>
            )}
          </div>
        ) : null}
        {testFetch != null ? (
          <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30 px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-black dark:text-red-200">Orders API test (live getOrders, no persist)</span>
              <button
                type="button"
                onClick={() => setTestFetch(null)}
                className="text-xs text-red-700 hover:underline dark:text-red-300"
              >
                Dismiss
              </button>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-white/80 p-3 text-xs text-black dark:bg-black/40 dark:text-red-100">
              {JSON.stringify(testFetch, null, 2)}
            </pre>
            {testFetch && !("error" in testFetch) && (
              <p className="mt-2 text-xs text-black dark:text-red-200">
                orderCount = orders returned by SP-API for last 30 days. If this is 0, the API format was wrong or the account has no orders in the window.
              </p>
            )}
          </div>
        ) : null}
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
                onChange={(e) => setPeriod(e.target.value as PeriodKey)}
                className="rounded-lg border border-[var(--surface-border)] bg-transparent px-2.5 py-1.5 text-xs text-[var(--foreground)] outline-none focus:ring-2 focus:ring-[var(--foreground)]/20"
              >
                {PERIOD_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-5 sm:gap-6">
              <div>
                <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">Orders</span>
                <div className="text-sm font-semibold tabular-nums text-[var(--foreground)]">{periodSummary.orderCount}</div>
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
                  {paginated.map((r) => (
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
                        <div className="text-[var(--foreground)]">{formatDate(r.orderDate)}</div>
                        <div className="truncate font-mono text-[10px] text-[var(--muted-foreground)]" title={r.orderId}>
                          {r.orderId}
                        </div>
                      </div>
                      <div className="flex flex-col text-[var(--foreground)] tabular-nums min-w-0">
                        {r.amazonFeesTotal != null && Number.isFinite(r.amazonFeesTotal) ? (
                          <div className="space-y-0.5 text-left">
                            <div className="font-medium">
                              {formatCurrency(r.amazonFeesTotal)}
                              {r.feesSource === "finances" && <span className="text-[9px] text-[var(--muted-foreground)] font-normal ml-0.5">Settled</span>}
                              {r.feesSource === "estimate" && <span className="text-[9px] text-[var(--muted-foreground)] font-normal ml-0.5">Est.</span>}
                            </div>
                            <div className="text-[9px] text-[var(--muted-foreground)] space-y-0.5">
                              <div>Ref: {r.referralFeeTotal != null ? formatCurrency(r.referralFeeTotal) : "—"}</div>
                              <div>FBA: {r.fbaFeeTotal != null ? formatCurrency(r.fbaFeeTotal) : "—"}</div>
                              <div>Dig: {r.digitalServiceFeeTotal != null ? formatCurrency(r.digitalServiceFeeTotal) : "—"}</div>
                            </div>
                          </div>
                        ) : (
                          "—"
                        )}
                      </div>
                      <div className="text-center text-[var(--foreground)] tabular-nums">
                        {r.quantity}
                      </div>
                      <div className="text-center text-[var(--foreground)] tabular-nums">
                        {formatCurrency(r.salePrice)}
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
                  ))}
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
