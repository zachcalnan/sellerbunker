"use client";

import { useAuth, SignedIn, SignedOut } from "@clerk/nextjs";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useDisplaySettings } from "@/contexts/display-settings-context";
import { useMarketplace } from "@/contexts/marketplace-context";
import { SignInButtonWithReturn } from "@/components/sign-in-button-with-return";
import { getDevImpersonationHeaders } from "@/lib/impersonation";

type ShipmentItemLine = {
  id: string;
  sellerSku: string | null;
  fnsku: string | null;
  asin: string | null;
  title: string | null;
  imageUrl: string | null;
  quantityShipped: number;
  quantityReceived: number;
  quantityDamaged: number;
  quantityDisposed: number;
  quantityMissing: number;
};

type ShipmentRow = {
  id: string;
  shipmentId: string;
  shipmentName: string | null;
  shipmentStatus: string | null;
  /** Friendly lifecycle label from Amazon inbound status (not carrier transport). */
  statusLabel?: string | null;
  lifecycleStatus?: string | null;
  isDelayed?: boolean;
  /** Delivered at FC but check-in / receiving has not started. */
  awaitingCheckIn?: boolean;
  destinationFulfillmentCenterId: string | null;
  createdDate: string | null;
  createdDateSource?: "api" | "name" | null;
  lastUpdatedDate: string | null;
  createdAt: string;
  updatedAt: string;
  unitsSent: number;
  unitsReceived: number;
  unitsDamaged: number;
  unitsDisposed: number;
  unitsMissing: number;
  pickupDate: string | null;
  transportStatus: string | null;
  deliveryDate: string | null;
  damageClosedDate: string | null;
  checkInDurationDays: number | null;
  checkedInDate: string | null;
  checkedInDateIsClosedDate: boolean | null;
  checkedInDateSource?: "check_in" | "closed" | "delivery" | "last_updated" | "inbound_plan" | null;
  receivedDate?: string | null;
  itemLineCount?: number;
  items?: ShipmentItemLine[];
};

const PAGE_SIZE = 100;

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

const LIFECYCLE_LABELS: Record<string, string> = {
  WORKING: "Working",
  READY_TO_SHIP: "Ready to ship",
  SHIPPED: "Shipped",
  IN_TRANSIT: "In transit",
  DELIVERED: "Delivered",
  CHECKED_IN: "Checked in",
  RECEIVING: "Receiving",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
  DELETED: "Deleted",
  ERROR: "Error",
  AVAILABLE: "Available",
};

/** Bright stage colours. Finished rows stay quiet; a live stage glows. */
const LIFECYCLE_TEXT: Record<string, string> = {
  WORKING: "text-slate-500 dark:text-slate-300",
  READY_TO_SHIP: "text-indigo-500 dark:text-indigo-300",
  SHIPPED: "text-blue-500 dark:text-blue-300",
  IN_TRANSIT: "text-cyan-500 dark:text-cyan-300",
  DELIVERED: "text-fuchsia-500 dark:text-fuchsia-300",
  CHECKED_IN: "text-teal-500 dark:text-teal-300",
  RECEIVING: "text-sky-500 dark:text-sky-300",
  AVAILABLE: "text-emerald-600 dark:text-emerald-300",
  CLOSED: "text-[var(--muted-foreground)]",
  CANCELLED: "text-rose-500 dark:text-rose-300",
  DELETED: "text-[var(--muted-foreground)]",
  ERROR: "text-red-500 dark:text-red-300",
};

const LIFECYCLE_DOT: Record<string, string> = {
  READY_TO_SHIP: "bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.95)]",
  SHIPPED: "bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.95)]",
  IN_TRANSIT: "bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.95)]",
  DELIVERED: "bg-fuchsia-400 shadow-[0_0_8px_rgba(232,121,249,0.95)]",
  CHECKED_IN: "bg-teal-300 shadow-[0_0_8px_rgba(45,212,191,0.95)]",
  RECEIVING: "bg-sky-300 shadow-[0_0_8px_rgba(56,189,248,0.95)]",
  AVAILABLE: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.85)]",
  ERROR: "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.95)]",
};

const STAGE_RANK: Record<string, number> = {
  WORKING: 0,
  READY_TO_SHIP: 1,
  SHIPPED: 2,
  IN_TRANSIT: 3,
  DELIVERED: 4,
  CHECKED_IN: 5,
  RECEIVING: 6,
  CLOSED: 7,
  AVAILABLE: 8,
};

function normalizeStatusCode(raw: string | null | undefined): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function resolveRowLifecycle(row: ShipmentRow): { code: string; label: string } {
  const sent = Math.max(0, row.unitsSent || 0);
  const received = Math.max(0, row.unitsReceived || 0);
  const missing = Math.max(0, row.unitsMissing || 0);
  const code = normalizeStatusCode(row.lifecycleStatus ?? row.shipmentStatus);
  const derivedAvailable =
    code === "CLOSED" && received > 0 && (missing === 0 || received >= sent);
  const resolved = derivedAvailable ? "AVAILABLE" : code || "UNKNOWN";
  const label =
    (derivedAvailable ? LIFECYCLE_LABELS.AVAILABLE : null) ??
    row.statusLabel ??
    LIFECYCLE_LABELS[resolved] ??
    (resolved && resolved !== "UNKNOWN"
      ? resolved
          .toLowerCase()
          .split("_")
          .filter(Boolean)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ")
      : "—");
  return { code: resolved, label };
}

function rowIsDelayed(row: ShipmentRow, code: string): boolean {
  if (typeof row.isDelayed === "boolean") return row.isDelayed;
  if (code !== "SHIPPED" && code !== "IN_TRANSIT") return false;
  const now = Date.now();
  if (row.deliveryDate) {
    const delivery = new Date(row.deliveryDate).getTime();
    if (!Number.isNaN(delivery) && delivery < now - 12 * 60 * 60 * 1000) return true;
  }
  if (!row.deliveryDate && row.pickupDate) {
    const pickup = new Date(row.pickupDate).getTime();
    if (!Number.isNaN(pickup) && (now - pickup) / (24 * 60 * 60 * 1000) >= 10) return true;
  }
  return false;
}

function ShipmentStatus({ row }: { row: ShipmentRow }) {
  const { code, label } = resolveRowLifecycle(row);
  const delayed = rowIsDelayed(row, code);
  const awaitingCheckIn =
    typeof row.awaitingCheckIn === "boolean"
      ? row.awaitingCheckIn
      : code === "DELIVERED" && (row.unitsReceived || 0) === 0;
  const missingClose = code === "CLOSED" && row.unitsMissing > 0;
  const tone = delayed
    ? "text-amber-600 dark:text-amber-300"
    : missingClose
      ? "text-rose-600 dark:text-rose-300"
      : (LIFECYCLE_TEXT[code] ?? "text-[var(--foreground)]");
  const dot = delayed ? "bg-amber-400" : LIFECYCLE_DOT[code];
  const title = [
    awaitingCheckIn ? "Delivered, awaiting check-in" : null,
    delayed ? "Past the expected delivery date" : null,
    row.shipmentStatus ? `Amazon: ${row.shipmentStatus}` : null,
    row.transportStatus ? `Carrier: ${row.transportStatus}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 whitespace-nowrap text-[13px] font-medium leading-none ${tone}`}
      title={title || undefined}
    >
      {dot ? <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden /> : null}
      <span className="truncate">{label}</span>
    </span>
  );
}

function ShipmentJourney({ row }: { row: ShipmentRow }) {
  const { code } = resolveRowLifecycle(row);
  const rank = STAGE_RANK[code] ?? -1;
  const closed = code === "CLOSED" || code === "AVAILABLE";
  const steps: Array<{
    id: string;
    label: string;
    date: string | null;
    note?: string | null;
    min: number;
    text: string;
    dot: string;
  }> = [
    {
      id: "created",
      label: "Created",
      date: row.createdDate,
      min: 0,
      text: "text-slate-500 dark:text-slate-200",
      dot: "bg-slate-300 shadow-[0_0_8px_rgba(203,213,225,0.8)]",
    },
    {
      id: "pickup",
      label: "Picked up",
      date: row.pickupDate,
      min: 2,
      text: "text-blue-500 dark:text-blue-300",
      dot: "bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.95)]",
    },
    {
      id: "transit",
      label: "In transit",
      date: null,
      note: row.transportStatus,
      min: 3,
      text: "text-cyan-500 dark:text-cyan-300",
      dot: "bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.95)]",
    },
    {
      id: "delivered",
      label: "Delivered",
      date: row.deliveryDate,
      min: 4,
      text: "text-fuchsia-500 dark:text-fuchsia-300",
      dot: "bg-fuchsia-400 shadow-[0_0_8px_rgba(232,121,249,0.95)]",
    },
    {
      id: "checked",
      label: "Checked in",
      date: row.checkedInDate,
      min: 5,
      text: "text-teal-500 dark:text-teal-300",
      dot: "bg-teal-300 shadow-[0_0_8px_rgba(45,212,191,0.95)]",
    },
    {
      id: "receiving",
      label: "Receiving",
      date: row.receivedDate ?? null,
      min: 6,
      text: "text-sky-500 dark:text-sky-300",
      dot: "bg-sky-300 shadow-[0_0_8px_rgba(56,189,248,0.95)]",
    },
    {
      id: "closed",
      label: code === "AVAILABLE" ? "Available" : "Closed",
      date: closed ? row.damageClosedDate ?? row.lastUpdatedDate : row.damageClosedDate,
      min: 7,
      text: "text-emerald-600 dark:text-emerald-300",
      dot: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]",
    },
  ];
  let currentId = "";
  for (const step of steps) {
    if (rank >= step.min) currentId = step.id;
  }

  return (
    <div className="mb-4">
      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
        Send-in
      </p>
      <ol className="flex gap-2 overflow-x-auto pb-1">
        {steps.map((step) => {
          const reached = rank >= step.min || Boolean(step.date);
          const current = step.id === currentId;
          const when = step.date ? formatDate(step.date) : step.note?.replaceAll("_", " ") || "—";
          return (
            <li
              key={step.id}
              className={`min-w-[7.25rem] flex-1 rounded-lg border px-2.5 py-2 ${
                current
                  ? "border-transparent bg-[var(--background)]"
                  : "border-[var(--surface-border)] bg-[var(--background)]/60"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${reached ? step.dot : "bg-[var(--surface-border)]"}`}
                  aria-hidden
                />
                <span
                  className={`truncate text-[11px] font-semibold uppercase tracking-wide ${
                    reached ? step.text : "text-[var(--muted-foreground)]"
                  }`}
                >
                  {step.label}
                </span>
              </div>
              <div
                className={`mt-1 pl-3.5 text-xs tabular-nums ${
                  reached && step.date ? "text-[var(--foreground)]" : "text-[var(--muted-foreground)]"
                }`}
              >
                {when}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function checkedInSourceLabel(
  source: ShipmentRow["checkedInDateSource"],
): string | null {
  switch (source) {
    case "delivery":
      return "Est. from delivery";
    case "closed":
      return "Est. from closed";
    case "last_updated":
      return "Est. from last update";
    case "check_in":
      return "From Amazon";
    case "inbound_plan":
      return "From Amazon inbound";
    default:
      return null;
  }
}

function ShipmentItemThumbnails({
  items,
  max = 5,
}: {
  items: ShipmentItemLine[];
  max?: number;
}) {
  const unique = useMemo(() => {
    const seen = new Set<string>();
    const out: ShipmentItemLine[] = [];
    for (const item of items) {
      const key = (item.asin ?? item.sellerSku ?? item.id).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }, [items]);

  if (unique.length === 0) {
    return (
      <div
        className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--surface-border)] bg-[var(--surface-hover)] text-[10px] text-[var(--muted-foreground)]"
        title="Item images load when SKU lines are synced"
      >
        —
      </div>
    );
  }

  const shown = unique.slice(0, max);
  const extra = unique.length - shown.length;

  return (
    <div className="flex items-center">
      <div className="flex gap-1">
        {shown.map((item) => {
          const label = item.title ?? item.sellerSku ?? item.asin ?? "Product";
          return (
            <div
              key={item.id}
              className="relative h-7 w-7 shrink-0 overflow-hidden rounded-md border border-[var(--surface-border)]"
              title={`${item.quantityShipped}× ${label}`}
            >
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.imageUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-[var(--surface-hover)] text-[9px] text-[var(--muted-foreground)]">
                  ?
                </div>
              )}
            </div>
          );
        })}
        {extra > 0 && (
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--surface-border)] bg-[var(--surface-hover)] text-[10px] font-medium tabular-nums text-[var(--muted-foreground)]"
            title={`${extra} more SKU${extra !== 1 ? "s" : ""}`}
          >
            +{extra}
          </div>
        )}
      </div>
    </div>
  );
}

function ShipmentItemsBreakdown({ row }: { row: ShipmentRow }) {
  const items = row.items ?? [];
  if (items.length === 0) {
    return (
      <div className="space-y-2">
        {(row.unitsSent > 0 || row.unitsReceived > 0) && (
          <div className="flex gap-3 rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2.5">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-[var(--surface-hover)] text-[10px] text-[var(--muted-foreground)]">
              {row.unitsSent || row.unitsReceived}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-[var(--foreground)]">
                <span className="tabular-nums text-sb-accent">{row.unitsSent}×</span>{" "}
                <span>Units (per-SKU detail not loaded yet)</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-xs tabular-nums">
                <span className="text-[var(--foreground)]">
                  Sent <span className="font-semibold">{row.unitsSent}</span>
                </span>
                <span className="text-[var(--foreground)]">
                  Received <span className="font-semibold">{row.unitsReceived}</span>
                </span>
                <span
                  className={
                    row.unitsMissing > 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-green-600 dark:text-green-400"
                  }
                >
                  Missing <span className="font-semibold">{row.unitsMissing}</span>
                </span>
              </div>
            </div>
          </div>
        )}
        <div className="rounded-lg border border-dashed border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--muted-foreground)]">
          {row.unitsSent > 0 || row.unitsReceived > 0
            ? "Loading per-SKU lines from Amazon…"
            : "No unit data for this shipment yet — use Sync from Amazon."}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item) => {
        const label = item.title ?? item.sellerSku ?? "Unknown product";
        return (
          <div
            key={item.id}
            className="flex gap-3 rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2.5"
          >
            {item.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.imageUrl} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
            ) : (
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-[var(--surface-hover)] text-[10px] text-[var(--muted-foreground)]">
                No img
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-[var(--foreground)]">
                <span className="tabular-nums text-sb-accent">{item.quantityShipped}×</span>{" "}
                <span className="line-clamp-2">{label}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--muted-foreground)]">
                {item.asin && (
                  <span>
                    ASIN <span className="font-mono text-[var(--foreground)]">{item.asin}</span>
                  </span>
                )}
                {item.sellerSku && (
                  <span>
                    SKU <span className="font-mono text-[var(--foreground)]">{item.sellerSku}</span>
                  </span>
                )}
                {item.fnsku && (
                  <span>
                    FNSKU <span className="font-mono text-[var(--foreground)]">{item.fnsku}</span>
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-xs tabular-nums">
                <span className="text-[var(--foreground)]">
                  Sent <span className="font-semibold">{item.quantityShipped}</span>
                </span>
                <span className="text-[var(--foreground)]">
                  Received <span className="font-semibold">{item.quantityReceived}</span>
                </span>
                {item.quantityDamaged > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">
                    Damaged <span className="font-semibold">{item.quantityDamaged}</span>
                  </span>
                )}
                <span
                  className={
                    item.quantityMissing > 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-green-600 dark:text-green-400"
                  }
                >
                  Missing <span className="font-semibold">{item.quantityMissing}</span>
                </span>
              </div>
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-4 rounded-lg border border-dashed border-[var(--surface-border)] px-3 py-2 text-xs font-medium tabular-nums text-[var(--muted-foreground)]">
        <span>Shipment total: {row.unitsSent} sent</span>
        <span>{row.unitsReceived} received</span>
        {row.unitsDamaged > 0 && <span>{row.unitsDamaged} damaged</span>}
        <span className={row.unitsMissing > 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}>
          {row.unitsMissing} missing
        </span>
      </div>
    </div>
  );
}

export default function ShipmentsPage() {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const { isSignedIn, getToken } = useAuth();
  const { selectedMarketplaceId } = useMarketplace();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");

  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: "backend" });
    return {
      Authorization: `Bearer ${token}`,
      ...getDevImpersonationHeaders(devImpersonate),
      ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
    };
  }, [getToken, devImpersonate, selectedMarketplaceId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL(`${baseUrl}/api/amazon/shipments`);
      if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
      const res = await fetch(url.toString(), { headers: await authHeaders() });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Failed to load shipments.");
      }
      const data = (await res.json()) as ShipmentRow[];
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, [authHeaders, baseUrl, devImpersonate]);

  const syncFromAmazon = useCallback(async () => {
    setSyncing(true);
    setNotice(null);
    setError(null);
    try {
      const url = new URL(`${baseUrl}/api/amazon/shipments/sync`);
      if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: await authHeaders(),
      });
      if (!res.ok) throw new Error("Sync failed.");
      const body = (await res.json()) as { synced?: number; errors?: string[] };
      const errCount = body.errors?.length ?? 0;
      setNotice(
        `Synced ${body.synced ?? 0} shipment(s)${errCount > 0 ? ` (${errCount} warning(s))` : ""}.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [authHeaders, baseUrl, devImpersonate, load]);

  useEffect(() => {
    if (!isSignedIn) {
      setRows([]);
      setError(null);
      return;
    }
    void load();
  }, [isSignedIn, load]);

  const loadShipmentDetail = useCallback(
    async (row: ShipmentRow) => {
      setDetailLoadingId(row.shipmentId);
      try {
        const url = new URL(
          `${baseUrl}/api/amazon/shipments/${encodeURIComponent(row.shipmentId)}`,
        );
        if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
        const res = await fetch(url.toString(), { headers: await authHeaders() });
        if (!res.ok) return;
        const detail = (await res.json()) as ShipmentRow;
        setRows((prev) =>
          prev.map((r) =>
            r.shipmentId === row.shipmentId
              ? {
                  ...r,
                  ...detail,
                  id: r.id,
                  items: detail.items ?? [],
                  itemLineCount: detail.items?.length ?? detail.itemLineCount ?? 0,
                }
              : r,
          ),
        );
      } finally {
        setDetailLoadingId(null);
      }
    },
    [authHeaders, baseUrl, devImpersonate],
  );

  const toggleExpand = (r: ShipmentRow) => {
    const next = expandedId === r.id ? null : r.id;
    setExpandedId(next);
    if (next === r.id) void loadShipmentDetail(r);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.shipmentId ?? "").toLowerCase().includes(q) ||
        (r.shipmentName ?? "").toLowerCase().includes(q) ||
        (r.shipmentStatus ?? "").toLowerCase().includes(q) ||
        (r.statusLabel ?? "").toLowerCase().includes(q) ||
        (r.lifecycleStatus ?? "").toLowerCase().includes(q) ||
        (r.destinationFulfillmentCenterId ?? "").toLowerCase().includes(q)
    );
  }, [rows, query]);

  const totalMissingUnits = useMemo(
    () => rows.reduce((sum, r) => sum + (r.unitsMissing ?? 0), 0),
    [rows]
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage]
  );

  const { backgroundClass } = useDisplaySettings();


  return (
    <div className={`flex min-h-screen flex-col gap-4 ${backgroundClass} p-4 md:p-6`}>
      <SignedOut>
        <div className="flex flex-col items-center justify-center gap-4 py-12">
          <p className="text-[var(--muted-foreground)]">Sign in to view FBA shipments.</p>
          <SignInButtonWithReturn>
            <button className="rounded-lg bg-sb-accent px-4 py-2 text-sm font-medium text-black">
              Sign in
            </button>
          </SignInButtonWithReturn>
        </div>
      </SignedOut>

      <SignedIn>
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h1 className="text-xl font-semibold text-[var(--foreground)]">FBA Shipments</h1>
              <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                <input
                  type="search"
                  placeholder="Search by Shipment ID, name, status, FC…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full min-w-0 max-w-md flex-1 rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--foreground)]/60 placeholder:opacity-100 focus:outline-none focus:ring-2 focus:ring-sb-accent sm:min-w-[260px]"
                  aria-label="Search shipments"
                />
                <button
                  type="button"
                  onClick={() => void syncFromAmazon()}
                  disabled={syncing || loading}
                  className="shrink-0 rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-hover)] disabled:opacity-60"
                >
                  {syncing ? "Syncing…" : "Sync from Amazon"}
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--foreground)]">
            <span className="font-semibold tabular-nums">{totalMissingUnits}</span> unit{totalMissingUnits !== 1 ? "s" : ""} missing by Amazon
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
          {notice && (
            <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--muted-foreground)]">
              {notice}
            </div>
          )}
          <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)]">
            {loading ? (
              <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">No shipments found.</div>
            ) : (
              <>
                {/* Mobile cards */}
                <div className="divide-y divide-[var(--surface-border)] md:hidden">
                  {paginated.map((r) => {
                    const expanded = expandedId === r.id;
                    const itemCount = r.items?.length ?? r.itemLineCount ?? 0;
                    return (
                      <div
                        key={`${r.id}-m`}
                        className={r.unitsMissing > 0 ? "bg-red-500/5" : undefined}
                      >
                        <button
                          type="button"
                          onClick={() => toggleExpand(r)}
                          aria-expanded={expanded}
                          className="flex w-full cursor-pointer items-start gap-3 px-3 py-3 text-left"
                        >
                          <div className="pt-1 text-[var(--muted-foreground)]">
                            <svg
                              className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                              aria-hidden
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate font-mono text-sm font-medium text-[var(--foreground)]">
                                  {r.shipmentId}
                                </div>
                                <div className="mt-1.5">
                                  <ShipmentStatus row={r} />
                                </div>
                                <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                                  {r.destinationFulfillmentCenterId
                                    ? `FC ${r.destinationFulfillmentCenterId}`
                                    : "FC —"}
                                </div>
                              </div>
                              <ShipmentItemThumbnails items={r.items ?? []} max={3} />
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                              <div>
                                <span className="text-[var(--muted-foreground)]">Created </span>
                                <span className="tabular-nums text-[var(--foreground)]">
                                  {r.createdDate != null ? formatDate(r.createdDate) : "—"}
                                </span>
                              </div>
                              <div>
                                <span className="text-[var(--muted-foreground)]">Checked in </span>
                                <span className="tabular-nums text-[var(--foreground)]">
                                  {r.checkedInDate != null
                                    ? formatDate(r.checkedInDate)
                                    : r.receivedDate
                                      ? formatDate(r.receivedDate)
                                      : "—"}
                                </span>
                              </div>
                              <div>
                                <span className="text-[var(--muted-foreground)]">Sent </span>
                                <span className="font-semibold tabular-nums text-[var(--foreground)]">
                                  {r.unitsSent}
                                </span>
                                <span className="text-[var(--muted-foreground)]"> · Recv </span>
                                <span className="font-semibold tabular-nums text-[var(--foreground)]">
                                  {r.unitsReceived}
                                </span>
                              </div>
                              <div>
                                <span className="text-[var(--muted-foreground)]">Missing </span>
                                <span
                                  className={`font-semibold tabular-nums ${
                                    r.unitsMissing > 0
                                      ? "text-red-600 dark:text-red-400"
                                      : "text-green-600 dark:text-green-400"
                                  }`}
                                >
                                  {r.unitsMissing}
                                </span>
                                {r.checkInDurationDays != null ? (
                                  <span className="text-[var(--muted-foreground)]">
                                    {" · "}
                                    {r.checkInDurationDays}d
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            {itemCount > 0 ? (
                              <div className="mt-1 text-[10px] text-[var(--muted-foreground)]">
                                {itemCount} SKU{itemCount !== 1 ? "s" : ""}
                              </div>
                            ) : null}
                          </div>
                        </button>
                        {expanded && (
                          <div className="border-t border-[var(--surface-border)] bg-[var(--surface-hover)]/20 px-3 py-3">
                            <ShipmentJourney row={r} />
                            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                              Unit breakdown
                            </p>
                            {detailLoadingId === r.shipmentId && (
                              <p className="mb-2 text-sm text-[var(--muted-foreground)]">
                                Loading per-SKU breakdown from Amazon…
                              </p>
                            )}
                            <ShipmentItemsBreakdown row={r} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Desktop table — real columns so every row shares the same edges */}
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full table-fixed border-collapse text-sm">
                    <colgroup>
                      <col className="w-[4%]" />
                      <col className="w-[12%]" />
                      <col className="w-[18%]" />
                      <col className="w-[14%]" />
                      <col className="w-[12%]" />
                      <col className="w-[12%]" />
                      <col className="w-[7%]" />
                      <col className="w-[7%]" />
                      <col className="w-[7%]" />
                      <col className="w-[7%]" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-[var(--surface-border)] text-left text-[11px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                        <th className="px-2 py-2.5" aria-hidden />
                        <th className="px-2 py-2.5 font-medium">Items</th>
                        <th className="px-2 py-2.5 font-medium">Shipment</th>
                        <th className="px-2 py-2.5 font-medium">Status</th>
                        <th className="px-2 py-2.5 font-medium">Created</th>
                        <th className="px-2 py-2.5 font-medium">Checked in</th>
                        <th className="px-2 py-2.5 text-right font-medium">Days</th>
                        <th className="px-2 py-2.5 text-right font-medium">Sent</th>
                        <th className="px-2 py-2.5 text-right font-medium">Received</th>
                        <th className="px-2 py-2.5 text-right font-medium">Missing</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginated.map((r) => {
                        const expanded = expandedId === r.id;
                        return (
                          <Fragment key={r.id}>
                            <tr
                              role="button"
                              tabIndex={0}
                              onClick={() => toggleExpand(r)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  toggleExpand(r);
                                }
                              }}
                              aria-expanded={expanded}
                              className={`cursor-pointer border-b border-[var(--surface-border)] transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-sb-accent ${
                                expanded ? "bg-[var(--surface-hover)]/50" : ""
                              }`}
                            >
                              <td className="px-2 py-2.5 text-[var(--muted-foreground)]">
                                <svg
                                  className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                  aria-hidden
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                              </td>
                              <td className="px-2 py-2.5">
                                <ShipmentItemThumbnails items={r.items ?? []} />
                              </td>
                              <td className="px-2 py-2.5">
                                <div className="truncate font-mono text-[13px] text-[var(--foreground)]" title={r.shipmentId}>
                                  {r.shipmentId}
                                </div>
                                <div className="truncate text-[11px] text-[var(--muted-foreground)]">
                                  {r.destinationFulfillmentCenterId ?? "—"}
                                </div>
                              </td>
                              <td className="px-2 py-2.5">
                                <ShipmentStatus row={r} />
                              </td>
                              <td
                                className="whitespace-nowrap px-2 py-2.5 tabular-nums text-[var(--foreground)]"
                                title={r.createdDateSource === "name" ? "Parsed from shipment name" : undefined}
                              >
                                {r.createdDate != null ? formatDate(r.createdDate) : "—"}
                              </td>
                              <td
                                className="whitespace-nowrap px-2 py-2.5 tabular-nums text-[var(--foreground)]"
                                title={
                                  r.checkedInDate != null
                                    ? (checkedInSourceLabel(r.checkedInDateSource) ?? undefined)
                                    : r.receivedDate
                                      ? "Delivery to FC from Amazon transport data"
                                      : undefined
                                }
                              >
                                {r.checkedInDate != null
                                  ? formatDate(r.checkedInDate)
                                  : r.receivedDate
                                    ? formatDate(r.receivedDate)
                                    : "—"}
                              </td>
                              <td className="px-2 py-2.5 text-right tabular-nums text-[var(--foreground)]">
                                {r.checkInDurationDays != null ? r.checkInDurationDays : "—"}
                              </td>
                              <td className="px-2 py-2.5 text-right tabular-nums text-[var(--foreground)]">
                                {r.unitsSent}
                              </td>
                              <td className="px-2 py-2.5 text-right tabular-nums text-[var(--foreground)]">
                                {r.unitsReceived}
                              </td>
                              <td
                                className={`px-2 py-2.5 text-right tabular-nums ${
                                  r.unitsMissing > 0
                                    ? "font-medium text-rose-600 dark:text-rose-400"
                                    : "text-[var(--muted-foreground)]"
                                }`}
                              >
                                {r.unitsMissing}
                              </td>
                            </tr>
                            {expanded && (
                              <tr className="border-b border-[var(--surface-border)]">
                                <td colSpan={10} className="bg-[var(--surface-hover)]/20 px-4 py-3">
                                  <ShipmentJourney row={r} />
                                  <p className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                                    Unit breakdown
                                  </p>
                                  {detailLoadingId === r.shipmentId && (
                                    <p className="mb-2 text-sm text-[var(--muted-foreground)]">
                                      Loading per-SKU breakdown from Amazon…
                                    </p>
                                  )}
                                  <ShipmentItemsBreakdown row={r} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div className="flex items-center justify-between gap-4 border-t border-[var(--surface-border)] px-4 py-3">
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
          </div>

        </div>
      </SignedIn>
    </div>
  );
}
