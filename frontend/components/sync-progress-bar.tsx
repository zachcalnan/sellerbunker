"use client";

import { useNotifications } from "@/contexts/notifications-context";

export function SyncProgressBar() {
  const {
    showSyncBox,
    syncTitle,
    syncDetail,
    visibleSyncProgress,
    syncComplete,
    barIsIndeterminate,
    showBackgroundSyncNote,
    backgroundSyncTooltip,
    dismissSyncBar,
    triggerSyncNow,
  } = useNotifications();

  if (!showSyncBox) return null;

  return (
    <div
      className="flex items-center gap-3 border-b-2 border-sb-accent/40 bg-[var(--surface)] px-4 py-2.5 text-sm shadow-sm"
      role="status"
      aria-live="polite"
      aria-label={syncComplete ? "Sync complete" : `Initial sync, ${visibleSyncProgress}%`}
    >
      <div className="min-w-0 shrink-0">
        <span className="font-medium text-[var(--foreground)]">{syncTitle}</span>
        {syncDetail && (
          <p className="text-xs text-[var(--muted-foreground)]">{syncDetail}</p>
        )}
      </div>
      <div className="h-2.5 min-w-[140px] max-w-[240px] flex-1 overflow-hidden rounded-full bg-sb-accent/20">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            barIsIndeterminate
              ? "animate-pulse bg-sb-accent/80"
              : syncComplete
                ? "bg-sb-accent"
                : "bg-sb-accent/80"
          }`}
          style={{ width: barIsIndeterminate ? "0%" : `${visibleSyncProgress}%` }}
        />
      </div>
      <span className="shrink-0 tabular-nums text-sm font-medium text-[var(--foreground)]">
        {Math.round(barIsIndeterminate ? 0 : visibleSyncProgress)}%
      </span>
      {!barIsIndeterminate && Math.round(visibleSyncProgress) === 0 && !syncComplete && (
        <button
          type="button"
          onClick={() => void triggerSyncNow()}
          className="shrink-0 rounded-md border border-[var(--surface-border)] px-2 py-1 text-xs text-[var(--foreground)] hover:bg-[var(--foreground)]/10"
        >
          Start sync now
        </button>
      )}
      {showBackgroundSyncNote && (
        <span
          className="inline-flex shrink-0 items-center text-[var(--muted-foreground)]"
          title={backgroundSyncTooltip}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
        </span>
      )}
      <button
        type="button"
        onClick={dismissSyncBar}
        className="shrink-0 rounded p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
        aria-label="Dismiss"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
