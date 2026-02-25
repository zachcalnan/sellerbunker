"use client";

import { useAuth, SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";

type ShipmentRow = {
  id: string;
  shipmentId: string;
  shipmentName: string | null;
  shipmentStatus: string | null;
  destinationFulfillmentCenterId: string | null;
  createdDate: string | null;
  lastUpdatedDate: string | null;
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

  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rawResponses, setRawResponses] = useState<unknown[] | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${baseUrl}/api/amazon/shipments`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load shipments.");
      const data = (await res.json()) as ShipmentRow[];
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

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    setNotice(null);
    setRawResponses(null);
    try {
      const token = await getToken();
      const res = await fetch(`${baseUrl}/api/amazon/shipments/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const body = (await res.json()) as { message?: unknown };
          const message =
            typeof body?.message === "string" ? body.message : "Failed to sync.";
          throw new Error(message);
        }
        const msg = await res.text();
        throw new Error(msg || "Failed to sync.");
      }
      const result = (await res.json()) as { synced?: number; errors?: string[]; rawResponses?: unknown[] };
      if (result.synced != null) setNotice(`Synced ${result.synced} shipment(s).`);
      if (result.errors?.length) setNotice((n) => `${n ?? ""} ${result.errors!.join("; ")}`.trim());
      setRawResponses(result.rawResponses ?? null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to sync.");
    } finally {
      setSyncing(false);
    }
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

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage]
  );

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <SignedOut>
        <div className="flex flex-col items-center justify-center gap-4 py-12">
          <p className="text-[var(--muted-foreground)]">Sign in to view FBA shipments.</p>
          <SignInButton>
            <button className="rounded-lg bg-[rgb(2,242,170)] px-4 py-2 text-sm font-medium text-black">
              Sign in
            </button>
          </SignInButton>
        </div>
      </SignedOut>

      <SignedIn>
        <div className="flex flex-col gap-4">
          <h1 className="text-xl font-semibold text-[var(--foreground)]">FBA Shipments</h1>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="search"
                placeholder="Search by Shipment ID, name, status, FC…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="max-w-md rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-[rgb(2,242,170)]"
                aria-label="Search shipments"
              />
              <button
                type="button"
                onClick={syncNow}
                disabled={syncing}
                className="shrink-0 rounded-lg bg-[rgb(2,242,170)] px-4 py-2 text-sm font-medium text-black hover:opacity-90 disabled:opacity-60"
              >
                {syncing ? "Syncing…" : "Sync shipments"}
              </button>
            </div>
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

          {rawResponses != null && rawResponses.length > 0 && (
            <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] overflow-hidden">
              <button
                type="button"
                onClick={() => setShowRaw((s) => !s)}
                className="w-full px-4 py-2 text-left text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-hover)]"
              >
                {showRaw ? "Hide" : "Show"} raw API response ({rawResponses.length} page{rawResponses.length !== 1 ? "s" : ""})
              </button>
              {showRaw && (
                <pre className="max-h-[60vh] overflow-auto border-t border-[var(--surface-border)] bg-[var(--background)] p-4 text-xs text-[var(--muted-foreground)] whitespace-pre-wrap break-all">
                  {JSON.stringify(rawResponses, null, 2)}
                </pre>
              )}
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-[var(--surface-border)] bg-[var(--surface)]">
            <div className="grid grid-cols-[minmax(120px,1fr)_0.7fr_0.5fr_0.6fr_0.6fr_0.5fr_0.5fr_0.5fr_0.5fr] items-center gap-2 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
              <div>Shipment ID</div>
              <div>Status</div>
              <div>FC</div>
              <div>Created</div>
              <div>Checked in</div>
              <div className="text-center">Sent</div>
              <div className="text-center">Received</div>
              <div className="text-center">Missing</div>
              <div className="text-center">Check-in (days)</div>
            </div>

            {loading ? (
              <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
                Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
                No shipments found. Use &quot;Sync shipments&quot; to pull from Amazon.
              </div>
            ) : (
              <>
                <div className="divide-y divide-[var(--surface-border)]">
                  {paginated.map((r) => (
                    <div
                      key={r.id}
                      className="grid grid-cols-[minmax(120px,1fr)_0.7fr_0.5fr_0.6fr_0.6fr_0.5fr_0.5fr_0.5fr_0.5fr] items-center gap-2 px-4 py-3 text-sm min-w-0"
                    >
                      <div className="truncate font-mono text-[var(--foreground)]" title={r.shipmentId}>
                        {r.shipmentId}
                      </div>
                      <div className="truncate text-[var(--foreground)]">
                        {r.transportStatus ?? r.shipmentStatus ?? "—"}
                      </div>
                      <div className="truncate text-[var(--muted-foreground)]">
                        {r.destinationFulfillmentCenterId ?? "—"}
                      </div>
                      <div className="text-[var(--foreground)]">
                        {formatDate(r.createdDate ?? r.lastUpdatedDate)}
                        {r.createdDate == null && r.lastUpdatedDate != null && (
                          <span className="ml-1 text-[10px] text-[var(--muted-foreground)]" title="Created date not provided by API; showing last updated">(updated)</span>
                        )}
                      </div>
                      <div className="text-[var(--foreground)]">
                        {(r.checkedInDate ?? r.lastUpdatedDate) != null ? (
                          <span
                            className={r.checkedInDateIsClosedDate === true ? "inline-flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-700 dark:text-amber-400" : undefined}
                            title={r.checkedInDateIsClosedDate === true ? "Closed date (shipment was already closed when synced; not the actual check-in time)" : r.checkedInDate == null ? "Last updated (checked-in date not yet recorded)" : undefined}
                          >
                            {formatDate(r.checkedInDate ?? r.lastUpdatedDate)}
                            {r.checkedInDateIsClosedDate === true && (
                              <span className="text-[10px] font-medium" aria-hidden> closed</span>
                            )}
                            {r.checkedInDate == null && r.lastUpdatedDate != null && (
                              <span className="text-[10px] text-[var(--muted-foreground)]" aria-hidden> (updated)</span>
                            )}
                          </span>
                        ) : (
                          "—"
                        )}
                      </div>
                      <div className="text-center text-[var(--foreground)] tabular-nums">
                        {r.unitsSent}
                      </div>
                      <div className="text-center text-[var(--foreground)] tabular-nums">
                        {r.unitsReceived}
                      </div>
                      <div className="text-center text-[var(--foreground)] tabular-nums">
                        {r.unitsMissing}
                      </div>
                      <div className="text-center text-[var(--foreground)] tabular-nums">
                        {r.checkInDurationDays != null ? String(r.checkInDurationDays) : "—"}
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
        </div>
      </SignedIn>
    </div>
  );
}
