/** Allowed hosts for push notification product thumbnails. */
const ALLOWED_IMAGE_HOSTS = new Set([
  'm.media-amazon.com',
  'images-na.ssl-images-amazon.com',
  'images-eu.ssl-images-amazon.com',
  'media-amazon.com',
  'www.sellerbunker.com',
  'sellerbunker.com',
]);

export function isAllowedPushImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (ALLOWED_IMAGE_HOSTS.has(host)) return true;
    // *.media-amazon.com / *.ssl-images-amazon.com
    if (host.endsWith('.media-amazon.com')) return true;
    if (host.endsWith('.ssl-images-amazon.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Prefer same-origin proxied icons — iOS/Android fetch notification icons
 * more reliably from the web app origin than from Amazon CDN.
 */
export function toPushIconUrl(
  imageUrl: string | null | undefined,
  appOrigin = 'https://www.sellerbunker.com',
): string | null {
  const raw = (imageUrl ?? '').trim();
  if (!raw) return null;
  let https = raw;
  if (https.startsWith('http://')) {
    https = `https://${https.slice('http://'.length)}`;
  }
  if (!/^https:\/\//i.test(https) || !isAllowedPushImageUrl(https)) {
    return null;
  }
  // Already our proxy
  if (https.includes('/api/push/product-image')) return https;
  const origin = appOrigin.replace(/\/$/, '');
  return `${origin}/api/push/product-image?url=${encodeURIComponent(https)}`;
}

/** Card with product thumb + emerald profit text (notification image). */
export function toSaleCardUrl(opts: {
  imageUrl?: string | null;
  profitLabel: string;
  title?: string | null;
  appOrigin?: string;
}): string {
  const origin = (opts.appOrigin ?? 'https://www.sellerbunker.com').replace(
    /\/$/,
    '',
  );
  const params = new URLSearchParams();
  params.set('profit', opts.profitLabel);
  if (opts.title?.trim()) params.set('title', opts.title.trim().slice(0, 40));
  const img = (opts.imageUrl ?? '').trim();
  if (img && isAllowedPushImageUrl(img.startsWith('http://') ? `https://${img.slice(7)}` : img)) {
    params.set('url', img.startsWith('http://') ? `https://${img.slice(7)}` : img);
  }
  return `${origin}/api/push/sale-card?${params.toString()}`;
}
