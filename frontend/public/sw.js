/* SellerBunker web push service worker — v20 (title £ once; check icon; no sale-card) */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (_) {}
      await self.clients.claim();
    })(),
  );
});

function absoluteUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, self.location.origin).href;
  } catch (_) {
    return null;
  }
}

function stripTick(s) {
  return String(s || "").replace(/^(?:\u2705|🟢)\s*/u, "").trim();
}

async function showSaleNotification(data) {
  // Prefer green check icon. Never use sale-amount-icon / sale-card (they bake in £).
  const rawIcon = String(data.icon || "");
  const iconLooksLikeAmount =
    rawIcon.includes("sale-amount-icon") || rawIcon.includes("sale-card");
  const icon =
    (!iconLooksLikeAmount && absoluteUrl(data.icon)) ||
    absoluteUrl("/api/push/sale-check-icon?v=15") ||
    absoluteUrl("/icon-192.png");
  // Never attach sale-card image — it repeats the £ under the banner.
  const badge = absoluteUrl(data.badge) || absoluteUrl("/favicon-48x48.png");
  const profitLabel = stripTick(data.profitLabel || "");
  const amountMatch = profitLabel.match(/^(.*)\s+(profit|sale)$/i);
  const amountHero = (amountMatch?.[1] ?? profitLabel).trim();

  // Title should already be "Sold: N × product — ✅ £…". Repair older payloads
  // that still use the duplicated title/body style.
  let title = String(data.title || "SellerBunker");
  if (profitLabel && !title.includes("\u2705")) {
    const product =
      stripTick(title)
        .replace(/^Sold:\s*\d+\s*[x×]\s*/i, "")
        .replace(/^Sale\s*[·•\-–—]\s*/i, "")
        .trim() || "item";
    title = `Sold: 1 \u00d7 ${product} \u2014 \u2705 ${profitLabel}`;
  } else if (amountHero && !title.includes(amountHero) && !title.includes("\u2705")) {
    title = `Sold: 1 \u00d7 item \u2014 \u2705 ${profitLabel}`;
  }

  // Force empty body — never copy profitLabel / amount into body.
  const body = "";
  // Android notification accent (ignored on iOS). Emerald matches in-app profit.
  const color =
    typeof data.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(data.color)
      ? data.color
      : "#10B981";
  const base = {
    body,
    tag: data.tag || "sellerbunker",
    data: { url: data.url || "/orders" },
    icon,
    badge,
    color,
    renotify: true,
    requireInteraction: false,
  };

  try {
    await self.registration.showNotification(title, base);
  } catch (_) {
    await self.registration.showNotification(title, {
      body: "",
      tag: base.tag,
      data: base.data,
    });
  }

  try {
    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (const c of clients) {
      c.postMessage({
        type: "SB_SALE_PUSH",
        title,
        body: "",
        profitLabel,
        icon,
        image: null,
        url: data.url || "/orders",
      });
    }
  } catch (_) {}
}

self.addEventListener("push", (event) => {
  let data = {
    title: "SellerBunker",
    body: "",
    url: "/orders",
    tag: "sb",
    icon: "/api/push/sale-check-icon?v=15",
    image: null,
    badge: "/favicon-48x48.png",
    profitLabel: "",
  };
  try {
    if (event.data) {
      data = { ...data, ...event.data.json() };
    }
  } catch (_) {
    try {
      data.body = event.data ? event.data.text() : "";
    } catch (_) {}
  }

  event.waitUntil(showSaleNotification(data));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw =
    (event.notification.data && event.notification.data.url) || "/orders";
  const abs = absoluteUrl(raw) || raw;
  let external = false;
  try {
    const u = new URL(abs, self.location.origin);
    external = u.origin !== self.location.origin;
  } catch (_) {}

  event.waitUntil(
    (async () => {
      // Cancel-trial / supplier links: open the real site, don't navigate the PWA.
      if (external && self.clients.openWindow) {
        return self.clients.openWindow(abs);
      }
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const c of clients) {
        if ("focus" in c) {
          if (typeof c.navigate === "function") {
            try {
              await c.navigate(abs);
            } catch (_) {}
          }
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(abs);
    })(),
  );
});
