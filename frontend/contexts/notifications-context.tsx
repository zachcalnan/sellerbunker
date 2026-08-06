"use client";

import { useAuth } from "@clerk/nextjs";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const SYNC_PROGRESS_API_OVERRIDE = process.env.NEXT_PUBLIC_SYNC_PROGRESS_API ?? "";
const FLASH_DISMISSED_KEY = "topbar-notification-flash-dismissed";
const COGS_ROI_DISMISSED_KEY = "topbar_cogs_roi_dismissed";
const COGS_PROFIT_DISMISSED_KEY = "topbar_cogs_profit_dismissed";
/** shipmentId → dismissedAt epoch ms. Survives sessions; pruned when checked in or after 7 days. */
const MISSING_UNITS_DISMISSED_MAP_KEY = "topbar_missing_units_dismissed_map_v2";
const MISSING_UNITS_DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INITIAL_SYNC_DISMISSED_KEY = "sellerbunker_initial_sync_dismissed";
const INITIAL_SYNC_PENDING_KEY = "sellerbunker_initial_sync_pending";
const SYNC_PROGRESS_API_KEY = "sellerbunker_sync_progress_api";
const SYNC_STARTED_AT_KEY = "sellerbunker_sync_started_at";
const SYNC_STARTED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type MissingShipmentDismissMap = Record<string, number>;

function loadMissingShipmentDismissMap(): MissingShipmentDismissMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(MISSING_UNITS_DISMISSED_MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: MissingShipmentDismissMap = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      const n = typeof at === "number" ? at : Number(at);
      if (typeof id === "string" && id && Number.isFinite(n) && n > 0) out[id] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function saveMissingShipmentDismissMap(map: MissingShipmentDismissMap) {
  try {
    localStorage.setItem(MISSING_UNITS_DISMISSED_MAP_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** Drop dismissals for shipments no longer missing (checked in) or older than 7 days. */
function pruneMissingShipmentDismissMap(
  map: MissingShipmentDismissMap,
  stillMissingIds: Set<string>,
  now = Date.now(),
): MissingShipmentDismissMap {
  const next: MissingShipmentDismissMap = {};
  for (const [id, at] of Object.entries(map)) {
    if (!stillMissingIds.has(id)) continue; // checked in / resolved → never re-notify from this dismiss
    if (now - at >= MISSING_UNITS_DISMISS_TTL_MS) continue; // expired → may show again
    next[id] = at;
  }
  return next;
}

type SyncStage = "core" | "fees" | "complete";

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

function toDateOnly(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function formatSentDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  const day = d.getDate();
  const ord =
    day === 11 || day === 12 || day === 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  const month = d.toLocaleDateString(undefined, { month: "short" });
  const year = d.getFullYear().toString().slice(-2);
  return `${day}${ord} ${month} ${year}`;
}

function isSyncInProgress(stage: SyncStage, progress: number | null): boolean {
  if (stage !== "complete") return true;
  if (progress !== null && progress < 100) return true;
  return false;
}

function isApiSyncDone(data: { done?: boolean; stage?: SyncStage; progress?: number }): boolean {
  if (data.done === false) return false;
  if (data.done === true) return true;
  return data.stage === "complete" && Number(data.progress) >= 100;
}

type NotificationsContextValue = {
  hasNotifications: boolean;
  flashingDismissed: boolean;
  setFlashingDismissed: (v: boolean) => void;
  missingCount: number | null;
  missingUnitsShipments: Array<{ shipmentId: string; missingUnits: number; sentDate: string | null; shipmentName: string | null }>;
  dismissMissingShipment: (shipmentId: string) => void;
  cogsTipsDismissed: boolean;
  setCogsTipsDismissed: (v: boolean) => void;
  syncProgress: number | null;
  syncStage: SyncStage;
  syncPhase: string | null;
  visibleSyncProgress: number;
  syncTitle: string;
  syncDetail: string | null;
  showSyncBox: boolean;
  syncComplete: boolean;
  barIsIndeterminate: boolean;
  showBackgroundSyncNote: boolean;
  backgroundSyncTooltip: string;
  dismissSyncProgress: () => void;
  dismissSyncBar: () => void;
  visibleMissingShipments: Array<{ shipmentId: string; missingUnits: number; sentDate: string | null; shipmentName: string | null }>;
  showSyncBoxInDropdown: boolean;
  triggerSyncNow: () => Promise<void>;
};

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationsProvider");
  return ctx;
}

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { isSignedIn, getToken } = useAuth();
  const [missingCount, setMissingCount] = useState<number | null>(null);
  const [flashingDismissed, setFlashingDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem(FLASH_DISMISSED_KEY) === "1";
  });
  const [cogsTipsDismissed, setCogsTipsDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return (
        sessionStorage.getItem(COGS_ROI_DISMISSED_KEY) === "1" &&
        sessionStorage.getItem(COGS_PROFIT_DISMISSED_KEY) === "1"
      );
    } catch {
      return false;
    }
  });
  const [missingUnitsShipments, setMissingUnitsShipments] = useState<
    Array<{ shipmentId: string; missingUnits: number; sentDate: string | null; shipmentName: string | null }>
  >([]);
  const [missingShipmentDismissMap, setMissingShipmentDismissMap] = useState<MissingShipmentDismissMap>(() =>
    loadMissingShipmentDismissMap(),
  );
  const [syncProgress, setSyncProgress] = useState<number | null>(null);
  const [syncStage, setSyncStage] = useState<SyncStage>("complete");
  const [syncPhase, setSyncPhase] = useState<string | null>(null);
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
  const hasSeenSyncInProgressRef = useRef(false);
  const syncCompleteFiredRef = useRef(false);

  useEffect(() => {
    const onJustConnected = () => {
      setSyncPendingFromSession(true);
      setSyncDismissed(false);
    };
    window.addEventListener("sellerbunker-initial-sync-pending", onJustConnected);
    return () => window.removeEventListener("sellerbunker-initial-sync-pending", onJustConnected);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => {
      const sessionPending = sessionStorage.getItem(INITIAL_SYNC_PENDING_KEY) === "1";
      const recentStart = isSyncRecentlyStarted();
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
        `${BASE_URL}/api/amazon/cost-of-goods/missing?` + new URLSearchParams({ start, end }).toString(),
        { headers: { Authorization: `Bearer ${token}` } }
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
      queueMicrotask(() => setMissingCount(null));
      return;
    }
    const t = setTimeout(() => void fetchMissing(), 0);
    return () => clearTimeout(t);
  }, [isSignedIn, fetchMissing]);

  // Once all COGS are filled, allow the tip to show again if gaps return later.
  useEffect(() => {
    if (missingCount === 0 && cogsTipsDismissed) {
      setCogsTipsDismissed(false);
      try {
        sessionStorage.removeItem(COGS_ROI_DISMISSED_KEY);
        sessionStorage.removeItem(COGS_PROFIT_DISMISSED_KEY);
      } catch {
        /* ignore */
      }
    }
  }, [missingCount, cogsTipsDismissed]);

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
      const stillMissing = new Set(
        (Array.isArray(data.shipments) ? data.shipments : []).map((s) => s.shipmentId),
      );
      setMissingShipmentDismissMap((prev) => {
        const pruned = pruneMissingShipmentDismissMap(prev, stillMissing);
        saveMissingShipmentDismissMap(pruned);
        return pruned;
      });
    } catch {
      setMissingUnitsShipments([]);
    }
  }, [isSignedIn, getToken]);

  useEffect(() => {
    if (!isSignedIn) {
      queueMicrotask(() => setMissingUnitsShipments([]));
      return;
    }
    const t = setTimeout(() => void fetchMissingUnitsSummary(), 0);
    return () => clearTimeout(t);
  }, [isSignedIn, fetchMissingUnitsSummary]);

  const fetchSyncProgress = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const token = await getToken({ template: "backend" });
      if (!token) return;
      const storedBase =
        typeof window !== "undefined" ? sessionStorage.getItem(SYNC_PROGRESS_API_KEY) : null;
      const primaryBase =
        storedBase ||
        (SYNC_PROGRESS_API_OVERRIDE && SYNC_PROGRESS_API_OVERRIDE.trim()) ||
        BASE_URL;
      const candidates = [primaryBase, BASE_URL].filter(
        (v, i, arr) => Boolean(v) && arr.indexOf(v) === i,
      );

      let data: {
        progress?: number;
        done?: boolean;
        stage?: SyncStage;
        feeProgress?: number;
        feeDone?: boolean;
        corePhaseEndPct?: number;
        phase?: string;
      } | null = null;

      for (const base of candidates) {
        try {
          const url = `${base}/api/amazon/sync-progress`;
          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) continue;
          data = (await res.json()) as {
            progress?: number;
            done?: boolean;
            stage?: SyncStage;
            feeProgress?: number;
            feeDone?: boolean;
            corePhaseEndPct?: number;
            phase?: string;
          };
          if (typeof window !== "undefined") {
            try {
              sessionStorage.setItem(SYNC_PROGRESS_API_KEY, base);
            } catch {}
          }
          break;
        } catch {
          // try next base
        }
      }
      if (!data) return;
      const p = Number(data.progress);
      const progressNum = Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : null;
      const stage =
        data.stage === "core" || data.stage === "fees" || data.stage === "complete"
          ? data.stage
          : progressNum !== null && progressNum < 100
            ? "core"
            : "complete";
      if (progressNum !== null) {
        hasSeenSyncInProgressRef.current = true;
        setHasSeenSyncInProgress(true);
        setSyncProgress(progressNum);
        setSyncStage(stage);
      }
      if (typeof data.phase === "string" && data.phase.trim()) setSyncPhase(data.phase.trim());
      else setSyncPhase(null);
      if (isApiSyncDone({ ...data, stage })) {
        try {
          sessionStorage.removeItem(INITIAL_SYNC_PENDING_KEY);
          sessionStorage.removeItem(SYNC_PROGRESS_API_KEY);
          localStorage.removeItem(SYNC_STARTED_AT_KEY);
        } catch {}
        setSyncPendingFromSession(false);
      }
    } catch {}
  }, [isSignedIn, getToken]);

  useEffect(() => {
    if (!isSignedIn || !syncPendingFromSession) return;
    const probeTimer = setTimeout(() => void fetchSyncProgress(), 200);
    return () => clearTimeout(probeTimer);
  }, [isSignedIn, syncPendingFromSession, fetchSyncProgress]);

  useEffect(() => {
    if (!isSignedIn) {
      queueMicrotask(() => {
        setSyncProgress(null);
        setSyncStage("complete");
      });
      return;
    }
    if (!syncPendingFromSession && !hasSeenSyncInProgress) return;
    const t0 = setTimeout(() => void fetchSyncProgress(), 0);
    const early = setTimeout(() => void fetchSyncProgress(), 150);
    const progressInterval = setInterval(fetchSyncProgress, 350);
    return () => {
      clearTimeout(t0);
      clearTimeout(early);
      clearInterval(progressInterval);
    };
  }, [isSignedIn, syncPendingFromSession, hasSeenSyncInProgress, fetchSyncProgress]);

  const dismissSyncBar = () => {
    try {
      localStorage.setItem(INITIAL_SYNC_DISMISSED_KEY, "1");
    } catch {}
    setSyncDismissed(true);
  };

  const triggerSyncNow = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const token = await getToken({ template: "backend" });
      if (!token) return;
      await fetch(`${BASE_URL}/api/amazon/sync?inline=1`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      try {
        sessionStorage.setItem(INITIAL_SYNC_PENDING_KEY, "1");
        localStorage.setItem(SYNC_STARTED_AT_KEY, String(Date.now()));
      } catch {}
      setSyncPendingFromSession(true);
      setSyncDismissed(false);
    } catch {
      // ignore - polling will continue
    }
  }, [isSignedIn, getToken]);

  const dismissMissingShipment = useCallback((shipmentId: string) => {
    setMissingShipmentDismissMap((prev) => {
      const next = { ...prev, [shipmentId]: Date.now() };
      saveMissingShipmentDismissMap(next);
      return next;
    });
  }, []);

  const setCogsTipsDismissedPersist = useCallback((v: boolean) => {
    setCogsTipsDismissed(v);
    if (v) {
      try {
        sessionStorage.setItem(COGS_ROI_DISMISSED_KEY, "1");
        sessionStorage.setItem(COGS_PROFIT_DISMISSED_KEY, "1");
      } catch {
        /* ignore */
      }
    }
  }, []);

  const hasMissing = (missingCount ?? 0) > 0;
  const nowMs = Date.now();
  const visibleMissingShipments = missingUnitsShipments.filter((s) => {
    const at = missingShipmentDismissMap[s.shipmentId];
    if (at == null) return true;
    return nowMs - at >= MISSING_UNITS_DISMISS_TTL_MS;
  });
  const hasMissingUnits = visibleMissingShipments.length > 0;
  const showCogsNotification = hasMissing && !cogsTipsDismissed;
  const hasNotifications = showCogsNotification || hasMissingUnits;
  const syncInProgress = isSyncInProgress(syncStage, syncProgress);
  const visibleSyncProgress = syncProgress ?? 0;
  const noSyncDataYet = isSignedIn && syncProgress === null;
  const awaitingFirstPoll = syncPendingFromSession && syncProgress === null && syncStage === "complete";
  const syncTitle =
    noSyncDataYet || awaitingFirstPoll
      ? "Syncing"
      : syncInProgress
        ? "Syncing Amazon data"
        : "Initial limited sync complete";
  const barIsIndeterminate = syncProgress === null && (noSyncDataYet || awaitingFirstPoll);
  const displayPhase =
    syncPhase != null && syncPhase.trim() !== ""
      ? syncPhase.trim()
      : syncInProgress
        ? "Working…"
        : null;
  const showSyncBox =
    (syncPendingFromSession || hasSeenSyncInProgress) &&
    (noSyncDataYet ||
      syncInProgress ||
      awaitingFirstPoll ||
      (syncStage === "complete" && (syncProgress ?? 100) >= 100 && hasSeenSyncInProgress && !syncDismissed));
  const syncComplete =
    showSyncBox &&
    syncStage === "complete" &&
    (syncProgress ?? 100) >= 100 &&
    !awaitingFirstPoll &&
    !noSyncDataYet;
  const syncDetail =
    displayPhase != null
      ? `${displayPhase} • ${Math.round(barIsIndeterminate ? 0 : visibleSyncProgress)}%`
      : awaitingFirstPoll || noSyncDataYet
        ? "Starting • …"
        : syncComplete
          ? "First-pass requirements are met; Amazon data keeps refreshing on a schedule."
          : null;
  const showBackgroundSyncNote = !syncComplete && showSyncBox && syncStage === "core";
  const backgroundSyncTooltip =
    "Full inventory, shipments, and fee estimates for your whole catalog run after this first pass.";

  useEffect(() => {
    if (syncComplete && !syncCompleteFiredRef.current && typeof window !== "undefined") {
      syncCompleteFiredRef.current = true;
      window.dispatchEvent(new CustomEvent("sellerbunker-sync-complete"));
    }
  }, [syncComplete]);

  const value: NotificationsContextValue = {
    hasNotifications,
    flashingDismissed,
    setFlashingDismissed,
    missingCount,
    missingUnitsShipments,
    dismissMissingShipment,
    cogsTipsDismissed,
    setCogsTipsDismissed: setCogsTipsDismissedPersist,
    syncProgress,
    syncStage,
    syncPhase,
    visibleSyncProgress,
    syncTitle,
    syncDetail,
    showSyncBox,
    syncComplete,
    barIsIndeterminate,
    showBackgroundSyncNote,
    backgroundSyncTooltip,
    dismissSyncProgress: dismissSyncBar,
    dismissSyncBar,
    visibleMissingShipments,
    showSyncBoxInDropdown: showSyncBox,
    triggerSyncNow,
  };

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
