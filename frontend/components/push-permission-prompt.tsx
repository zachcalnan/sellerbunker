"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
import {
  ensureWebPushSubscription,
  isIosDevice,
  isStandaloneDisplay,
} from "@/lib/web-push-subscribe";

const DISMISS_KEY = "sb_push_prompt_dismissed_v1";
const SUBSCRIBED_KEY = "sb_push_subscribed_v1";

export function PushPermissionPrompt() {
  const { isSignedIn, getToken } = useAuth();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const saveToken = useCallback(async () => {
    return getToken({ template: "backend" });
  }, [getToken]);

  // If permission is already granted, silently re-save the subscription.
  // (Previously we bailed early and never registered the device on the server.)
  useEffect(() => {
    if (!isSignedIn) return;
    if (typeof window === "undefined") return;
    if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
    if (Notification.permission !== "granted") return;
    if (isIosDevice() && !isStandaloneDisplay()) return;

    let cancelled = false;
    void (async () => {
      const result = await ensureWebPushSubscription({ getToken: saveToken });
      if (cancelled) return;
      if (result.ok) {
        localStorage.setItem(SUBSCRIBED_KEY, "1");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, saveToken]);

  useEffect(() => {
    if (!isSignedIn) return;
    if (typeof window === "undefined") return;
    if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
    if (localStorage.getItem(DISMISS_KEY) === "1") return;
    if (Notification.permission === "denied") return;

    // Already subscribed recently — don't nag.
    if (
      Notification.permission === "granted" &&
      localStorage.getItem(SUBSCRIBED_KEY) === "1"
    ) {
      return;
    }

    if (isIosDevice() && !isStandaloneDisplay()) {
      setHint(
        "On iPhone: add SellerBunker to your Home Screen, open it from the icon, then enable alerts.",
      );
      setVisible(true);
      return;
    }
    setVisible(true);
  }, [isSignedIn]);

  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISS_KEY, "1");
    setVisible(false);
  }, []);

  const enable = useCallback(async () => {
    setBusy(true);
    setHint(null);
    try {
      const result = await ensureWebPushSubscription({ getToken: saveToken });
      if (!result.ok) {
        setHint(result.reason);
        if (result.needsHomeScreen) {
          setBusy(false);
          return;
        }
        if (Notification.permission === "denied") dismiss();
        setBusy(false);
        return;
      }
      localStorage.setItem(SUBSCRIBED_KEY, "1");
      localStorage.setItem(DISMISS_KEY, "1");
      setVisible(false);
    } catch (e) {
      setHint(e instanceof Error ? e.message : "Could not enable notifications");
    } finally {
      setBusy(false);
    }
  }, [dismiss, saveToken]);

  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[80] flex justify-center p-3 sm:p-4">
      <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-4 shadow-xl">
        <p className="text-sm font-semibold text-[var(--foreground)]">
          Get alerts for sales &amp; low stock
        </p>
        <p className="mt-1 text-xs text-[var(--muted-foreground)]">
          We&apos;ll notify you when you make a sale, when an ASIN hits 1 unit left, or when a
          shipment looks delayed.
        </p>
        {hint ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{hint}</p>
        ) : null}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => void enable()}
            disabled={busy}
            className="flex-1 rounded-lg bg-white px-3 py-2 text-sm font-medium text-black disabled:opacity-60"
          >
            {busy ? "Enabling…" : "Enable"}
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="rounded-lg px-3 py-2 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
