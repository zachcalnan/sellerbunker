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

  const hasMissing = (missingCount ?? 0) > 0;

  return (
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
        <span className="font-semibold tracking-tight text-[var(--foreground)]">
          <span className="font-bold">SELLER</span>
          <span className="font-normal"> BUNKER</span>
        </span>
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
  );
}
