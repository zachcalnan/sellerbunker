"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNotifications, formatSentDate } from "@/contexts/notifications-context";

const FLASH_DISMISSED_KEY = "topbar-notification-flash-dismissed";

export function NotificationsDropdown({ variant = "full" }: { variant?: "full" | "iconOnly" }) {
  const [hovering, setHovering] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState({
    top: 0,
    left: 0,
    right: undefined as number | undefined,
    centered: false,
  });
  const [panelFadedIn, setPanelFadedIn] = useState(false);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const notificationsPanelRef = useRef<HTMLDivElement>(null);

  const {
    hasNotifications,
    flashingDismissed,
    setFlashingDismissed,
    missingCount,
    visibleMissingShipments,
    dismissMissingShipment,
    cogsTipsDismissed,
    setCogsTipsDismissed,
    visibleSyncProgress,
    syncTitle,
    syncDetail,
    showSyncBoxInDropdown: showSyncBox,
    syncComplete,
    barIsIndeterminate,
    showBackgroundSyncNote,
    backgroundSyncTooltip,
    dismissSyncProgress,
  } = useNotifications();

  const iconOnly = variant === "iconOnly";
  // Desktop: click only. Mobile (iconOnly): click or hover
  const showPanel = notificationsOpen || (hovering && iconOnly);

  const showCogsCard = (missingCount ?? 0) > 0 && !cogsTipsDismissed;
  const hasAlertBody =
    visibleMissingShipments.length > 0 || showCogsCard;

  useEffect(() => {
    if (!showPanel) {
      queueMicrotask(() => setPanelFadedIn(false));
      return;
    }
    const frame = requestAnimationFrame(() => setPanelFadedIn(true));
    return () => cancelAnimationFrame(frame);
  }, [showPanel]);

  // useLayoutEffect so position is set before paint — avoids layout shift on first open
  useLayoutEffect(() => {
    if (!showPanel || typeof document === "undefined") return;
    const mobileBreakpoint = 768;
    const updatePosition = () => {
      const el = notificationsRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const isMobile = typeof window !== "undefined" && window.innerWidth < mobileBreakpoint;
        if (isMobile) {
          const marginRem = 16; // 1rem
          setPanelPosition({ top: rect.bottom + 4, left: marginRem, right: marginRem, centered: false });
        } else {
          setPanelPosition({ top: 0, left: 0, right: undefined, centered: true });
        }
      }
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [showPanel]);

  // Broadcast open/close so other components (e.g. mobile nav) can react
  useEffect(() => {
    if (typeof window === "undefined") return;
    const eventName = notificationsOpen ? "sellerbunker-notifications-open" : "sellerbunker-notifications-close";
    window.dispatchEvent(new CustomEvent(eventName));
  }, [notificationsOpen]);

  // Capture-phase blocker: when panel is open, swallow all pointer events outside the panel so nothing underneath (e.g. burger) can receive them
  useEffect(() => {
    if (!showPanel) return;
    const block = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (notificationsPanelRef.current?.contains(target)) return;
      e.preventDefault();
      e.stopPropagation();
      setNotificationsOpen(false);
      setHovering(false);
    };
    const opts = { capture: true, passive: false };
    document.addEventListener("mousedown", block, opts);
    document.addEventListener("touchstart", block, opts);
    return () => {
      document.removeEventListener("mousedown", block, opts);
      document.removeEventListener("touchstart", block, opts);
    };
  }, [showPanel]);

  return (
    <div
      ref={notificationsRef}
      className="relative flex min-w-0 shrink items-center gap-2"
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
      {hasNotifications && !flashingDismissed && !iconOnly && (
        <span
          className="notification-flash hidden h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500 ring-2 ring-amber-500/30 md:inline-flex"
          aria-hidden
        />
      )}
      <button
        type="button"
        onClick={() => {
          if (notificationsOpen) {
            setNotificationsOpen(false);
            setHovering(false);
          } else {
            setNotificationsOpen(true);
          }
        }}
        className="relative flex min-w-0 shrink cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--foreground)]/5 md:px-3"
        aria-label={hasNotifications ? "Notifications — Click for details" : "Notifications"}
        aria-expanded={notificationsOpen}
      >
        {iconOnly ? (
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center" aria-hidden>
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
            {hasNotifications && !flashingDismissed && (
              <span
                className="notification-flash pointer-events-none absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-500/40 ring-2 ring-amber-500/30"
                aria-hidden
              />
            )}
          </span>
        ) : (
          <>
            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center md:hidden" aria-hidden>
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
              {hasNotifications && !flashingDismissed && (
                <span
                  className="notification-flash pointer-events-none absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-500/40 ring-2 ring-amber-500/30"
                  aria-hidden
                />
              )}
            </span>
            <span className="hidden md:flex md:items-center md:gap-2">
              {(hasNotifications && flashingDismissed) || !hasNotifications ? (
                <span
                  className={`inline-flex h-2 w-2 shrink-0 rounded-full ${hasNotifications ? "bg-amber-500" : "bg-[var(--muted-foreground)]"}`}
                  aria-hidden
                />
              ) : null}
              <span className="truncate text-sm font-medium">
                Notifications{hasNotifications ? " — Click for details" : ""}
              </span>
            </span>
          </>
        )}
      </button>
      {hasNotifications && !iconOnly && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setFlashingDismissed(true);
            try {
              sessionStorage.setItem(FLASH_DISMISSED_KEY, "1");
            } catch {}
          }}
          className="hidden cursor-pointer rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)] md:block"
          aria-label="Stop notification flash"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
      {showPanel &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            <div
              className={`fixed inset-0 z-[10000] cursor-pointer bg-[#0006] backdrop-blur-[20px] transition-opacity duration-200 ease-out ${panelFadedIn ? "opacity-100" : "opacity-0"}`}
              aria-hidden
              onClick={(e) => {
                e.stopPropagation();
                setNotificationsOpen(false);
                setHovering(false);
              }}
            />
            <div
              ref={notificationsPanelRef}
              className={`z-[10001] max-h-[min(70vh,520px)] min-w-0 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3 text-sm shadow-lg transition-opacity duration-200 ease-out md:min-w-[380px] md:max-w-[420px] md:px-5 md:py-4 ${panelFadedIn ? "opacity-100" : "opacity-0"}`}
              style={
                panelPosition.centered
                  ? {
                      position: "fixed",
                      left: "50%",
                      top: "50%",
                      transform: "translate(-50%, -50%)",
                    }
                  : {
                      position: "fixed",
                      top: panelPosition.top,
                      left: panelPosition.left,
                      ...(panelPosition.right != null && { right: panelPosition.right }),
                    }
              }
              role="dialog"
              aria-label="Notifications"
            >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-[var(--foreground)]">Notifications</h2>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setNotificationsOpen(false);
                  setHovering(false);
                }}
                className="cursor-pointer rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
                aria-label="Close"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {showSyncBox && (
              <div className="mb-3 rounded-lg border border-[var(--surface-border)] bg-[var(--background)]/40 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[var(--foreground)]">{syncTitle}</span>
                  {syncComplete && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        dismissSyncProgress();
                      }}
                      className="cursor-pointer rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
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
                    className={`h-1.5 min-w-0 flex-1 overflow-hidden rounded-full ${syncComplete ? "bg-sb-accent/30" : "bg-sb-accent/20"}`}
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
                </div>
                {syncDetail && (
                  <p className="mt-1 text-[11px] leading-snug text-[var(--muted-foreground)]">{syncDetail}</p>
                )}
              </div>
            )}

            {missingCount == null ? (
              <p className="text-[var(--muted-foreground)]">Loading…</p>
            ) : hasAlertBody || showSyncBox ? (
              <div className="flex flex-col gap-2.5">
                {visibleMissingShipments.map((s) => (
                  <div
                    key={s.shipmentId}
                    className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                          Late / missing shipment
                        </p>
                        <p className="mt-1 text-sm text-[var(--foreground)]">
                          <span className="font-semibold tabular-nums">{s.missingUnits}</span>
                          {" unit"}
                          {s.missingUnits === 1 ? "" : "s"}
                          {" not received"}
                          {s.sentDate ? (
                            <span className="text-[var(--muted-foreground)]">
                              {" · sent "}
                              {formatSentDate(s.sentDate)}
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--muted-foreground)]">
                          {s.shipmentName || s.shipmentId}
                        </p>
                        <Link
                          href="/shipments"
                          className="mt-2 inline-block text-xs font-medium text-[var(--foreground)] underline underline-offset-2 hover:no-underline"
                          onClick={() => {
                            setNotificationsOpen(false);
                            setHovering(false);
                          }}
                        >
                          View shipments
                        </Link>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          dismissMissingShipment(s.shipmentId);
                        }}
                        className="shrink-0 cursor-pointer rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
                        aria-label="Dismiss for one week"
                        title="Hide for 1 week (won’t return if checked in)"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}

                {showCogsCard && (
                  <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)]/40 px-3 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                          Cost of goods
                        </p>
                        <p className="mt-1 text-sm text-[var(--foreground)]">
                          Missing{" "}
                          <span className="font-semibold tabular-nums">{missingCount}</span>
                          {" SKU"}
                          {missingCount === 1 ? "" : "s"}
                          {" — profit and ROI won’t be accurate until filled."}
                        </p>
                        <Link
                          href={`/cost-of-goods?${new URLSearchParams({ missing: "1" }).toString()}`}
                          className="mt-2 inline-block text-xs font-medium text-[var(--foreground)] underline underline-offset-2 hover:no-underline"
                          onClick={() => {
                            setNotificationsOpen(false);
                            setHovering(false);
                          }}
                        >
                          Fix now
                        </Link>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCogsTipsDismissed(true);
                        }}
                        className="shrink-0 cursor-pointer rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
                        aria-label="Dismiss"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[var(--muted-foreground)]">No notifications.</p>
            )}
          </div>
          </>,
          document.body
        )}
    </div>
  );
}
