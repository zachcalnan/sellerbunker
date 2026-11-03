/** Shared helpers to register the SW and save a Web Push subscription. */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  const mq = window.matchMedia("(display-mode: standalone)").matches;
  const ios =
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
    true;
  return mq || ios;
}

export function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

export type EnsurePushResult =
  | { ok: true; endpoint: string }
  | { ok: false; reason: string; needsHomeScreen?: boolean };

/**
 * Register SW, request permission if needed, subscribe, and POST to the API.
 * Safe to call when permission is already granted (re-saves subscription).
 */
export async function ensureWebPushSubscription(args: {
  getToken: () => Promise<string | null>;
}): Promise<EnsurePushResult> {
  if (typeof window === "undefined") {
    return { ok: false, reason: "Not in a browser." };
  }
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    return { ok: false, reason: "This browser does not support push alerts." };
  }
  if (isIosDevice() && !isStandaloneDisplay()) {
    return {
      ok: false,
      reason:
        "On iPhone, open SellerBunker from your Home Screen icon first (Share → Add to Home Screen), then enable alerts.",
      needsHomeScreen: true,
    };
  }

  // Same cache-busted URL as AppUpdateReload so we don't leave a stale SW controlling.
  const { APP_CLIENT_BUILD } = await import("@/lib/app-client-build");
  const reg = await navigator.serviceWorker.register(
    `/sw.js?v=${encodeURIComponent(APP_CLIENT_BUILD)}`,
  );
  await navigator.serviceWorker.ready;
  try {
    await reg.update();
  } catch {
    /* optional */
  }

  const keyRes = await fetch(`${API_URL}/api/push/vapid-public-key`);
  const keyJson = (await keyRes.json()) as {
    publicKey?: string | null;
    configured?: boolean;
  };
  if (!keyJson.configured || !keyJson.publicKey) {
    return {
      ok: false,
      reason: "Push is not configured on the server yet. Try again later.",
    };
  }

  let permission = Notification.permission;
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }
  if (permission !== "granted") {
    return {
      ok: false,
      reason:
        permission === "denied"
          ? "Notifications are blocked for this site. Enable them in phone Settings → SellerBunker."
          : "Permission not granted.",
    };
  }

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyJson.publicKey),
    });
  }
  const json = sub.toJSON();
  const endpoint = String(json.endpoint ?? "").trim();
  const p256dh = String(json.keys?.p256dh ?? "").trim();
  const auth = String(json.keys?.auth ?? "").trim();
  if (!endpoint || !p256dh || !auth) {
    return { ok: false, reason: "Browser did not return a valid subscription." };
  }

  const token = await args.getToken();
  if (!token) {
    return { ok: false, reason: "Could not authenticate. Sign in again and retry." };
  }

  const res = await fetch(`${API_URL}/api/push/subscribe`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      endpoint,
      keys: { p256dh, auth },
      userAgent: navigator.userAgent,
    }),
  });
  if (!res.ok) {
    return { ok: false, reason: "Could not save subscription. Try again." };
  }
  return { ok: true, endpoint };
}
