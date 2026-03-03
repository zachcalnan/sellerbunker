"use client";

import Link from "next/link";
import { Suspense, type ReactNode, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";

type AccountSummary = {
  marketplace: string;
  sellerId: string;
  currency: string;
  period: string;
  revenue: number;
  profitMargin: number;
  unitsSold: number;
  adSpend: number;
  totalOrders: number;
  orderItemsOrdersCount?: number;
  orderItemsCoveragePct?: number;
  activeSkus: number;
  unitsInFba: number;
  openShipments: number;
  hasCostData?: boolean;
  generatedAt: string;
};

type SalesPoint = {
  date: string;
  revenue: number;
  orders: number;
  profit: number;
};

type SalesSeries = {
  currency: string;
  points: SalesPoint[];
};

type RecentOrderRow = {
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
  roiPct?: number | null;
  availableStock: number | null;
  totalStock: number | null;
};

function HomeInner() {
  const baseUrl =
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

  const { isSignedIn, getToken } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const startParam = searchParams.get("start");
  const endParam = searchParams.get("end");

  const [rangePreset, setRangePreset] = useState<
    "today" | "7d" | "30d" | "yesterday" | "all" | "custom"
  >("30d");
  const [trendPreset, setTrendPreset] = useState<
    "today" | "7d" | "30d" | "yesterday" | "all" | "custom"
  >("30d");
  const [customStart, setCustomStart] = useState<string>("");
  const [customEnd, setCustomEnd] = useState<string>("");
  const [trendCustomStart, setTrendCustomStart] = useState<string>("");
  const [trendCustomEnd, setTrendCustomEnd] = useState<string>("");
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toDateOnly = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const defaultEnd = toDateOnly(today);
  const defaultStart30 = toDateOnly(
    new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000),
  );
  const yesterday = toDateOnly(
    new Date(today.getTime() - 24 * 60 * 60 * 1000),
  );
  const allTimeStart = "2020-01-01"; // fixed "all time" start

  const effectiveStart =
    rangePreset === "today"
      ? defaultEnd
      : rangePreset === "7d"
        ? toDateOnly(new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000))
        : rangePreset === "30d"
          ? defaultStart30
          : rangePreset === "yesterday"
            ? yesterday
            : rangePreset === "all"
              ? allTimeStart
              : (startParam ?? defaultStart30);
  const effectiveEnd =
    rangePreset === "today" || rangePreset === "7d" || rangePreset === "30d"
      ? defaultEnd
      : rangePreset === "yesterday"
        ? yesterday
        : rangePreset === "all"
          ? defaultEnd
          : (endParam ?? defaultEnd);

  // Trend has its own range (separate from summary/cards)
  const trendStart =
    trendPreset === "today"
      ? defaultEnd
      : trendPreset === "7d"
        ? toDateOnly(new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000))
        : trendPreset === "30d"
          ? defaultStart30
          : trendPreset === "yesterday"
            ? yesterday
            : trendPreset === "all"
              ? allTimeStart
              : (trendCustomStart || defaultStart30);
  const trendEnd =
    trendPreset === "today"
      ? defaultEnd
      : trendPreset === "7d"
        ? defaultEnd
        : trendPreset === "30d"
          ? defaultEnd
          : trendPreset === "yesterday"
            ? yesterday
            : trendPreset === "all"
              ? defaultEnd
              : (trendCustomEnd || defaultEnd);

  const rangeLabel =
    rangePreset === "today"
      ? "Today"
      : rangePreset === "yesterday"
        ? "Yesterday"
        : rangePreset === "7d"
          ? "7 days"
          : rangePreset === "30d"
            ? "30 days"
            : rangePreset === "all"
              ? "All time"
              : "Custom";
  const trendLabel =
    trendPreset === "today"
      ? "Today"
      : trendPreset === "yesterday"
        ? "Yesterday"
        : trendPreset === "7d"
          ? "7 days"
          : trendPreset === "30d"
            ? "30 days"
            : trendPreset === "all"
              ? "All time"
              : "Custom";

  useEffect(() => {
    // Initialize preset based on URL (or defaults)
    const start = effectiveStart;
    const end = effectiveEnd;

    const isSame = (a: string, b: string) => a === b;
    const endIsToday = isSame(end, defaultEnd);
    const startIsToday = isSame(start, defaultEnd);
    const startIs7 = isSame(
      start,
      toDateOnly(new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000)),
    );
    const startIs30 = isSame(start, defaultStart30);

    if (startParam || endParam) {
      const startIsYesterday = isSame(start, yesterday);
      const endIsYesterday = isSame(end, yesterday);
      const startIsAll = isSame(start, allTimeStart);
      const endIsTodayForAll = isSame(end, defaultEnd);
      if (startIsToday && endIsToday) setRangePreset("today");
      else if (startIs7 && endIsToday) setRangePreset("7d");
      else if (startIs30 && endIsToday) setRangePreset("30d");
      else if (startIsYesterday && endIsYesterday)
        setRangePreset("yesterday");
      else if (startIsAll && endIsTodayForAll) setRangePreset("all");
      else setRangePreset("custom");
    } else {
      setRangePreset("30d");
    }

    setCustomStart(start);
    setCustomEnd(end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startParam, endParam]);

  const setRangeInUrl = (start: string, end: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("start", start);
    next.set("end", end);
    router.replace(`/?${next.toString()}`);
  };

  useEffect(() => {
    if (!isSignedIn) {
      setSummary(null);
      return;
    }

    const fetchSummary = async () => {
      setLoading(true);
      setError(null);

      try {
        const token = await getToken({ template: "backend" });
        const res = await fetch(
          `${baseUrl}/api/amazon/account/summary?` +
            new URLSearchParams({
              start: effectiveStart,
              end: effectiveEnd,
            }).toString(),
          {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          },
        );

        if (!res.ok) {
          const message =
            res.status === 404
              ? "Amazon account not linked yet. Link it via the API to see live data."
              : "Failed to load account summary.";
          setError(message);
          setSummary(null);
          return;
        }

        const data = (await res.json()) as AccountSummary;
        setSummary(data);
      } catch {
        setError("Unable to reach backend. Is it running?");
        setSummary(null);
      } finally {
        setLoading(false);
      }
    };

    fetchSummary();
  }, [isSignedIn, getToken, baseUrl, effectiveStart, effectiveEnd]);

  const effectiveCurrency = summary?.currency ?? "USD";

  const profit =
    summary != null
      ? summary.revenue * summary.profitMargin
      : 0;
  const roiPct =
    summary != null && summary.adSpend > 0
      ? (profit / summary.adSpend) * 100
      : 0;

  const hasCostData = summary?.hasCostData ?? false;
  const showCogsNotice = summary != null && summary.totalOrders > 0 && !hasCostData;
  const orderItemsCoveragePct = summary?.orderItemsCoveragePct ?? 1;
  const orderItemsOrdersCount = summary?.orderItemsOrdersCount ?? null;
  const showLineItemBackfillNotice =
    summary != null &&
    summary.totalOrders > 0 &&
    Number.isFinite(orderItemsCoveragePct) &&
    orderItemsCoveragePct < 0.95;

  const cards = summary
    ? [
        {
          label: "Profit",
          value: hasCostData ? formatCurrency(profit, effectiveCurrency, 2) : "—",
          percentage: hasCostData ? Math.round(summary.profitMargin * 100) : 0,
          color: "#10B981",
          centerTitle: "Profit",
          centerLine1: hasCostData ? formatCurrency(profit, effectiveCurrency, 2) : "—",
          centerLine2: "Profit on Sales",
          centerLine3: hasCostData ? `${(summary.profitMargin * 100).toFixed(1)}%` : "—",
          note: showLineItemBackfillNotice ? (
            <span>
              Still backfilling SKU line items{" "}
              {orderItemsOrdersCount != null ? (
                <span className="font-medium text-[var(--foreground)]">
                  ({orderItemsOrdersCount}/{summary.totalOrders})
                </span>
              ) : null}
              . Profit / missing-COGS may be incomplete.
            </span>
          ) : showCogsNotice ? (
            <span>
              Set{" "}
              <Link
                href={`/cost-of-goods?${new URLSearchParams({
                  start: effectiveStart,
                  end: effectiveEnd,
                }).toString()}`}
                className="underline underline-offset-2"
              >
                COGS
              </Link>{" "}
              to calculate profit.
            </span>
          ) : null,
        },
        {
          label: "Sales",
          value: formatCurrency(summary.revenue, effectiveCurrency),
          percentage: 0,
          color: "#4F46E5",
          hidePercentage: true,
        },
        {
          label: "Units",
          value: summary.unitsSold.toLocaleString(),
          percentage: 0,
          color: "#F97316",
          hidePercentage: true,
        },
        {
          label: "ROI",
          value: hasCostData ? `${Math.round(roiPct)}%` : "—",
          percentage: hasCostData ? Math.min(100, Math.round(roiPct)) : 0,
          color: "#EC4899",
          hidePercentage: !hasCostData,
          centerTitle: "ROI",
        },
      ]
    : [];

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <main className="flex min-h-screen w-full flex-col gap-10 px-6 pt-3 pb-10">

        {loading && (
          <div className="rounded-xl border border-[var(--surface-border)] bg-transparent px-4 py-3 text-xs text-[var(--muted-foreground)]">
            Loading account summary...
          </div>
        )}
        {error ? (
          <div className="flex flex-col gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-700">
            <span>{error}</span>
            {isSignedIn && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    const token = await getToken({ template: "backend" });
                    if (!token) {
                      return;
                    }
                    const res = await fetch(
                      `${baseUrl}/api/amazon/connect?region=EU`,
                      {
                        headers: {
                          Authorization: `Bearer ${token}`,
                        },
                      }
                    );
                    if (!res.ok) {
                      return;
                    }
                    const data = (await res.json()) as { url?: string };
                    if (data?.url) {
                      window.location.href = data.url;
                    }
                  } catch {
                    // swallow for now; the existing error message will remain
                  }
                }}
                className="inline-flex w-fit items-center justify-center rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-700"
              >
                Connect Amazon
              </button>
            )}
          </div>
        ) : null}

        {summary && (
          <section className="-mt-0.5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
              {/* Left column: Performance Snapshot + Recent orders */}
              <div className="flex min-w-0 flex-col gap-4">
                {/* Performance Snapshot */}
                <div className="flex w-full flex-col rounded-xl p-4 ring-1 ring-[var(--surface-border)]">
                  <div className="mb-1 flex w-full items-center justify-between gap-2">
                    <h2 className="text-sm font-medium uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
                      Performance Snapshot
                    </h2>
                    <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-[var(--muted-foreground)]">
                    <select
                      value={rangePreset}
                      onChange={(e) => {
                        const v = e.target.value as
                          | "today"
                          | "7d"
                          | "30d"
                          | "yesterday"
                          | "all"
                          | "custom";
                        setRangePreset(v);
                        if (v === "custom") return;
                        const end =
                          v === "yesterday"
                            ? yesterday
                            : v === "all"
                              ? defaultEnd
                              : defaultEnd;
                        const start =
                          v === "today"
                            ? defaultEnd
                            : v === "7d"
                              ? toDateOnly(
                                  new Date(
                                    today.getTime() - 6 * 24 * 60 * 60 * 1000,
                                  ),
                                )
                              : v === "30d"
                                ? defaultStart30
                                : v === "yesterday"
                                  ? yesterday
                                  : allTimeStart;
                        setRangeInUrl(start, end);
                      }}
                      className="h-8 cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-2 text-xs text-[var(--foreground)] outline-none"
                    >
                      <option value="today">Today</option>
                      <option value="yesterday">Yesterday</option>
                      <option value="7d">7 days</option>
                      <option value="30d">30 days</option>
                      <option value="all">All time</option>
                      <option value="custom">Custom</option>
                    </select>
                    {rangePreset === "custom" ? (
                      <>
                        <input
                          type="date"
                          value={customStart}
                          onChange={(e) =>
                            setCustomStart(e.target.value)}
                          className="h-8 rounded-lg border border-[var(--surface-border)] bg-transparent px-2 text-xs text-[var(--foreground)] outline-none"
                        />
                        <span>→</span>
                        <input
                          type="date"
                          value={customEnd}
                          onChange={(e) =>
                            setCustomEnd(e.target.value)}
                          className="h-8 rounded-lg border border-[var(--surface-border)] bg-transparent px-2 text-xs text-[var(--foreground)] outline-none"
                        />
                        <button
                          type="button"
                          className="h-8 cursor-pointer rounded-lg bg-[rgb(2,242,170)] px-3 text-xs font-medium text-black"
                          onClick={() => {
                            if (!customStart || !customEnd) return;
                            setRangeInUrl(customStart, customEnd);
                          }}
                        >
                          Apply
                        </button>
                      </>
                    ) : null}
                    </div>
                  </div>
                  <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-4">
                    {cards.map((card) => (
                      <DonutCard key={card.label} {...card} />
                    ))}
                  </div>
                </div>

                {/* Recent orders */}
                <RecentOrders
                  baseUrl={baseUrl}
                  isSignedIn={isSignedIn}
                  getToken={getToken}
                  currency={effectiveCurrency}
                />
              </div>

              {/* Right column: Sales Trend + Inventory summary in the space below */}
              <div className="flex min-w-0 flex-col gap-4">
              <div className="flex min-w-0 max-h-[20rem] w-full flex-col overflow-y-auto rounded-xl p-4 ring-1 ring-[var(--surface-border)]">
                <div className="mb-3 flex w-full items-center justify-between gap-2">
                  <h2 className="text-sm font-medium uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
                    Sales v Profit
                  </h2>
                  <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-[var(--muted-foreground)]">
                    <select
                      value={trendPreset}
                      onChange={(e) => {
                        const v = e.target.value as
                          | "today"
                          | "7d"
                          | "30d"
                          | "yesterday"
                          | "all"
                          | "custom";
                        setTrendPreset(v);
                        if (v === "custom") return;
                        const end =
                          v === "yesterday"
                            ? yesterday
                            : v === "all"
                              ? defaultEnd
                              : defaultEnd;
                        const start =
                          v === "today"
                            ? defaultEnd
                            : v === "7d"
                              ? toDateOnly(
                                  new Date(
                                    today.getTime() - 6 * 24 * 60 * 60 * 1000,
                                  ),
                                )
                              : v === "30d"
                                ? defaultStart30
                                : v === "yesterday"
                                  ? yesterday
                                  : allTimeStart;
                        setTrendCustomStart(start);
                        setTrendCustomEnd(end);
                      }}
                      className="h-8 cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-2 text-xs text-[var(--foreground)] outline-none"
                    >
                      <option value="today">Today</option>
                      <option value="yesterday">Yesterday</option>
                      <option value="7d">7 days</option>
                      <option value="30d">30 days</option>
                      <option value="all">All time</option>
                      <option value="custom">Custom</option>
                    </select>
                    {trendPreset === "custom" ? (
                      <>
                        <input
                          type="date"
                          value={trendCustomStart}
                          onChange={(e) =>
                            setTrendCustomStart(e.target.value)}
                          className="h-8 rounded-lg border border-[var(--surface-border)] bg-transparent px-2 text-xs text-[var(--foreground)] outline-none"
                        />
                        <span>→</span>
                        <input
                          type="date"
                          value={trendCustomEnd}
                          onChange={(e) =>
                            setTrendCustomEnd(e.target.value)}
                          className="h-8 rounded-lg border border-[var(--surface-border)] bg-transparent px-2 text-xs text-[var(--foreground)] outline-none"
                        />
                      </>
                    ) : null}
                  </div>
                </div>
                <SalesTrend
                  baseUrl={baseUrl}
                  isSignedIn={isSignedIn}
                  getToken={getToken}
                  currency={effectiveCurrency}
                  start={trendStart}
                  end={trendEnd}
                  label={trendLabel}
                  noWrapper
                />
              </div>

              {/* Inventory breakdown: fills the space below Sales Trend */}
              <InventorySummary
                baseUrl={baseUrl}
                isSignedIn={isSignedIn}
                getToken={getToken}
                currency={effectiveCurrency}
              />
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="w-full px-6 py-10 text-sm text-[var(--muted-foreground)]">
          Loading…
        </div>
      }
    >
      <HomeInner />
    </Suspense>
  );
}

type RecentOrdersProps = {
  baseUrl: string;
  isSignedIn: boolean | undefined;
  getToken: (args: { template?: string }) => Promise<string | null>;
  currency: string;
};

function RecentOrders({
  baseUrl,
  isSignedIn,
  getToken,
  currency,
}: RecentOrdersProps) {
  const [orders, setOrders] = useState<RecentOrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSignedIn) {
      setOrders([]);
      return;
    }
    const fetchOrders = async () => {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken({ template: "backend" });
        const res = await fetch(`${baseUrl}/api/amazon/orders`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error("Failed to load orders");
        const data = (await res.json()) as RecentOrderRow[];
        setOrders(Array.isArray(data) ? data.slice(0, 10) : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Error");
        setOrders([]);
      } finally {
        setLoading(false);
      }
    };
    void fetchOrders();
  }, [isSignedIn, getToken, baseUrl]);

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="flex w-full flex-col rounded-xl p-4 ring-1 ring-[var(--surface-border)]">
      <h2 className="mb-2 text-sm font-medium uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
        Recent orders
      </h2>
      {loading && (
        <p className="text-[11px] text-[var(--muted-foreground)]">Loading…</p>
      )}
      {error && (
        <p className="text-[11px] text-red-600">{error}</p>
      )}
      {!loading && !error && orders.length === 0 && (
        <p className="text-[11px] text-[var(--muted-foreground)]">
          No orders yet.
        </p>
      )}
      {!loading && !error && orders.length > 0 && (
        <div className="max-h-80 w-full overflow-y-auto overflow-x-hidden">
          <div className="min-w-0 w-full pr-5">
            {/* Header row: same grid as data rows so Price/Profit/ROI align */}
            <div className="grid w-full grid-cols-[2.25rem_minmax(0,1fr)_6rem_6rem_4rem] items-center gap-x-4 gap-y-1 border-b border-[var(--surface-border)] pb-1 pt-0 text-[9px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
              <div aria-hidden />
              <div />
              <div className="text-center text-xs text-white">Price</div>
              <div className="text-center text-xs text-white">Profit</div>
              <div className="text-center text-xs text-white">ROI</div>
            </div>
            {orders.map((row) => {
              const revenue = row.salePrice * row.quantity;
              const title = row.title?.trim() || "—";
              const shortTitle = title.length > 42 ? title.slice(0, 39) + "…" : title;
              return (
                <div
                  key={row.id}
                  className="grid w-full grid-cols-[2.25rem_minmax(0,1fr)_6rem_6rem_4rem] items-center gap-x-4 gap-y-1 border-b border-[var(--surface-border)] py-1.5 text-[10px] last:border-b-0"
                >
                  <div className="h-9 w-9 shrink-0 overflow-hidden rounded bg-[var(--surface)] ring-1 ring-[var(--surface-border)]">
                    {row.imageUrl ? (
                      <img
                        src={row.imageUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[var(--muted-foreground)]">
                        —
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-[var(--foreground)]" title={row.title ?? undefined}>
                      {shortTitle}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 truncate text-[11px] text-[var(--muted-foreground)]">
                      <span>{formatDate(row.orderDate)}</span>
                      <span>·</span>
                      <span>{row.sku}</span>
                      <span>·</span>
                      <span>{row.asin ?? "—"}</span>
                      <span>·</span>
                      <span>Qty {row.quantity}</span>
                      <span>·</span>
                      <span>Stock {row.availableStock != null ? row.availableStock : "—"}</span>
                    </div>
                  </div>
                  <div className="text-center text-xs font-medium tabular-nums text-white">
                    {revenue != null && Number.isFinite(revenue) ? formatCurrency(revenue, currency) : "—"}
                  </div>
                  <div className="text-center text-xs font-medium tabular-nums text-white">
                    {row.profit != null && Number.isFinite(row.profit) ? formatCurrency(row.profit, currency) : "—"}
                  </div>
                  <div className="text-center text-xs font-medium tabular-nums text-white">
                    {row.roiPct != null && Number.isFinite(row.roiPct) ? `${row.roiPct.toFixed(1)}%` : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

type InventorySummaryRow = {
  availableQty: number | null;
  reservedQty: number | null;
  inboundQty: number | null;
  issueQty: number | null;
  totalQty: number | null;
  currentListedPrice?: number | null;
  costOfGoods?: number | null;
  byMarketplace?: Array<{
    fulfillableQty: number;
    inboundQty: number;
    reservedQty: number;
    researchingQty: number;
    unfulfillableQty: number;
    currentQty: number;
    fcProcessingQty?: number;
    customerOrdersQty?: number;
    transshipmentQty?: number;
    inboundWorkingQty?: number;
    inboundShippedQty?: number;
    inboundReceivingQty?: number;
    warehouseDamagedQty?: number;
    expiredQty?: number;
  }>;
};

type InventorySummaryProps = {
  baseUrl: string;
  isSignedIn: boolean | undefined;
  getToken: (args: { template?: string }) => Promise<string | null>;
  currency: string;
};

function InventorySummary({
  baseUrl,
  isSignedIn,
  getToken,
  currency,
}: InventorySummaryProps) {
  const [rows, setRows] = useState<InventorySummaryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSignedIn) {
      setRows([]);
      return;
    }
    const fetchInventory = async () => {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken({ template: "backend" });
        const res = await fetch(`${baseUrl}/api/amazon/inventory`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error("Failed to load inventory");
        const data = (await res.json()) as InventorySummaryRow[];
        setRows(Array.isArray(data) ? data : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Error");
        setRows([]);
      } finally {
        setLoading(false);
      }
    };
    void fetchInventory();
  }, [isSignedIn, getToken, baseUrl]);

  const n = (v: number | null | undefined) => (v != null && Number.isFinite(v) ? v : 0);
  const total = rows.reduce((sum, r) => sum + n(r.totalQty), 0);
  const price = (r: InventorySummaryRow) => n(r.currentListedPrice);
  const cogs = (r: InventorySummaryRow) => n(r.costOfGoods);

  let fulfillable = 0;
  let fulfillableValue = 0;
  let fulfillableCost = 0;
  let reserved = 0;
  let reservedValue = 0;
  let reservedCost = 0;
  let inbound = 0;
  let inboundValue = 0;
  let inboundCost = 0;
  let researching = 0;
  let researchingValue = 0;
  let researchingCost = 0;
  let unfulfillable = 0;
  let unfulfillableValue = 0;
  let unfulfillableCost = 0;
  let current = 0;
  let currentValue = 0;
  let currentCost = 0;
  let fcProcessing = 0;
  let fcProcessingValue = 0;
  let fcProcessingCost = 0;
  let customerOrders = 0;
  let customerOrdersValue = 0;
  let customerOrdersCost = 0;
  let transshipment = 0;
  let transshipmentValue = 0;
  let transshipmentCost = 0;
  let inboundWorking = 0;
  let inboundWorkingValue = 0;
  let inboundWorkingCost = 0;
  let inboundShipped = 0;
  let inboundShippedValue = 0;
  let inboundShippedCost = 0;
  let inboundReceiving = 0;
  let inboundReceivingValue = 0;
  let inboundReceivingCost = 0;
  let warehouseDamaged = 0;
  let warehouseDamagedValue = 0;
  let warehouseDamagedCost = 0;
  let expired = 0;
  let expiredValue = 0;
  let expiredCost = 0;

  rows.forEach((r) => {
    const p = price(r);
    const c = cogs(r);
    const av = n(r.availableQty);
    const rv = n(r.reservedQty);
    const inv = n(r.inboundQty);
    fulfillable += av;
    fulfillableValue += p * av;
    fulfillableCost += c * av;
    reserved += rv;
    reservedValue += p * rv;
    reservedCost += c * rv;
    inbound += inv;
    inboundValue += p * inv;
    inboundCost += c * inv;

    r.byMarketplace?.forEach((m) => {
      const rq = n(m.researchingQty);
      const uq = n(m.unfulfillableQty);
      const cq = n(m.currentQty);
      const fcp = n(m.fcProcessingQty);
      const co = n(m.customerOrdersQty);
      const ts = n(m.transshipmentQty);
      const iw = n(m.inboundWorkingQty);
      const ish = n(m.inboundShippedQty);
      const ir = n(m.inboundReceivingQty);
      const wd = n(m.warehouseDamagedQty);
      const ex = n(m.expiredQty);

      researching += rq;
      researchingValue += p * rq;
      researchingCost += c * rq;
      unfulfillable += uq;
      unfulfillableValue += p * uq;
      unfulfillableCost += c * uq;
      current += cq;
      currentValue += p * cq;
      currentCost += c * cq;
      fcProcessing += fcp;
      fcProcessingValue += p * fcp;
      fcProcessingCost += c * fcp;
      customerOrders += co;
      customerOrdersValue += p * co;
      customerOrdersCost += c * co;
      transshipment += ts;
      transshipmentValue += p * ts;
      transshipmentCost += c * ts;
      inboundWorking += iw;
      inboundWorkingValue += p * iw;
      inboundWorkingCost += c * iw;
      inboundShipped += ish;
      inboundShippedValue += p * ish;
      inboundShippedCost += c * ish;
      inboundReceiving += ir;
      inboundReceivingValue += p * ir;
      inboundReceivingCost += c * ir;
      warehouseDamaged += wd;
      warehouseDamagedValue += p * wd;
      warehouseDamagedCost += c * wd;
      expired += ex;
      expiredValue += p * ex;
      expiredCost += c * ex;
    });
  });

  // Total value/cost from product-level totalQty to avoid double-counting
  const totalValue = rows.reduce((sum, r) => sum + price(r) * n(r.totalQty), 0);
  const totalCost = rows.reduce((sum, r) => sum + cogs(r) * n(r.totalQty), 0);
  const totalProfit = totalValue - totalCost;
  const totalRoiPct = totalCost > 0 ? (totalProfit / totalCost) * 100 : null;

  // Granular statuses from FBA API (details=true): show all breakdowns we store; profit = value - cost, ROI = profit/cost
  type StatusRow = { label: string; value: number; stockValue: number; unitCost: number; profit: number; roiPct: number | null };
  const toStatusRow = (label: string, value: number, stockValue: number, unitCost: number): StatusRow => ({
    label,
    value,
    stockValue,
    unitCost,
    profit: stockValue - unitCost,
    roiPct: unitCost > 0 ? ((stockValue - unitCost) / unitCost) * 100 : null,
  });
  const statuses: StatusRow[] = [
    toStatusRow("Fulfillable", fulfillable, fulfillableValue, fulfillableCost),
    toStatusRow("FC Processing", fcProcessing, fcProcessingValue, fcProcessingCost),
    toStatusRow("Customer Orders", customerOrders, customerOrdersValue, customerOrdersCost),
    toStatusRow("Transshipment", transshipment, transshipmentValue, transshipmentCost),
    toStatusRow("Reserved", reserved, reservedValue, reservedCost),
    toStatusRow("Inbound Working", inboundWorking, inboundWorkingValue, inboundWorkingCost),
    toStatusRow("Inbound Shipped", inboundShipped, inboundShippedValue, inboundShippedCost),
    toStatusRow("Inbound Receiving", inboundReceiving, inboundReceivingValue, inboundReceivingCost),
    toStatusRow("Inbound", inbound, inboundValue, inboundCost),
    toStatusRow("Researching", researching, researchingValue, researchingCost),
    toStatusRow("Unfulfillable", unfulfillable, unfulfillableValue, unfulfillableCost),
    toStatusRow("Warehouse Damaged", warehouseDamaged, warehouseDamagedValue, warehouseDamagedCost),
    toStatusRow("Expired", expired, expiredValue, expiredCost),
    toStatusRow("Current", current > 0 ? current : total, current > 0 ? currentValue : totalValue, current > 0 ? currentCost : totalCost),
  ];

  return (
    <div className="flex w-full flex-col rounded-xl p-4 ring-1 ring-[var(--surface-border)]">
      <h2 className="mb-2 text-sm font-medium uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
        Inventory summary
      </h2>
      {loading && (
        <p className="text-[11px] text-[var(--muted-foreground)]">Loading…</p>
      )}
      {error && (
        <p className="text-[11px] text-red-600">{error}</p>
      )}
      {!loading && !error && (
        <div className="min-w-0 w-full overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-[var(--surface-border)] text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                <th className="py-1 pr-2 text-left">Status</th>
                <th className="py-1 text-right">Qty</th>
                <th className="py-1 pl-2 text-right">Stock value</th>
                <th className="py-1 pl-2 text-right">Unit cost</th>
                <th className="py-1 pl-2 text-right">Profit</th>
                <th className="py-1 pl-2 text-right">ROI</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-[var(--surface-border)] bg-[var(--surface)]/50 font-semibold">
                <td className="py-1.5 pr-2 text-[var(--foreground)]">Total</td>
                <td className="py-1.5 text-right tabular-nums text-[var(--foreground)]">{total.toLocaleString()}</td>
                <td className="py-1.5 pl-2 text-right tabular-nums text-[var(--foreground)]">{formatCurrency(totalValue, currency, 2)}</td>
                <td className="py-1.5 pl-2 text-right tabular-nums text-[var(--foreground)]">{formatCurrency(totalCost, currency, 2)}</td>
                <td className="py-1.5 pl-2 text-right tabular-nums text-[var(--foreground)]">{formatCurrency(totalProfit, currency, 2)}</td>
                <td className="py-1.5 pl-2 text-right tabular-nums text-[var(--foreground)]">{totalRoiPct != null ? `${totalRoiPct.toFixed(1)}%` : "—"}</td>
              </tr>
              {statuses.map(({ label, value, stockValue, unitCost, profit, roiPct }) => (
                <tr key={label} className="border-b border-[var(--surface-border)] last:border-b-0">
                  <td className="py-1 pr-2 text-[var(--muted-foreground)]">{label}</td>
                  <td className="py-1 text-right font-medium tabular-nums text-[var(--foreground)]">{value.toLocaleString()}</td>
                  <td className="py-1 pl-2 text-right tabular-nums text-[var(--foreground)]">{formatCurrency(stockValue, currency, 2)}</td>
                  <td className="py-1 pl-2 text-right tabular-nums text-[var(--foreground)]">{formatCurrency(unitCost, currency, 2)}</td>
                  <td className="py-1 pl-2 text-right tabular-nums text-[var(--foreground)]">{formatCurrency(profit, currency, 2)}</td>
                  <td className="py-1 pl-2 text-right tabular-nums text-[var(--foreground)]">{roiPct != null ? `${roiPct.toFixed(1)}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type DonutCardProps = {
  label: string;
  value: string;
  percentage: number;
  color: string;
  /** Small title shown above the value in the center (e.g. "Profit", "ROI") */
  centerTitle?: string;
  /** Override center: line 1 (amount, biggest), line 2 ("Profit on Sales"), line 3 (percent) */
  centerLine1?: string;
  centerLine2?: string;
  centerLine3?: string;
  /** Optional helper note shown under the label (e.g. when a metric requires setup). */
  note?: ReactNode;
  /** When true, show only value (no %); ring stays empty. Use for metrics without a meaningful %. */
  hidePercentage?: boolean;
};

type SalesTrendProps = {
  baseUrl: string;
  isSignedIn: boolean | undefined;
  getToken: (args: { template?: string }) => Promise<string | null>;
  currency: string;
  start: string;
  end: string;
  label: string;
  /** When true, do not render outer box/title (parent provides them) */
  noWrapper?: boolean;
};

function SalesTrend({
  baseUrl,
  isSignedIn,
  getToken,
  currency,
  start,
  end,
  label,
  noWrapper = false,
}: SalesTrendProps) {
  const [sales, setSales] = useState<SalesSeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!isSignedIn) {
      setSales(null);
      return;
    }

    const fetchSales = async () => {
      setLoading(true);
      setError(null);

      try {
        const token = await getToken({ template: "backend" });
        const res = await fetch(
          `${baseUrl}/api/amazon/sales/timeseries?` +
            new URLSearchParams({ start, end }).toString(),
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );

        if (!res.ok) {
          setError("Failed to load sales trend.");
          setSales(null);
          return;
        }

        const data = (await res.json()) as SalesSeries;
        setSales(data);
      } catch {
        setError("Unable to load sales trend.");
        setSales(null);
      } finally {
        setLoading(false);
      }
    };

    fetchSales();
  }, [isSignedIn, getToken, baseUrl, start, end]);

  if (!sales && !loading && !error) {
    return null;
  }

  const points = sales?.points ?? [];
  const maxValue =
    points.length > 0
      ? points.reduce(
          (m, p) => Math.max(m, p.revenue, p.profit),
          0
        )
      : 0;
  const allZero = points.length > 0 && maxValue === 0;

  const height = 250;
  const paddingX = 22; // room for y-axis labels (right-aligned so they don’t overlap bars)
  const paddingBottom = 82; // room for bars + date labels below (no clip)
  const paddingTop = 12; // room for hover labels

  const width = 400;
  const barAreaHeight = height - paddingTop - paddingBottom;
  const barAreaWidth = width - paddingX * 2;
  const numPoints = Math.max(1, points.length);
  const bucketWidth = barAreaWidth / numPoints;
  const barWidth = bucketWidth * 0.88; // one overlapping stacked bar per day
  const revenueColor = "rgb(2, 242, 170)"; // teal
  const profitColor = "rgb(251, 191, 36)"; // amber

  const content = (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div>
          {!noWrapper && (
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
              Sales v Profit
            </p>
          )}
          <p className={`text-[11px] text-[var(--muted-foreground)] ${noWrapper ? "" : "mt-0.5"}`}>
            {label} · Revenue vs profit ({currency})
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: revenueColor }} />
            Revenue
          </span>
          <span className="inline-flex items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: profitColor }} />
            Profit
          </span>
          {loading && (
            <span className="text-[11px] text-[var(--muted-foreground)]">
              Loading…
            </span>
          )}
        </div>
      </div>
      {error && (
        <p className="text-[11px] text-red-600">{error}</p>
      )}
      {!error && (points.length === 0 || allZero) && !loading && (
        <p className="text-[11px] text-[var(--muted-foreground)]">
          No orders found for the selected period yet.
        </p>
      )}
      {points.length > 0 && !allZero && (
        <svg
          viewBox={`-50 0 ${width + 50} ${height + 35}`}
          className="mt-2 h-[18rem] min-h-[12rem] w-full"
          preserveAspectRatio="none"
        >
          {/* X-axis line */}
          <line
            x1={paddingX}
            y1={paddingTop + barAreaHeight}
            x2={width - paddingX}
            y2={paddingTop + barAreaHeight}
            stroke="currentColor"
            strokeWidth={1}
            opacity={0.4}
          />
          {/* Y-axis line */}
          <line
            x1={paddingX}
            y1={paddingTop}
            x2={paddingX}
            y2={paddingTop + barAreaHeight}
            stroke="currentColor"
            strokeWidth={1}
            opacity={0.4}
          />
          {/* Y-axis grid / labels – compact format, right-aligned to avoid overlap */}
          {maxValue > 0 &&
            [0, 0.5, 1].map((ratio, idx) => {
              const value = maxValue * ratio;
              const y =
                paddingTop +
                (1 - ratio) * barAreaHeight;
              const compactLabel =
                value >= 1000
                  ? `${(value / 1000).toFixed(1)}k`
                  : value >= 1
                    ? Math.round(value).toString()
                    : value > 0
                      ? value.toFixed(1)
                      : "0";
              return (
                <g key={`y-${idx}`}>
                  <line
                    x1={paddingX}
                    x2={width - paddingX}
                    y1={y}
                    y2={y}
                    stroke="currentColor"
                    strokeWidth={0.5}
                    opacity={0.15}
                  />
                  <text
                    x={paddingX - 2}
                    y={y + 3}
                    textAnchor="end"
                    fontSize="7"
                    fill="currentColor"
                  >
                    {compactLabel}
                  </text>
                </g>
              );
            })}

          {points.map((p, idx) => {
            const bucketLeft = paddingX + idx * bucketWidth;
            const barX = bucketLeft + (bucketWidth - barWidth) / 2;
            const revenueRatio = maxValue > 0 ? p.revenue / maxValue : 0;
            const profitRatio = maxValue > 0 ? p.profit / maxValue : 0;
            const revenueHeight = revenueRatio * barAreaHeight;
            const profitHeight = profitRatio * barAreaHeight;
            const barBottomY = paddingTop + barAreaHeight;
            const profitSegmentTopY = barBottomY - profitHeight;
            const barTopY = barBottomY - revenueHeight;
            const isHovered = hoveredIndex === idx;

            return (
              <g
                key={p.date}
                onMouseEnter={() => setHoveredIndex(idx)}
                onMouseLeave={() => setHoveredIndex(null)}
              >
                {/* Profit (amber) – bottom segment, drawn first */}
                <rect
                  x={barX}
                  y={profitSegmentTopY}
                  width={barWidth}
                  height={profitHeight}
                  fill={isHovered ? profitColor : "rgba(251, 191, 36, 0.7)"}
                  rx={2}
                  className="cursor-pointer"
                />
                {/* Revenue extends above profit (green) – overlapping, revenue = profit + (revenue - profit) */}
                {revenueHeight > profitHeight && (
                  <rect
                    x={barX}
                    y={barTopY}
                    width={barWidth}
                    height={revenueHeight - profitHeight}
                    fill={isHovered ? revenueColor : "rgba(2, 242, 170, 0.6)"}
                    rx={2}
                    className="cursor-pointer"
                  />
                )}
              </g>
            );
          })}
          {hoveredIndex !== null && points[hoveredIndex] && (
            (() => {
              const p = points[hoveredIndex];
              const x =
                paddingX +
                hoveredIndex * bucketWidth +
                bucketWidth / 2;
              const revenueRatio = maxValue > 0 ? p.revenue / maxValue : 0;
              const revenueHeight = revenueRatio * barAreaHeight;
              const y = paddingTop + (barAreaHeight - revenueHeight);
              const isZero = p.revenue === 0 && p.profit === 0;
              const label = isZero
                ? "Zero sales"
                : `Revenue: ${formatCurrency(p.revenue, currency)} · Profit: ${formatCurrency(p.profit, currency)}`;
              const approxWidth = Math.min(label.length * 5.5, 140);
              const padding = 6;
              const rectWidth = approxWidth + padding * 2;
              const rectY = Math.max(4, y - 22);
              const textY = rectY + 11;

              return (
                <g>
                  <rect
                    x={x - rectWidth / 2}
                    y={rectY}
                    width={rectWidth}
                    height={20}
                    rx={3}
                    fill="var(--surface)"
                    stroke="var(--surface-border)"
                    strokeWidth={0.5}
                  />
                  <text
                    x={x}
                    y={textY}
                    textAnchor="middle"
                    fontSize="8"
                    fill="var(--foreground)"
                  >
                    {label}
                  </text>
                </g>
              );
            })()
          )}
          {points.map((p, idx) => {
            if (idx % 2 !== 0) return null; // show date every 2 days only
            const x =
              paddingX +
              idx * bucketWidth +
              bucketWidth / 2;
            const labelY = height - 20;
            const [, month, day] = p.date.split("-"); // YYYY-MM-DD
            const label = `${day}/${month}`;

            return (
              <text
                key={`${p.date}-label`}
                x={x}
                y={labelY}
                textAnchor="end"
                fontSize="10"
                fontFamily="system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
                fontWeight="600"
                fontStyle="normal"
                fill="var(--foreground)"
                transform={`rotate(-55 ${x} ${labelY})`}
              >
                {label}
              </text>
            );
          })}
        </svg>
      )}
    </>
  );
  return noWrapper ? (
    content
  ) : (
    <div className="rounded-xl bg-transparent p-4 ring-1 ring-[var(--surface-border)]">
      {content}
    </div>
  );
}

function formatCurrency(amount: number, currency: string, decimals = 0) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  } catch {
    return `$${amount.toLocaleString()}`;
  }
}

function DonutCard({
  label,
  value,
  percentage,
  color,
  centerTitle,
  centerLine1,
  centerLine2,
  centerLine3,
  note,
  hidePercentage,
}: DonutCardProps) {
  const radius = 54;
  const strokeWidth = 12;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percentage));
  const offset = circumference * (1 - clamped / 100);
  const useCustomCenter =
    centerLine1 != null && centerLine2 != null && centerLine3 != null;
  const valueOnly = hidePercentage === true;

  const ringGreen = "rgb(2, 242, 170)";
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl bg-transparent p-2">
      <div className="relative flex h-28 w-28 items-center justify-center">
        <svg
          viewBox="0 0 120 120"
          className="h-full w-full -rotate-90"
        >
          <circle
            cx="60"
            cy="60"
            r={radius}
            stroke={ringGreen}
            strokeWidth={strokeWidth}
            fill="none"
          />
          <circle
            cx="60"
            cy="60"
            r={radius}
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            fill="none"
            style={{
              strokeDasharray: `${circumference} ${circumference}`,
              strokeDashoffset: offset,
              transition: "stroke-dashoffset 0.6s ease-out",
            }}
          />
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-center">
          {centerTitle && (
            <span className="text-[9px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
              {centerTitle}
            </span>
          )}
          {useCustomCenter ? (
            <>
              <span className="text-lg font-semibold leading-tight text-[var(--foreground)]">
                {centerLine1}
              </span>
              <span className="text-[10px] text-[var(--muted-foreground)]">
                {centerLine2}
              </span>
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-normal"
                style={{
                  backgroundColor: `${color}20`,
                  color,
                }}
              >
                {centerLine3}
              </span>
            </>
          ) : (
            <>
              <span className="text-sm font-semibold text-[var(--foreground)]">
                {value}
              </span>
              {!valueOnly && (
                <span className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
                  {clamped.toFixed(0)}%
                </span>
              )}
            </>
          )}
        </div>
      </div>
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-xs font-medium text-[var(--muted-foreground)]">
          {label}
        </p>
        {note ? (
          <p className="text-[11px] text-[var(--muted-foreground)]">{note}</p>
        ) : null}
      </div>
    </div>
  );
}

