"use client";

import { useAuth, SignedIn, SignedOut } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";
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
        className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--surface-hover)] text-[10px] text-[var(--muted-foreground)]"
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
      <div className="flex -space-x-2">
        {shown.map((item) => {
          const label = item.title ?? item.sellerSku ?? item.asin ?? "Product";
          return (
            <div
              key={item.id}
              className="relative h-8 w-8 shrink-0 overflow-hidden rounded-md ring-2 ring-[var(--surface)]"
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
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--surface-hover)] text-[10px] font-medium tabular-nums text-[var(--muted-foreground)] ring-2 ring-[var(--surface)]"
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

  const gridCols =
    "grid-cols-[20px_minmax(0,auto)_minmax(88px,0.75fr)_0.55fr_0.5fr_0.65fr_0.35fr_0.4fr_0.4fr_0.4fr]";

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
                                <div className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                                  {r.transportStatus ?? r.shipmentStatus ?? "—"}
                                  {r.destinationFulfillmentCenterId
                                    ? ` · FC ${r.destinationFulfillmentCenterId}`
                                    : ""}
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

                {/* Desktop table */}
                <div className="hidden overflow-x-auto md:block">
                  <div
                    className={`grid ${gridCols} items-center gap-2 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]`}
                  >
                    <div aria-hidden />
                    <div>Items</div>
                    <div>Shipment ID</div>
                    <div className="pl-0.5">Status</div>
                    <div>Created</div>
                    <div>Checked in</div>
                    <div className="text-center">Days</div>
                    <div className="text-center">Sent</div>
                    <div className="text-center">Recv</div>
                    <div className="text-center">Missing</div>
                  </div>

                  <div className="divide-y divide-[var(--surface-border)]">
                    {paginated.map((r) => {
                      const expanded = expandedId === r.id;
                      const itemCount = r.items?.length ?? r.itemLineCount ?? 0;
                      return (
                        <div key={r.id}>
                          <div
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
                            className={`grid ${gridCols} w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-sm min-w-0 transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-sb-accent ${
                              expanded ? "bg-[var(--surface-hover)]/50" : ""
                            } ${r.unitsMissing > 0 ? "bg-red-500/5" : ""}`}
                          >
                            <div className="flex items-center justify-center text-[var(--muted-foreground)]">
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
                            <div className="py-0.5">
                              <ShipmentItemThumbnails items={r.items ?? []} />
                            </div>
                            <div className="min-w-0">
                              <div className="truncate font-mono text-[var(--foreground)]" title={r.shipmentId}>
                                {r.shipmentId}
                              </div>
                              <div className="text-[10px] text-[var(--muted-foreground)]">
                                FC: {r.destinationFulfillmentCenterId ?? "—"}
                                {itemCount > 0 ? ` · ${itemCount} SKU${itemCount !== 1 ? "s" : ""}` : ""}
                              </div>
                            </div>
                            <div className="truncate pl-0.5 text-[var(--foreground)]">
                              {r.transportStatus ?? r.shipmentStatus ?? "—"}
                            </div>
                            <div className="text-[var(--foreground)]">
                              {r.createdDate != null ? (
                                <span title={r.createdDateSource === "name" ? "Parsed from shipment name" : undefined}>
                                  {formatDate(r.createdDate)}
                                  {r.createdDateSource === "name" && (
                                    <span className="ml-0.5 text-[10px] text-[var(--muted-foreground)]">*</span>
                                  )}
                                </span>
                              ) : (
                                <span className="text-[var(--muted-foreground)]">—</span>
                              )}
                            </div>
                            <div className="min-w-[5.5rem] text-[var(--foreground)]">
                              {r.checkedInDate != null ? (
                                <span title={checkedInSourceLabel(r.checkedInDateSource) ?? undefined}>
                                  {formatDate(r.checkedInDate)}
                                </span>
                              ) : r.receivedDate ? (
                                <span
                                  className="text-[var(--muted-foreground)]"
                                  title="Delivery to FC from Amazon transport data"
                                >
                                  {formatDate(r.receivedDate)}
                                </span>
                              ) : (
                                <span className="text-[var(--muted-foreground)]">—</span>
                              )}
                            </div>
                            <div className="text-center text-[var(--foreground)] tabular-nums">
                              {r.checkInDurationDays != null ? String(r.checkInDurationDays) : "—"}
                            </div>
                            <div className="text-center text-[var(--foreground)] tabular-nums">{r.unitsSent}</div>
                            <div className="text-center text-[var(--foreground)] tabular-nums">{r.unitsReceived}</div>
                            <div
                              className={`text-center tabular-nums ${
                                r.unitsMissing > 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"
                              }`}
                            >
                              {r.unitsMissing}
                            </div>
                          </div>

                          {expanded && (
                            <div className="border-t border-[var(--surface-border)] bg-[var(--surface-hover)]/20 px-4 py-3">
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
