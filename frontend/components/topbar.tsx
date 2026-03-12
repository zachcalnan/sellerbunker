"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { LanguageSelector } from "./language-selector";
import { ThemeToggle } from "./theme-toggle";
import { SettingsModal } from "./settings-modal";
import { useFullscreen } from "@/contexts/fullscreen-context";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
/** When redirect URI is production, use this for sync-progress so the bar polls the backend that ran the callback. Set in .env.local for local dev. */
const SYNC_PROGRESS_API_OVERRIDE = process.env.NEXT_PUBLIC_SYNC_PROGRESS_API ?? "";
const FLASH_DISMISSED_KEY = "topbar-notification-flash-dismissed";
const COGS_ROI_DISMISSED_KEY = "topbar_cogs_roi_dismissed";
const COGS_PROFIT_DISMISSED_KEY = "topbar_cogs_profit_dismissed";
const MISSING_UNITS_DISMISSED_IDS_KEY = "topbar_missing_units_dismissed_ids";
const INITIAL_SYNC_DISMISSED_KEY = "sellerbunker_initial_sync_dismissed";
const INITIAL_SYNC_PENDING_KEY = "sellerbunker_initial_sync_pending";
const SYNC_PROGRESS_API_KEY = "sellerbunker_sync_progress_api";
/** Persisted so after disconnect/reload we still show the bar and poll for current % (backend keeps progress in DB/Redis). */
const SYNC_STARTED_AT_KEY = "sellerbunker_sync_started_at";
const SYNC_STARTED_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

function isSyncRecentlyStarted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem(SYNC_STARTED_AT_KEY);
    if (!raw) return false;
    const t = parseInt(raw, 10);
    return Number.isFinite(t) && Date.now() - t < SYNC_STARTED_MAX_AGE_MS;
  } catch {
    return false;
  }
}

type SyncStage = "core" | "fees" | "complete";

function toDateOnly(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** Format date as "4th Dec 26" (ordinal day, short month, 2-digit year). */
function formatSentDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  const day = d.getDate();
  const ord =
    day === 11 || day === 12 || day === 13
      ? "th"
      : day % 10 === 1
        ? "st"
        : day % 10 === 2
          ? "nd"
          : day % 10 === 3
            ? "rd"
            : "th";
  const month = d.toLocaleDateString(undefined, { month: "short" });
  const year = d.getFullYear().toString().slice(-2);
  return `${day}${ord} ${month} ${year}`;
}

/** True when backend says sync is in progress (core or fees). No localStorage/session/events - API is source of truth. */
function isSyncInProgress(stage: SyncStage, progress: number | null): boolean {
  if (stage !== "complete") return true;
  if (progress !== null && progress < 100) return true;
  return false;
}

export function Topbar() {
  const { isSignedIn, getToken } = useAuth();
  const { setFullscreen } = useFullscreen();
  const [missingCount, setMissingCount] = useState<number | null>(null);
  const [hovering, setHovering] = useState(false);
  const [flashingDismissed, setFlashingDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem(FLASH_DISMISSED_KEY) === "1";
  });
  const [cogsRoiDismissed, setCogsRoiDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem(COGS_ROI_DISMISSED_KEY) === "1";
  });
  const [cogsProfitDismissed, setCogsProfitDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem(COGS_PROFIT_DISMISSED_KEY) === "1";
  });
  const [missingUnitsShipments, setMissingUnitsShipments] = useState<
    Array<{ shipmentId: string; missingUnits: number; sentDate: string | null; shipmentName: string | null }>
  >([]);
  const [dismissedMissingShipmentIds, setDismissedMissingShipmentIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = sessionStorage.getItem(MISSING_UNITS_DISMISSED_IDS_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw) as unknown;
      return new Set(Array.isArray(arr) ? arr.filter((id): id is string => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  });
  const [syncProgress, setSyncProgress] = useState<number | null>(null);
  const [feeSyncProgress, setFeeSyncProgress] = useState<number | null>(null);
  const [syncStage, setSyncStage] = useState<SyncStage>("complete");
  const [syncPhase, setSyncPhase] = useState<string | null>(null);
  const [corePhaseEndPct, setCorePhaseEndPct] = useState(50);
  const [syncDismissed, setSyncDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(INITIAL_SYNC_DISMISSED_KEY) === "1";
  });
  const [hasSeenSyncInProgress, setHasSeenSyncInProgress] = useState(false);
  const [syncPendingFromSession, setSyncPendingFromSession] = useState(() => {
    if (typeof window === "undefined") return false;
    if (sessionStorage.getItem(INITIAL_SYNC_PENDING_KEY) === "1") return true;
    return isSyncRecentlyStarted();
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const syncCompleteFiredRef = useRef(false);
  const hasSeenSyncInProgressRef = useRef(false);

  // When user just connected Amazon: show bar and clear dismissed state
  useEffect(() => {
    const onJustConnected = () => {
      setSyncPendingFromSession(true);
      setSyncDismissed(false);
    };
    window.addEventListener("sellerbunker-initial-sync-pending", onJustConnected);
    return () => window.removeEventListener("sellerbunker-initial-sync-pending", onJustConnected);
  }, []);

  // Show bar only when user has started Amazon connect this session (INITIAL_SYNC_PENDING_KEY from ?amazon_connected=1)
  // or recently (isSyncRecentlyStarted) so after refresh we still show bar. Do not show before they've ever connected.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => {
      const sessionPending = sessionStorage.getItem(INITIAL_SYNC_PENDING_KEY) === "1";
      const recentStart = isSyncRecentlyStarted();
      // Only treat as "sync pending" if they have the session key (just came back from Amazon) or URL param, or a recent sync start from a previous page load after connect
      if (sessionPending || recentStart) {
        setSyncPendingFromSession(true);
        if (sessionPending) setSyncDismissed(false);
      }
      const hasJustConnectedParam = window.location.search.includes("amazon_connected=1");
      if (hasJustConnectedParam) {
        const params = new URLSearchParams(window.location.search);
        const syncApi = params.get("sync_progress_api");
        if (syncApi) {
          try {
            sessionStorage.setItem(SYNC_PROGRESS_API_KEY, syncApi);
          } catch {}
        }
      }
    };
    check();
    const t = setInterval(check, 500);
    return () => clearInterval(t);
  }, []);

  const fetchMissing = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const token = await getToken({ template: "backend" });
      if (!token) return;
      const end = toDateOnly(new Date());
      const start = toDateOnly(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));
      const res = await fetch(
        `${BASE_URL}/api/amazon/cost-of-goods/missing?` +
          new URLSearchParams({ start, end }).toString(),
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return;
      const data = (await res.json()) as { missingSkusCount?: number };
      setMissingCount(Number(data.missingSkusCount ?? 0));
    } catch {
      setMissingCount(null);
    }
  }, [isSignedIn, getToken]);

  useEffect(() => {
    if (!isSignedIn) {
      setMissingCount(null);
      return;
    }
    void fetchMissing();
  }, [isSignedIn, fetchMissing]);

  const fetchMissingUnitsSummary = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const token = await getToken({ template: "backend" });
      if (!token) return;
      const res = await fetch(`${BASE_URL}/api/amazon/shipments/missing-summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        shipments?: Array<{
          shipmentId: string;
          missingUnits: number;
          sentDate: string | null;
          shipmentName: string | null;
        }>;
      };
      setMissingUnitsShipments(Array.isArray(data.shipments) ? data.shipments : []);
    } catch {
      setMissingUnitsShipments([]);
    }
  }, [isSignedIn, getToken]);

  useEffect(() => {
    if (!isSignedIn) {
      setMissingUnitsShipments([]);
      return;
    }
    void fetchMissingUnitsSummary();
  }, [isSignedIn, fetchMissingUnitsSummary]);

  const fetchSyncProgress = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const token = await getToken({ template: "backend" });
      if (!token) {
        if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
          console.warn("[sync-progress] No token, skipping poll");
        }
        return;
      }
      // 1) Redirect may have set this (production sends sync_progress_api when redirecting to localhost)
      // 2) Local dev: if redirect URI is production, set NEXT_PUBLIC_SYNC_PROGRESS_API so we poll the right backend
      const syncProgressBase =
        (typeof window !== "undefined" && sessionStorage.getItem(SYNC_PROGRESS_API_KEY)) ||
        (SYNC_PROGRESS_API_OVERRIDE && SYNC_PROGRESS_API_OVERRIDE.trim()) ||
        BASE_URL;
      const url = `${syncProgressBase}/api/amazon/sync-progress`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
          console.warn("[sync-progress] res.notOk", res.status, res.statusText, url);
        }
        return;
      }
      const data = (await res.json()) as {
        progress?: number;
        done?: boolean;
        stage?: SyncStage;
        feeProgress?: number;
        feeDone?: boolean;
        corePhaseEndPct?: number;
        phase?: string;
      };
      const p = Number(data.progress);
      const progressNum = Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : null;
      const stage = data.stage === "core" || data.stage === "fees" || data.stage === "complete"
        ? data.stage
        : progressNum !== null && progressNum < 100
          ? "core"
          : "complete";

      // Always apply whatever progress the API returns (0, 25, 50, 75, 100) so the bar reflects reality.
      if (progressNum !== null) {
        if (progressNum < 100) {
          hasSeenSyncInProgressRef.current = true;
          setHasSeenSyncInProgress(true);
        } else {
          // So the "Sync complete" state can show (bar needs hasSeenSyncInProgress to show complete state)
          hasSeenSyncInProgressRef.current = true;
          setHasSeenSyncInProgress(true);
        }
        setSyncProgress(progressNum);
        setSyncStage(stage);
      }
      const feeP = Number(data.feeProgress);
      if (Number.isFinite(feeP)) {
        setFeeSyncProgress(Math.min(100, Math.max(0, feeP)));
      }
      const coreEnd = Number(data.corePhaseEndPct);
      if (Number.isFinite(coreEnd) && coreEnd >= 0 && coreEnd <= 100) {
        setCorePhaseEndPct(coreEnd);
      }
      if (typeof data.phase === "string" && data.phase.trim()) {
        setSyncPhase(data.phase.trim());
      }
      if (stage === "complete" && data.feeDone !== false) {
        try {
          sessionStorage.removeItem(INITIAL_SYNC_PENDING_KEY);
          sessionStorage.removeItem(SYNC_PROGRESS_API_KEY);
          localStorage.removeItem(SYNC_STARTED_AT_KEY);
        } catch {}
        setSyncPendingFromSession(false);
      }
    } catch (err) {
      // Don't overwrite state on error – keep showing the bar (e.g. 0%) until we get a successful response.
      // In dev, log so you can see CORS/network failures (often why bar stays 0% when polling production from localhost).
      if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
        console.warn("[sync-progress] fetch failed (CORS or network?)", err);
      }
    }
  }, [isSignedIn, getToken]);

  // Only probe sync-progress when we know a sync was started (returned from Amazon connect). Avoids showing the sync bar after payment / before connecting Amazon.
  useEffect(() => {
    if (!isSignedIn || !syncPendingFromSession) return;
    const probeTimer = setTimeout(() => void fetchSyncProgress(), 200);
    return () => clearTimeout(probeTimer);
  }, [isSignedIn, syncPendingFromSession, fetchSyncProgress]);

  // Only poll when we know a sync was started (just came back from Amazon connect). Stops us hitting the API for every signed-in user before they've connected.
  // Poll every 350ms so we catch 1%, 2%, 5%, 10%… during orders (job often finishes in 2–5s; DB/Redis can lag so we take max and poll often).
  useEffect(() => {
    if (!isSignedIn) {
      setSyncProgress(null);
      setFeeSyncProgress(null);
      setSyncStage("complete");
      return;
    }
    if (!syncPendingFromSession && !hasSeenSyncInProgress) return;
    void fetchSyncProgress();
    const early = setTimeout(() => void fetchSyncProgress(), 150);
    const progressInterval = setInterval(fetchSyncProgress, 350);
    return () => {
      clearTimeout(early);
      clearInterval(progressInterval);
    };
  }, [isSignedIn, syncPendingFromSession, hasSeenSyncInProgress, fetchSyncProgress]);

  const dismissSyncProgress = () => {
    try {
      localStorage.setItem(INITIAL_SYNC_DISMISSED_KEY, "1");
    } catch {}
    setSyncDismissed(true);
  };

  const hasMissing = (missingCount ?? 0) > 0;
  const visibleMissingShipments = missingUnitsShipments.filter(
    (s) => !dismissedMissingShipmentIds.has(s.shipmentId),
  );
  const hasMissingUnits = visibleMissingShipments.length > 0;
  const hasNotifications =
    hasMissing || !cogsRoiDismissed || !cogsProfitDismissed || hasMissingUnits;
  const syncInProgress = isSyncInProgress(syncStage, syncProgress);
  const feeSyncActive = syncStage === "fees";
  // Fees phase runs 75→100%. Use 75 when in fees so we never show 50% (backend sends 75; guard against stale corePhaseEndPct).
  const feeSegmentStart = 75;
  const visibleSyncProgress = feeSyncActive
    ? feeSegmentStart + ((feeSyncProgress ?? 0) / 100) * (100 - feeSegmentStart)
    : (syncProgress ?? 0);
  const noSyncDataYet = isSignedIn && syncProgress === null;
  const awaitingFirstPoll = syncPendingFromSession && syncProgress === null && syncStage === "complete";
  const syncTitle =
    noSyncDataYet || awaitingFirstPoll
      ? "Initial sync"
      : syncInProgress
        ? feeSyncActive
          ? "Initial sync (fees)"
          : "Initial sync"
        : "Sync complete";
  const progressPct = visibleSyncProgress;
  // When we have no API response yet, show indeterminate loading (bar animates)
  const barIsIndeterminate = syncProgress === null && (noSyncDataYet || awaitingFirstPoll);
  // Phase label: use backend phase when present; otherwise infer from progress so "Syncing orders" shows from the start
  const displayPhase =
    syncPhase != null && syncPhase.trim() !== ""
      ? syncPhase
      : syncProgress != null && syncProgress < 100
        ? syncProgress < 25
          ? "Syncing orders"
          : syncProgress < 50
            ? "Syncing inventory"
            : syncProgress < 75
              ? "Syncing shipments"
              : "Syncing fee estimates"
        : null;
  const syncDetail =
    displayPhase != null
      ? `${displayPhase} • ${Math.round(barIsIndeterminate ? 0 : visibleSyncProgress)}%`
      : feeSyncActive
        ? `Fees • ${Math.round(visibleSyncProgress)}%`
        : awaitingFirstPoll || noSyncDataYet
          ? "Starting • …"
          : null;
  // Show bar only when a sync was started (came back from Amazon) or we're already in progress / just completed
  const showSyncBox =
    (syncPendingFromSession || hasSeenSyncInProgress) &&
    (noSyncDataYet ||
      syncInProgress ||
      awaitingFirstPoll ||
      (syncStage === "complete" && (syncProgress ?? 100) >= 100 && hasSeenSyncInProgress && !syncDismissed));
  const syncComplete = showSyncBox && syncStage === "complete" && (syncProgress ?? 100) >= 100 && !awaitingFirstPoll && !noSyncDataYet;
  const showBackgroundSyncNote = !syncComplete && showSyncBox;
  const backgroundSyncTooltip = "Complete syncing will take place after initial sync in the background.";
  // Keep for backward compatibility if a cached bundle still references it (renders as info icon now, not this)
  const backgroundSyncNote: string | null = null;

  useEffect(() => {
    if (syncComplete && !syncCompleteFiredRef.current && typeof window !== "undefined") {
      syncCompleteFiredRef.current = true;
      window.dispatchEvent(new CustomEvent("sellerbunker-sync-complete"));
    }
  }, [syncComplete]);

  return (
    <>
    <header
      className="hidden md:flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--surface-border)] bg-[var(--surface)] px-4"
      role="banner"
    >
      <div
        id="topbar-notifications"
        className="relative flex items-center gap-2"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <style>{`
          @keyframes notification-gentle-flash {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
          }
          .notification-flash {
            animation: notification-gentle-flash 2s ease-in-out infinite;
          }
        `}</style>
        {hasNotifications && !flashingDismissed && (
          <span
            className="notification-flash inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500 ring-2 ring-amber-500/30"
            aria-hidden
          />
        )}
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
          aria-label="Notifications"
        >
          {(hasNotifications && flashingDismissed) || !hasNotifications ? (
            <span
              className={`inline-flex h-2 w-2 shrink-0 rounded-full ${hasNotifications ? "bg-amber-500" : "bg-[var(--muted-foreground)]"}`}
              aria-hidden
            />
          ) : null}
          <span className="text-sm font-medium">
            Notifications{hasNotifications ? " — Hover for details" : ""}
          </span>
        </button>
        {hasNotifications && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setFlashingDismissed(true);
              try {
                sessionStorage.setItem(FLASH_DISMISSED_KEY, "1");
              } catch {}
            }}
            className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
            aria-label="Stop notification flash"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        {hovering && (
          <div
            className="absolute left-0 top-full z-50 mt-1 min-w-[220px] rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-3 py-2.5 text-sm shadow-lg"
            role="tooltip"
          >
            {showSyncBox && (
              <div className="mb-3 border-b border-[var(--surface-border)] pb-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[var(--foreground)]">
                    {syncTitle}
                  </span>
                  {syncComplete && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); dismissSyncProgress(); }}
                      className="rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
                      aria-label="Dismiss"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <div
                    className={`h-2 min-w-0 flex-1 overflow-hidden rounded-full ${
                      syncComplete ? "bg-sb-accent/30" : "bg-sb-accent/20"
                    }`}
                  >
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        barIsIndeterminate
                          ? "bg-sb-accent/80 animate-pulse"
                          : syncComplete
                            ? "bg-sb-accent"
                            : "bg-sb-accent/80"
                      }`}
                      style={{ width: barIsIndeterminate ? "40%" : `${visibleSyncProgress}%` }}
                    />
                  </div>
                  {showBackgroundSyncNote && (
                    <span
                      className="shrink-0 inline-flex items-center text-[var(--muted-foreground)]"
                      title={backgroundSyncTooltip}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
                    </span>
                  )}
                </div>
                {syncDetail && (
                  <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{syncDetail}</p>
                )}
              </div>
            )}
            {missingCount != null ? (
              (hasMissing || !cogsRoiDismissed || !cogsProfitDismissed || hasMissingUnits) ? (
                <div className="flex flex-col gap-2">
                  {visibleMissingShipments.map((s) => (
                    <div
                      key={s.shipmentId}
                      className="flex items-start justify-between gap-2"
                    >
                      <p className="text-[var(--foreground)] text-sm">
                        You have {s.missingUnits} unit{s.missingUnits === 1 ? "" : "s"} missing
                        {s.sentDate
                          ? `, sent on ${formatSentDate(s.sentDate)}`
                          : ""}
                        .
                      </p>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const next = new Set(dismissedMissingShipmentIds);
                          next.add(s.shipmentId);
                          setDismissedMissingShipmentIds(next);
                          try {
                            sessionStorage.setItem(
                              MISSING_UNITS_DISMISSED_IDS_KEY,
                              JSON.stringify([...next]),
                            );
                          } catch {}
                        }}
                        className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
                        aria-label="Dismiss"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                  {hasMissing && (
                    <div className="flex flex-col gap-1">
                      <p className="text-[var(--foreground)]">
                        You are missing {missingCount} COGs SKU input{missingCount === 1 ? "" : "s"}.
                      </p>
                      <Link
                        href={`/cost-of-goods?${new URLSearchParams({ missing: "1" }).toString()}`}
                        className="text-sm font-medium text-[var(--foreground)] underline underline-offset-2 hover:no-underline"
                      >
                        Fix now
                      </Link>
                    </div>
                  )}
                  {!cogsRoiDismissed && (
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[var(--foreground)] text-sm">ROI not accurate until COGS filled.</p>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCogsRoiDismissed(true);
                          try { sessionStorage.setItem(COGS_ROI_DISMISSED_KEY, "1"); } catch {}
                        }}
                        className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
                        aria-label="Dismiss"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  )}
                  {!cogsProfitDismissed && (
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[var(--foreground)] text-sm">Profit not accurate until COGs filled out.</p>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCogsProfitDismissed(true);
                          try { sessionStorage.setItem(COGS_PROFIT_DISMISSED_KEY, "1"); } catch {}
                        }}
                        className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
                        aria-label="Dismiss"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-[var(--muted-foreground)]">No notifications.</p>
              )
            ) : (
              <p className="text-[var(--muted-foreground)]">Loading…</p>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => setFullscreen(true)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5 hover:text-[var(--foreground)]"
          aria-label="Full screen dashboard"
          title="Full screen (press Escape to exit)"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden
          >
            {/* Square outline with gaps at midpoints to indicate clickable */}
            <path d="M4 4h6M14 4h6M20 4v6M20 14v6M20 20h-6M10 20H4M4 20V14M4 10V4" />
          </svg>
        </button>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
            aria-label="Open settings"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden
            >
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>
          <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
          <LanguageSelector />
          <ThemeToggle />
        </div>
      </div>
    </header>
    {showSyncBox && (
      <div
        className={`flex items-center gap-3 bg-[var(--surface)] px-4 py-2.5 text-sm shadow-sm border-b-2 border-sb-accent/40`}
        role="status"
        aria-live="polite"
        aria-label={
          syncComplete
            ? "Sync complete"
            : `Initial sync, ${visibleSyncProgress}%`
        }
      >
        <div className="min-w-0 shrink-0">
          <span className="font-medium text-[var(--foreground)]">
            {syncTitle}
          </span>
          {syncDetail && (
            <p className="text-xs text-[var(--muted-foreground)]">{syncDetail}</p>
          )}
        </div>
        <div className="min-w-[140px] flex-1 max-w-[240px] h-2.5 overflow-hidden rounded-full bg-sb-accent/20">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              barIsIndeterminate
                ? "bg-sb-accent/80 animate-pulse"
                : syncComplete
                  ? "bg-sb-accent"
                  : "bg-sb-accent/80"
            }`}
            style={{ width: barIsIndeterminate ? "40%" : `${visibleSyncProgress}%` }}
          />
        </div>
        <span className="shrink-0 tabular-nums text-sm font-medium text-[var(--foreground)]">
          {Math.round(barIsIndeterminate ? 0 : visibleSyncProgress)}%
        </span>
        {showBackgroundSyncNote && (
          <span
            className="shrink-0 inline-flex items-center text-[var(--muted-foreground)]"
            title={backgroundSyncTooltip}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
          </span>
        )}
        <button
          type="button"
          onClick={dismissSyncProgress}
          className="shrink-0 rounded p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
          aria-label="Dismiss"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    )}
    </>
  );
}
