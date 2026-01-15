"use client";

import { useEffect, useState } from "react";
import { useAuth, SignedIn, SignedOut } from "@clerk/nextjs";
import { ThemeToggle } from "../components/theme-toggle";

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
  activeSkus: number;
  unitsInFba: number;
  openShipments: number;
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

export default function Home() {
  const baseUrl =
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

  const { isSignedIn, getToken } = useAuth();
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        const res = await fetch(`${baseUrl}/api/amazon/account/summary`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

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
  }, [isSignedIn, getToken, baseUrl]);

  const effectiveCurrency = summary?.currency ?? "USD";

  const cards = summary
    ? [
        {
          label: "Revenue (30d)",
          value: formatCurrency(summary.revenue, effectiveCurrency),
          percentage: 72,
          color: "#4F46E5",
        },
        {
          label: "Profit Margin",
          value: `${Math.round(summary.profitMargin * 100)}%`,
          percentage: Math.round(summary.profitMargin * 100),
          color: "#10B981",
        },
        {
          label: "Units Sold",
          value: summary.unitsSold.toLocaleString(),
          percentage: 54,
          color: "#F97316",
        },
        {
          label: "Ad Spend",
          value: formatCurrency(summary.adSpend, effectiveCurrency),
          percentage: 41,
          color: "#EC4899",
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
        <header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
              Seller Dashboard Overview
            </h1>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">
              High-level metrics for your connected marketplaces. Data is
              currently sourced from the Amazon SP-API sandbox.
            </p>
          </div>
          <div className="mt-4 flex flex-col items-start gap-3 md:mt-0 md:flex-row md:items-center md:gap-4">
            <div className="flex items-center gap-3">
              <ThemeToggle />
              <span className="inline-flex items-center gap-2 rounded-full bg-[var(--surface-muted)] px-3 py-1 text-xs font-medium text-[var(--muted-foreground)] ring-1 ring-[var(--surface-border)]">
                <span
                  className={`inline-flex h-2 w-2 rounded-full ${
                    isSignedIn ? "bg-emerald-400" : "bg-amber-400"
                  }`}
                />
                {isSignedIn
                  ? summary
                    ? "Authenticated with Clerk (Amazon account connected)"
                    : "Authenticated with Clerk — connect Amazon to see live data"
                  : "Please sign in (top-right) to load live data"}
              </span>
            </div>
          </div>
        </header>

        {loading && (
          <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface-muted)] px-4 py-3 text-xs text-[var(--muted-foreground)]">
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
          <section className="rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-6 shadow-[0_18px_60px_-40px_rgba(15,23,42,1)]">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-sm font-medium uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
                Performance Snapshot
              </h2>
              <span className="text-xs text-[var(--muted-foreground)]">
                Last 30 days
              </span>
            </div>

            <div className="grid gap-6 md:grid-cols-4">
              {cards.map((card) => (
                <DonutCard key={card.label} {...card} />
              ))}
            </div>

            <div className="mt-8 grid gap-4 md:grid-cols-4">
              {kpiCards.map((card) => (
                <KpiCard key={card.label} {...card} />
              ))}
            </div>

            <SalesTrend
              baseUrl={baseUrl}
              isSignedIn={isSignedIn}
              getToken={getToken}
              currency={effectiveCurrency}
            />
          </section>
        )}
      </main>
    </div>
  );
}

type DonutCardProps = {
  label: string;
  value: string;
  percentage: number;
  color: string;
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
};

function SalesTrend({
  baseUrl,
  isSignedIn,
  getToken,
  currency,
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
        const res = await fetch(`${baseUrl}/api/amazon/sales/timeseries`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

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
  }, [isSignedIn, getToken, baseUrl, setSales, setError]);

  if (!sales && !loading && !error) {
    return null;
  }

  const points = sales?.points ?? [];
  const maxValue =
    points.length > 0
      ? points.reduce(
          (m, p) =>
            Math.max(
              m,
              mode === "revenue" ? p.revenue : p.orders
            ),
          0
        )
      : 0;

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
    <div className="mt-8 rounded-xl bg-[var(--surface-muted)] p-4 ring-1 ring-[var(--surface-border)]">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
            Sales Trend
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
            Last 30 days ·{" "}
            {mode === "revenue" ? currency : "Orders"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-full bg-[var(--surface)] p-0.5 text-[10px] ring-1 ring-[var(--surface-border)]">
            <button
              type="button"
              onClick={() => setMode("revenue")}
              className={`px-2 py-0.5 rounded-full ${
                mode === "revenue"
                  ? "bg-[var(--foreground)] text-[var(--background)]"
                  : "text-[var(--muted-foreground)]"
              } cursor-pointer`}
            >
              Revenue
            </button>
            <button
              type="button"
              onClick={() => setMode("orders")}
              className={`px-2 py-0.5 rounded-full ${
                mode === "orders"
                  ? "bg-[var(--foreground)] text-[var(--background)]"
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
      {!error && points.length === 0 && !loading && (
        <p className="text-[11px] text-[var(--muted-foreground)]">
          No orders found for the selected period yet.
        </p>
      )}
      {points.length > 0 && (
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
                  fill={hoveredIndex === idx ? "#4F46E5" : "#A5B4FC"}
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
            const label = p.date.slice(5); // MM-DD

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

function formatCurrency(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `$${amount.toLocaleString()}`;
  }
}

function DonutCard({ label, value, percentage, color }: DonutCardProps) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percentage));
  const offset = circumference * (1 - clamped / 100);

  return (
    <div className="flex flex-col items-center gap-4 rounded-xl bg-[var(--surface-muted)] p-4 ring-1 ring-[var(--surface-border)]">
      <div className="relative flex h-32 w-32 items-center justify-center">
        <svg
          viewBox="0 0 120 120"
          className="h-full w-full -rotate-90 text-[var(--chart-track)]"
        >
          <circle
            cx="60"
            cy="60"
            r={radius}
            stroke="currentColor"
            strokeWidth="12"
            fill="none"
          />
          <circle
            cx="60"
            cy="60"
            r={radius}
            stroke={color}
            strokeWidth="12"
            strokeLinecap="round"
            fill="none"
            style={{
              strokeDasharray: `${circumference} ${circumference}`,
              strokeDashoffset: offset,
              transition: "stroke-dashoffset 0.6s ease-out",
            }}
          />
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-sm font-semibold text-[var(--foreground)]">
            {value}
          </span>
          <span className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
            {clamped.toFixed(0)}%
          </span>
        </div>
      </div>
      <p className="text-center text-xs font-medium text-[var(--muted-foreground)]">
        {label}
      </p>
    </div>
  );
}

function KpiCard({ label, value, helper }: KpiCardProps) {
  return (
    <div className="flex flex-col justify-between rounded-xl bg-[var(--surface-muted)] p-4 ring-1 ring-[var(--surface-border)]">
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


