"use client";

import { useAuth, SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useDisplaySettings } from "@/contexts/display-settings-context";
import { useMarketplace } from "@/contexts/marketplace-context";
import { getDevImpersonationHeaders } from "@/lib/impersonation";

type ShipmentRow = {
  id: string;
  shipmentId: string;
  shipmentName: string | null;
  shipmentStatus: string | null;
  destinationFulfillmentCenterId: string | null;
  createdDate: string | null;
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
};

const PAGE_SIZE = 20;

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export default function ShipmentsPage() {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const { isSignedIn, getToken } = useAuth();
  const { selectedMarketplaceId } = useMarketplace();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");

  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [manualCheckInModal, setManualCheckInModal] = useState<{ shipmentId: string; shipmentName: string | null } | null>(null);
  const [manualCheckInDate, setManualCheckInDate] = useState("");
  const [manualCheckInSaving, setManualCheckInSaving] = useState(false);
  const [manualCheckInError, setManualCheckInError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken({ template: "backend" });
      const url = new URL(`${baseUrl}/api/amazon/shipments`);
      if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          ...getDevImpersonationHeaders(devImpersonate),
          ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
        },
      });
      if (!res.ok) throw new Error("Failed to load shipments.");
      const data = (await res.json()) as ShipmentRow[];
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

  const saveManualCheckIn = async () => {
    if (!manualCheckInModal || !manualCheckInDate.trim()) return;
    setManualCheckInSaving(true);
    setManualCheckInError(null);
    try {
      const token = await getToken({ template: "backend" });
      const url = new URL(
        `${baseUrl}/api/amazon/shipments/${encodeURIComponent(manualCheckInModal.shipmentId)}/checked-in`,
      );
      if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
      const res = await fetch(url.toString(), {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          ...getDevImpersonationHeaders(devImpersonate),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ checkedInDate: manualCheckInDate.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { message?: string };
        throw new Error(body?.message ?? "Failed to set check-in date");
      }
      setManualCheckInModal(null);
      setManualCheckInDate("");
      await load();
    } catch (e) {
      setManualCheckInError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setManualCheckInSaving(false);
    }
  };

  const openManualCheckIn = (r: ShipmentRow) => {
    setManualCheckInModal({ shipmentId: r.shipmentId, shipmentName: r.shipmentName });
    setManualCheckInDate("");
    setManualCheckInError(null);
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

  return (
    <div className={`flex min-h-screen flex-col gap-4 ${backgroundClass} p-4 md:p-6`}>
      <SignedOut>
        <div className="flex flex-col items-center justify-center gap-4 py-12">
          <p className="text-[var(--muted-foreground)]">Sign in to view FBA shipments.</p>
          <SignInButton>
            <button className="rounded-lg bg-sb-accent px-4 py-2 text-sm font-medium text-black">
              Sign in
            </button>
          </SignInButton>
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
                  className="min-w-[260px] max-w-md flex-1 rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--foreground)]/60 placeholder:opacity-100 focus:outline-none focus:ring-2 focus:ring-sb-accent"
                  aria-label="Search shipments"
                />
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

          <div className="overflow-x-auto rounded-lg border border-[var(--surface-border)] bg-[var(--surface)]">
            <div className="grid grid-cols-[minmax(90px,0.9fr)_0.6fr_0.6fr_0.6fr_0.4fr_0.5fr_0.5fr_0.5fr] items-center gap-2 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
              <div>Shipment ID</div>
              <div className="pl-0.5">Status</div>
              <div>Created</div>
              <div className="flex items-center gap-1">
                Checked in
                <span
                  className="inline-flex h-5 w-5 shrink-0 cursor-help items-center justify-center rounded-full border-2 border-sb-accent bg-sb-accent text-[11px] font-semibold lowercase text-black hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-sb-accent focus:ring-offset-1"
                  title="Cannot retrieve historic check-in dates - you can enter manually"
                  aria-label="Info: Cannot retrieve historic check-in dates - you can enter manually"
                >
                  i
                </span>
              </div>
              <div className="text-center">Check-in (days)</div>
              <div className="text-center">Units sent</div>
              <div className="text-center">Units received</div>
              <div className="text-center">Missing units</div>
            </div>

            {loading ? (
              <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
                Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
                No shipments found.
              </div>
            ) : (
              <>
                <div className="divide-y divide-[var(--surface-border)]">
                  {paginated.map((r) => (
                    <div
                      key={r.id}
                      className="grid grid-cols-[minmax(90px,0.9fr)_0.6fr_0.6fr_0.6fr_0.4fr_0.5fr_0.5fr_0.5fr] items-center gap-2 px-4 py-3 text-sm min-w-0"
                    >
                      <div className="truncate font-mono text-[var(--foreground)]" title={r.shipmentId}>
                        {r.shipmentId}
                      </div>
                      <div className="truncate pl-0.5 text-[var(--foreground)]">
                        {r.transportStatus ?? r.shipmentStatus ?? "—"}
                      </div>
                      <div className="text-[var(--foreground)]">
                        {r.createdDate != null ? (
                          formatDate(r.createdDate)
                        ) : (
                          <>
                            —<span className="ml-1 text-[10px] text-[var(--muted-foreground)]" title="Created date not available from API">(unknown)</span>
                          </>
                        )}
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-1.5 text-[var(--foreground)]">
                          {r.checkedInDate != null ? (
                            <span
                              className={r.checkedInDateIsClosedDate === true ? "inline-flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-700 dark:text-amber-400" : undefined}
                              title={r.checkedInDateIsClosedDate === true ? "Closed date (shipment was already closed when synced)" : undefined}
                            >
                              {formatDate(r.checkedInDate)}
                              {r.checkedInDateIsClosedDate === true && (
                                <span className="text-[10px] font-medium" aria-hidden> closed</span>
                              )}
                            </span>
                          ) : (
                            <>
                              <span>—</span>
                              <button
                                type="button"
                                onClick={() => openManualCheckIn(r)}
                                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-[var(--surface-border)] bg-[var(--surface-hover)] text-[var(--muted-foreground)] hover:border-sb-accent/50 hover:bg-sb-accent/10 hover:text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-sb-accent"
                                title="Enter check-in date"
                                aria-label="Enter check-in date"
                              >
                                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                            </>
                          )}
                        </div>
                        <div className="text-[10px] text-[var(--muted-foreground)]">
                          FC: {r.destinationFulfillmentCenterId ?? "—"}
                        </div>
                      </div>
                      <div className="text-center text-[var(--foreground)] tabular-nums">
                        {r.checkInDurationDays != null ? String(r.checkInDurationDays) : "—"}
                      </div>
                      <div className="text-center text-[var(--foreground)] tabular-nums">
                        {r.unitsSent}
                      </div>
                      <div className="text-center text-[var(--foreground)] tabular-nums">
                        {r.unitsReceived}
                      </div>
                      <div
                        className={`text-center tabular-nums ${r.unitsMissing > 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
                      >
                        {r.unitsMissing}
                      </div>
                    </div>
                  ))}
                </div>

                {totalPages > 1 && (
                  <div className="flex items-center justify-between gap-4 border-t border-[var(--surface-border)] px-4 py-3">
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
          </div>

          {manualCheckInModal != null && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="manual-checkin-title">
              <div className="w-full max-w-sm rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] p-4 shadow-lg">
                <h2 id="manual-checkin-title" className="text-sm font-semibold text-[var(--foreground)]">Enter check-in date</h2>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Shipment: {manualCheckInModal.shipmentName ?? manualCheckInModal.shipmentId}
                </p>
                <div className="mt-3">
                  <label htmlFor="manual-checkin-date" className="block text-xs font-medium text-[var(--foreground)]">Date (YYYY-MM-DD)</label>
                  <input
                    id="manual-checkin-date"
                    type="date"
                    value={manualCheckInDate}
                    onChange={(e) => setManualCheckInDate(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-sb-accent"
                  />
                </div>
                {manualCheckInError && (
                  <p className="mt-2 text-xs text-red-600 dark:text-red-400">{manualCheckInError}</p>
                )}
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => { setManualCheckInModal(null); setManualCheckInDate(""); setManualCheckInError(null); }}
                    className="rounded-lg border border-[var(--surface-border)] px-3 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--surface-hover)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveManualCheckIn}
                    disabled={manualCheckInSaving || !manualCheckInDate.trim()}
                    className="rounded-lg bg-sb-accent px-3 py-2 text-sm font-medium text-black hover:opacity-90 disabled:opacity-60"
                  >
                    {manualCheckInSaving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </SignedIn>
    </div>
  );
}
