"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LanguageSelector } from "./language-selector";
import { ThemeToggle } from "./theme-toggle";
import { SettingsModal } from "./settings-modal";
import { useFullscreen } from "@/contexts/fullscreen-context";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const FLASH_DISMISSED_KEY = "topbar-notification-flash-dismissed";
const INITIAL_SYNC_DISMISSED_KEY = "sellerbunker_initial_sync_dismissed";
const INITIAL_SYNC_PENDING_KEY = "sellerbunker_initial_sync_pending";

type SyncStage = "core" | "fees" | "complete";

function toDateOnly(d: Date) {
  return d.toISOString().slice(0, 10);
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
  const [syncProgress, setSyncProgress] = useState<number | null>(null);
  const [feeSyncProgress, setFeeSyncProgress] = useState<number | null>(null);
  const [syncStage, setSyncStage] = useState<SyncStage>("complete");
  const [syncDismissed, setSyncDismissed] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem(INITIAL_SYNC_DISMISSED_KEY) === "1";
  });
  const [hasSeenSyncInProgress, setHasSeenSyncInProgress] = useState(false);
  const [syncPendingFromSession, setSyncPendingFromSession] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const fetchSyncProgress = useCallback(async () => {
    if (!isSignedIn || syncDismissed) return;
    try {
      const token = await getToken({ template: "backend" });
      if (!token) return;
      const res = await fetch(`${BASE_URL}/api/amazon/sync-progress`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        progress?: number;
        done?: boolean;
        stage?: SyncStage;
        feeProgress?: number;
        feeDone?: boolean;
      };
      const p = Number(data.progress);
      if (Number.isFinite(p)) {
        const progressNum = Math.min(100, Math.max(0, p));
        setSyncProgress(progressNum);
      }
      const feeP = Number(data.feeProgress);
      if (Number.isFinite(feeP)) {
        setFeeSyncProgress(Math.min(100, Math.max(0, feeP)));
      }
      const stage = data.stage === "core" || data.stage === "fees" || data.stage === "complete"
        ? data.stage
        : Number.isFinite(p) && p < 100
          ? "core"
          : "complete";
      setSyncStage(stage);
      if (stage !== "complete") setHasSeenSyncInProgress(true);
    } catch {
      setSyncProgress(100);
      setFeeSyncProgress(100);
      setSyncStage("complete");
    }
  }, [isSignedIn, syncDismissed, getToken]);

  useEffect(() => {
    const checkPending = () => {
      try {
        if (sessionStorage.getItem(INITIAL_SYNC_PENDING_KEY) === "1") {
          setSyncPendingFromSession(true);
        }
      } catch {}
    };
    const onSyncPending = () => setSyncPendingFromSession(true);
    window.addEventListener("sellerbunker-initial-sync-pending", onSyncPending);
    if (!isSignedIn || syncDismissed) {
      setSyncProgress(null);
      setFeeSyncProgress(null);
      setSyncStage("complete");
      setSyncPendingFromSession(false);
      return () => window.removeEventListener("sellerbunker-initial-sync-pending", onSyncPending);
    }
    checkPending();
    const pendingInterval = setInterval(checkPending, 500);
    void fetchSyncProgress();
    const progressInterval = setInterval(fetchSyncProgress, 3000);
    return () => {
      window.removeEventListener("sellerbunker-initial-sync-pending", onSyncPending);
      clearInterval(pendingInterval);
      clearInterval(progressInterval);
    };
  }, [isSignedIn, syncDismissed, fetchSyncProgress]);

  const dismissSyncProgress = () => {
    try {
      localStorage.setItem(INITIAL_SYNC_DISMISSED_KEY, "1");
      sessionStorage.removeItem(INITIAL_SYNC_PENDING_KEY);
    } catch {}
    setSyncDismissed(true);
    setSyncPendingFromSession(false);
    setSyncProgress(null);
    setFeeSyncProgress(null);
    setSyncStage("complete");
  };

  const hasMissing = (missingCount ?? 0) > 0;
  const feeSyncActive = syncStage === "fees";
  const visibleSyncProgress = feeSyncActive
    ? (feeSyncProgress ?? 0)
    : (syncProgress ?? 0);
  const syncTitle = syncStage === "complete"
    ? "Sync complete"
    : feeSyncActive
      ? "Improving profit calculations…"
      : "Syncing your data…";
  const syncDetail = feeSyncActive
    ? "Orders, inventory, and shipments are ready."
    : null;
  const hasSyncActivity =
    syncPendingFromSession ||
    syncStage !== "complete" ||
    ((syncProgress !== null || feeSyncProgress !== null) && hasSeenSyncInProgress);
  const showSyncBox = hasSyncActivity && (!syncDismissed || syncPendingFromSession);
  const syncComplete = showSyncBox && syncStage === "complete";

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
        {hasMissing && !flashingDismissed && (
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
          {(hasMissing && flashingDismissed) || !hasMissing ? (
            <span
              className={`inline-flex h-2 w-2 shrink-0 rounded-full ${hasMissing ? "bg-amber-500" : "bg-[var(--muted-foreground)]"}`}
              aria-hidden
            />
          ) : null}
          <span className="text-sm font-medium">
            Notifications{hasMissing ? " — Hover for details" : ""}
          </span>
        </button>
        {hasMissing && (
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
                <div
                  className={`mt-1.5 h-2 w-full overflow-hidden rounded-full ${
                    syncComplete
                      ? "bg-emerald-500/30"
                      : feeSyncActive
                        ? "bg-sky-500/20"
                        : "bg-[var(--foreground)]/10"
                  }`}
                >
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      syncComplete
                        ? "bg-emerald-500"
                        : feeSyncActive
                          ? "bg-sky-500/80"
                          : "bg-[var(--foreground)]/40"
                    }`}
                    style={{ width: `${visibleSyncProgress}%` }}
                  />
                </div>
                {syncDetail && (
                  <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{syncDetail}</p>
                )}
                {!syncComplete && (
                  <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{visibleSyncProgress}%</p>
                )}
              </div>
            )}
            {missingCount != null ? (
              hasMissing ? (
                <div className="flex flex-col gap-2">
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
        className={`flex items-center gap-3 bg-[var(--surface)] px-4 py-2.5 text-sm shadow-sm ${
          feeSyncActive
            ? "border-b border-sky-500/35"
            : "border-b-2 border-emerald-500/60"
        }`}
        role="status"
        aria-live="polite"
        aria-label={
          syncComplete
            ? "Sync complete"
            : feeSyncActive
              ? `Improving profit calculations, ${visibleSyncProgress}%`
              : `Syncing your data, ${visibleSyncProgress}%`
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
        <div className={`min-w-[140px] flex-1 max-w-[240px] h-2.5 overflow-hidden rounded-full ${
          feeSyncActive ? "bg-sky-500/20" : "bg-[var(--foreground)]/15"
        }`}>
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              syncComplete
                ? "bg-emerald-500"
                : feeSyncActive
                  ? "bg-sky-500/80"
                  : "bg-emerald-500/80"
            }`}
            style={{ width: `${visibleSyncProgress}%` }}
          />
        </div>
        <span className="shrink-0 tabular-nums text-sm font-medium text-[var(--foreground)]">{visibleSyncProgress}%</span>
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
