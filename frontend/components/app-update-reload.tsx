"use client";

import { useEffect } from "react";
import {
  APP_CLIENT_BUILD,
  APP_CLIENT_BUILD_KEY,
} from "@/lib/app-client-build";

/**
 * iOS Home Screen PWAs keep a stale shell after deploys. When the baked
 * build id changes, force a single full reload so nav (e.g. Purchases) appears.
 */
export function AppUpdateReload() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const prev = localStorage.getItem(APP_CLIENT_BUILD_KEY);
      if (prev !== APP_CLIENT_BUILD) {
        localStorage.setItem(APP_CLIENT_BUILD_KEY, APP_CLIENT_BUILD);
        // Reload whenever build changes, including first time this key appears
        // after an older shell without this component (session guard prevents loops).
        const guardKey = `sb_reloaded_${APP_CLIENT_BUILD}`;
        if (sessionStorage.getItem(guardKey) !== "1") {
          sessionStorage.setItem(guardKey, "1");
          if (prev != null || document.visibilityState === "visible") {
            // Always one reload for a new build id so hashed chunks refresh.
            window.location.reload();
            return;
          }
        }
      }
    } catch {
      // ignore storage errors
    }

    if (!("serviceWorker" in navigator)) return;

    void (async () => {
      try {
        const reg = await navigator.serviceWorker.register(
          `/sw.js?v=${encodeURIComponent(APP_CLIENT_BUILD)}`,
        );
        await reg.update();
      } catch {
        // optional
      }
    })();
  }, []);

  return null;
}
