import { ThemeToggle } from "../components/theme-toggle";

export default function Home() {
  const cards = [
    {
      label: "Revenue (30d)",
      value: "$24.3k",
      percentage: 72,
      color: "#4F46E5",
    },
    {
      label: "Profit Margin",
      value: "28%",
      percentage: 28,
      color: "#10B981",
    },
    {
      label: "Units Sold",
      value: "3,240",
      percentage: 54,
      color: "#F97316",
    },
    {
      label: "Ad Spend",
      value: "$6.1k",
      percentage: 41,
      color: "#EC4899",
    },
  ];

  const kpiCards = [
    {
      label: "Total Orders",
      value: "4,812",
      helper: "All marketplaces · 30d",
    },
    {
      label: "Active SKUs",
      value: "186",
      helper: "Live & in stock",
    },
    {
      label: "Units in FBA",
      value: "9,430",
      helper: "Fulfilled by Amazon",
    },
    {
      label: "Open Shipments",
      value: "17",
      helper: "Inbound & pending",
    },
  ];

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
              currently mocked; you&apos;ll wire this to Amazon later.
            </p>
          </div>
          <div className="mt-2 flex items-center gap-3 md:mt-0">
            <ThemeToggle />
            <span className="inline-flex items-center gap-2 rounded-full bg-[var(--surface-muted)] px-3 py-1 text-xs font-medium text-[var(--muted-foreground)] ring-1 ring-[var(--surface-border)]">
              <span className="inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              Live preview (dummy data)
            </span>
          </div>
        </header>

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
        </section>
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


