/* SellerBunker web push service worker — v10 (background sale alerts; no image prefetch) */
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

async function showSaleNotification(data) {
  const icon = absoluteUrl(data.icon) || absoluteUrl("/icon-192.png");
  const image = absoluteUrl(data.image) || null;
  const badge = absoluteUrl(data.badge) || absoluteUrl("/favicon-48x48.png");
  const profitLabel = data.profitLabel || data.body || "";
  const title = data.title || "SellerBunker";
  const base = {
    body: profitLabel || data.body || "",
    tag: data.tag || "sellerbunker",
    data: { url: data.url || "/orders" },
    icon,
    badge,
    renotify: true,
    requireInteraction: false,
  };

  // Never await network. If the OS rejects `image` (common on iOS), retry without it
  // so the alert still appears while the app is closed.
  try {
    if (image) {
      await self.registration.showNotification(title, { ...base, image });
    } else {
      await self.registration.showNotification(title, base);
    }
  } catch (_) {
    try {
      await self.registration.showNotification(title, base);
    } catch (_) {
      await self.registration.showNotification(title, {
        body: base.body,
        tag: base.tag,
        data: base.data,
      });
    }
  }

  try {
    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (const c of clients) {
      c.postMessage({
        type: "SB_SALE_PUSH",
        title: data.title,
        body: data.body,
        profitLabel,
        icon,
        image,
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
    icon: "/icon-192.png",
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
  const url =
    (event.notification.data && event.notification.data.url) || "/orders";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const c of clients) {
          if ("focus" in c) {
            c.navigate(url);
            return c.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
      }),
  );
});
