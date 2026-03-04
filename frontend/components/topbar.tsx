"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LanguageSelector } from "./language-selector";
import { ThemeToggle } from "./theme-toggle";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

function toDateOnly(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function Topbar() {
  const { isSignedIn, getToken } = useAuth();
  const [missingCount, setMissingCount] = useState<number | null>(null);
  const [hovering, setHovering] = useState(false);

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
        className="relative flex items-center"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
          aria-label="Notifications"
        >
          <span
            className={`inline-flex h-2 w-2 shrink-0 rounded-full ${hasMissing ? "bg-amber-500" : "bg-[var(--muted-foreground)]"}`}
            aria-hidden
          />
          Notifications
        </button>
        {hovering && (
          <div
            className="absolute left-0 top-full z-50 mt-1 min-w-[220px] rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-3 py-2.5 text-sm shadow-lg"
            role="tooltip"
          >
            {missingCount != null ? (
              hasMissing ? (
                <div className="flex flex-col gap-2">
                  <p className="text-[var(--foreground)]">
                    You are missing {missingCount} amount of SKU{missingCount === 1 ? "" : "s"}.
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
        <div className="flex items-center gap-3">
          <Link
            href="/settings"
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
          </Link>
          <LanguageSelector />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
