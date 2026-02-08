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
};

type SalesSeries = {
  currency: string;
  points: SalesPoint[];
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
    "today" | "7d" | "30d" | "custom"
  >("30d");
  const [customStart, setCustomStart] = useState<string>("");
  const [customEnd, setCustomEnd] = useState<string>("");
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingCogsCount, setMissingCogsCount] = useState<number | null>(null);

  const toDateOnly = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const defaultEnd = toDateOnly(today);
  const defaultStart30 = toDateOnly(
    new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000),
  );

  const effectiveStart = startParam ?? defaultStart30;
  const effectiveEnd = endParam ?? defaultEnd;

  const rangeLabel =
    rangePreset === "today"
      ? "Today"
      : rangePreset === "7d"
        ? "Last 7 days"
        : rangePreset === "30d"
          ? "Last 30 days"
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
      if (startIsToday && endIsToday) setRangePreset("today");
      else if (startIs7 && endIsToday) setRangePreset("7d");
      else if (startIs30 && endIsToday) setRangePreset("30d");
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

  useEffect(() => {
    if (!isSignedIn) {
      setMissingCogsCount(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const token = await getToken({ template: "backend" });
        if (!token) return;

        const res = await fetch(
          `${baseUrl}/api/amazon/cost-of-goods/missing?` +
            new URLSearchParams({
              start: effectiveStart,
              end: effectiveEnd,
            }).toString(),
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) return;

        const data = (await res.json()) as { missingSkusCount?: number };
        if (!cancelled) setMissingCogsCount(Number(data.missingSkusCount ?? 0));
      } catch {
        if (!cancelled) setMissingCogsCount(null);
      }
    })();

    return () => {
      cancelled = true;
    };
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
  const showMissingCogs = (missingCogsCount ?? 0) > 0;
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
          ) : showMissingCogs ? (
            <span>
              COGS missing for{" "}
              <span className="font-medium text-[var(--foreground)]">
                {missingCogsCount}
              </span>{" "}
              SKU{missingCogsCount === 1 ? "" : "s"}.{" "}
              <Link
                href={`/cost-of-goods?${new URLSearchParams({
                  missing: "1",
                  start: effectiveStart,
                  end: effectiveEnd,
                }).toString()}`}
                className="underline underline-offset-2"
              >
                Fix now
              </Link>
              .
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
        },
      ]
    : [];

  const kpiCards = summary
    ? [
        {
          label: "Total Orders",
          value: summary.totalOrders.toLocaleString(),
          helper: "All marketplaces · 30d",
        },
        {
          label: "Active SKUs",
          value: summary.activeSkus.toLocaleString(),
          helper: "Live & in stock",
        },
        {
          label: "Units in FBA",
          value: summary.unitsInFba.toLocaleString(),
          helper: "Fulfilled by Amazon",
        },
        {
          label: "Open Shipments",
          value: summary.openShipments.toLocaleString(),
          helper: "Inbound & pending",
        },
      ]
    : [];
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-10 px-6 py-10">

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
          <section>
            <div className="mb-4 flex items-center justify-between">
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
                      | "custom";
                    setRangePreset(v);
                    if (v === "custom") return;
                    const end = defaultEnd;
                    const start =
                      v === "today"
                        ? defaultEnd
                        : v === "7d"
                          ? toDateOnly(
                              new Date(
                                today.getTime() - 6 * 24 * 60 * 60 * 1000,
                              ),
                            )
                          : defaultStart30;
                    setRangeInUrl(start, end);
                  }}
                  className="h-8 cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-2 text-xs text-[var(--foreground)] outline-none"
                >
                  <option value="today">Today</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="custom">Custom</option>
                </select>
                {rangePreset === "custom" ? (
                  <>
                    <input
                      type="date"
                      value={customStart}
                      onChange={(e) => setCustomStart(e.target.value)}
                      className="h-8 rounded-lg border border-[var(--surface-border)] bg-transparent px-2 text-xs text-[var(--foreground)] outline-none"
                    />
                    <span>→</span>
                    <input
                      type="date"
                      value={customEnd}
                      onChange={(e) => setCustomEnd(e.target.value)}
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

            <div className="grid gap-4 md:grid-cols-4">
              {cards.map((card) => (
                <DonutCard key={card.label} {...card} />
              ))}
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-4">
              {kpiCards.map((card) => (
                <KpiCard key={card.label} {...card} />
              ))}
            </div>

            <SalesTrend
              baseUrl={baseUrl}
              isSignedIn={isSignedIn}
              getToken={getToken}
              currency={effectiveCurrency}
              start={effectiveStart}
              end={effectiveEnd}
              label={rangeLabel}
            />
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
        <div className="mx-auto max-w-6xl px-6 py-10 text-sm text-[var(--muted-foreground)]">
          Loading…
        </div>
      }
    >
      <HomeInner />
    </Suspense>
  );
}

type DonutCardProps = {
  label: string;
  value: string;
  percentage: number;
  color: string;
  /** Override center: line 1 (amount, biggest), line 2 ("Profit on Sales"), line 3 (percent) */
  centerLine1?: string;
  centerLine2?: string;
  centerLine3?: string;
  /** Optional helper note shown under the label (e.g. when a metric requires setup). */
  note?: ReactNode;
  /** When true, show only value (no %); ring stays empty. Use for metrics without a meaningful %. */
  hidePercentage?: boolean;
};

type KpiCardProps = {
  label: string;
  value: string;
  helper?: string;
};

type SalesTrendProps = {
  baseUrl: string;
  isSignedIn: boolean | undefined;
  getToken: (args: { template?: string }) => Promise<string | null>;
  currency: string;
  start: string;
  end: string;
  label: string;
};

function SalesTrend({
  baseUrl,
  isSignedIn,
  getToken,
  currency,
  start,
  end,
  label,
}: SalesTrendProps) {
  const [sales, setSales] = useState<SalesSeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"revenue" | "orders">("revenue");
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
          (m, p) =>
            Math.max(m, mode === "revenue" ? p.revenue : p.orders),
          0
        )
      : 0;
  const allZero = points.length > 0 && maxValue === 0;

  const width = 400;
  const height = 140;
  const paddingX = 32; // extra room on the left for y-axis labels
  const paddingBottom = 16;
  const paddingTop = 24; // extra room at the top for hover labels

  const barAreaHeight = height - paddingTop - paddingBottom;
  const barAreaWidth = width - paddingX * 2;
  const bucketWidth =
    points.length > 0 ? barAreaWidth / points.length : barAreaWidth;
  const barWidth = bucketWidth * 0.6;

  return (
    <div className="mt-4 rounded-xl bg-transparent p-4 ring-1 ring-[var(--surface-border)]">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
            Sales Trend
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
            {label} ·{" "}
            {mode === "revenue" ? currency : "Orders"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative inline-flex rounded-full bg-[var(--surface)] p-0.5 text-[10px] ring-1 ring-[var(--surface-border)]">
            <div
              className={`absolute inset-y-0 left-0 w-1/2 rounded-full bg-[var(--foreground)] transition-transform duration-200 ${
                mode === "orders" ? "translate-x-full" : "translate-x-0"
              }`}
            />
            <button
              type="button"
              onClick={() => setMode("revenue")}
              className={`relative z-10 px-2 py-0.5 rounded-full ${
                mode === "revenue"
                  ? "text-[var(--background)]"
                  : "text-[var(--muted-foreground)]"
              } cursor-pointer`}
            >
              Revenue
            </button>
            <button
              type="button"
              onClick={() => setMode("orders")}
              className={`relative z-10 px-2 py-0.5 rounded-full ${
                mode === "orders"
                  ? "text-[var(--background)]"
                  : "text-[var(--muted-foreground)]"
              } cursor-pointer`}
            >
              Orders
            </button>
          </div>
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
          viewBox={`0 0 ${width} ${height}`}
          className="mt-2 h-40 w-full"
        >
          {/* Y-axis grid / labels */}
          {maxValue > 0 &&
            [0, 0.5, 1].map((ratio, idx) => {
              const value = maxValue * ratio;
              const y =
                paddingTop +
                (1 - ratio) * barAreaHeight;
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
                    x={4}
                    y={y + 3}
                    fontSize="8"
                    fill="currentColor"
                  >
                    {mode === "revenue"
                      ? formatCurrency(
                          Math.round(value),
                          currency
                        )
                      : Math.round(value).toLocaleString()}
                  </text>
                </g>
              );
            })}

          {points.map((p, idx) => {
            const x =
              paddingX +
              idx * bucketWidth +
              (bucketWidth - barWidth) / 2;
            const valueRatio =
              maxValue > 0
                ? (mode === "revenue"
                    ? p.revenue
                    : p.orders) / maxValue
                : 0;
            const barHeight = valueRatio * barAreaHeight;
            const y = paddingTop + (barAreaHeight - barHeight);

            return (
              <g key={p.date}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={barHeight}
                  fill={hoveredIndex === idx ? "rgb(2, 242, 170)" : "rgba(2, 242, 170, 0.5)"}
                  rx={2}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoveredIndex(idx)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
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
              const valueRatio =
                maxValue > 0
                  ? (mode === "revenue"
                      ? p.revenue
                      : p.orders) / maxValue
                  : 0;
              const barHeight = valueRatio * barAreaHeight;
              const y = paddingTop + (barAreaHeight - barHeight);

              const label =
                mode === "revenue"
                  ? formatCurrency(p.revenue, currency)
                  : `${p.orders.toLocaleString()}`;
              const approxWidth = label.length * 6;
              const padding = 4;
              const rectWidth = approxWidth + padding * 2;
              const rectY = Math.max(4, y - 22);
              const textY = rectY + 10;

              return (
                <g>
                  <rect
                    x={x - rectWidth / 2}
                    y={rectY}
                    width={rectWidth}
                    height={14}
                    rx={3}
                    fill="var(--surface)"
                    stroke="var(--surface-border)"
                    strokeWidth={0.5}
                  />
                  <text
                    x={x}
                    y={textY}
                    textAnchor="middle"
                    fontSize="9"
                    fill="var(--foreground)"
                  >
                    {label}
                  </text>
                </g>
              );
            })()
          )}
          {points.map((p, idx) => {
            const step =
              points.length > 12
                ? Math.ceil(points.length / 6)
                : 1;
            const isLast = idx === points.length - 1;
            if (idx % step !== 0 && !isLast) {
              return null;
            }

            const x =
              paddingX +
              idx * bucketWidth +
              bucketWidth / 2;
            const [, month, day] = p.date.split("-"); // YYYY-MM-DD
            const label = `${day}-${month}`; // DD-MM

            return (
              <text
                key={`${p.date}-label`}
                x={x}
                y={height - 2}
                textAnchor="middle"
                fontSize="8"
                fill="currentColor"
              >
                {label}
              </text>
            );
          })}
        </svg>
      )}
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
  centerLine1,
  centerLine2,
  centerLine3,
  note,
  hidePercentage,
}: DonutCardProps) {
  const radius = 54;
  const strokeWidth = 6;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percentage));
  const offset = circumference * (1 - clamped / 100);
  const useCustomCenter =
    centerLine1 != null && centerLine2 != null && centerLine3 != null;
  const valueOnly = hidePercentage === true;

  return (
    <div className="flex flex-col items-center gap-4 rounded-xl bg-transparent p-4">
      <div className="relative flex h-36 w-36 items-center justify-center">
        <svg
          viewBox="0 0 120 120"
          className="h-full w-full -rotate-90 text-[var(--chart-track)]"
        >
          <circle
            cx="60"
            cy="60"
            r={radius}
            stroke="currentColor"
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

function KpiCard({ label, value, helper }: KpiCardProps) {
  return (
    <div className="flex flex-col justify-between rounded-xl bg-transparent p-4 ring-1 ring-[var(--surface-border)]">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
        {label}
      </p>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-xl font-semibold text-[var(--foreground)]">
          {value}
        </span>
      </div>
      {helper ? (
        <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
          {helper}
        </p>
      ) : null}
    </div>
  );
}


