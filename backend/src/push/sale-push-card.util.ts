import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';
import { isAllowedPushImageUrl } from './push-image.util';

const W = 420;
const H = 140;
const ICON = 192;
const THUMB = 112;
const THUMB_PAD = 14;
/** Bright sale green — matches Android `color` #10B981 and in-app toast. */
const EMERALD = { r: 0x10, g: 0xb9, b: 0x81, a: 255 };
/** Neon lime — high contrast on dark-green icon so it still reads as green. */
const LIME = { r: 0x4a, g: 0xde, b: 0x80, a: 255 };
const EMERALD_SOFT = { r: 0x34, g: 0xd3, b: 0x99, a: 255 };
const MUTED = { r: 0xa3, g: 0xa3, b: 0xa3, a: 255 };
const BG = { r: 0x0c, g: 0x0c, b: 0x0c, a: 255 };
/** Opaque dark-green icon plate — no transparent corners (iOS templates those). */
const ICON_BG = { r: 0x02, g: 0x2c, b: 0x22, a: 255 };
const THUMB_BG = { r: 0x1a, g: 0x1a, b: 0x1a, a: 255 };

/** Compact 5×7 glyphs for A–Z, a–z, 0–9, and common symbols. */
const GLYPHS: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 4, 4],
  ',': [0, 0, 0, 0, 4, 4, 8],
  ':': [0, 4, 4, 0, 4, 4, 0],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '+': [0, 4, 4, 31, 4, 4, 0],
  '£': [14, 16, 16, 28, 16, 16, 15],
  $: [4, 15, 20, 14, 5, 30, 4],
  '%': [25, 26, 2, 4, 8, 11, 19],
  '€': [14, 17, 28, 16, 28, 17, 14],
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [14, 17, 1, 6, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [14, 17, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 17, 14],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 19, 17, 17, 14],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [1, 1, 1, 1, 17, 17, 14],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [14, 17, 16, 14, 1, 17, 14],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  a: [0, 0, 14, 1, 15, 17, 15],
  b: [16, 16, 30, 17, 17, 17, 30],
  c: [0, 0, 14, 17, 16, 17, 14],
  d: [1, 1, 15, 17, 17, 17, 15],
  e: [0, 0, 14, 17, 31, 16, 14],
  f: [6, 8, 8, 28, 8, 8, 8],
  g: [0, 0, 15, 17, 15, 1, 14],
  h: [16, 16, 30, 17, 17, 17, 17],
  i: [4, 0, 12, 4, 4, 4, 14],
  j: [2, 0, 6, 2, 2, 18, 12],
  k: [16, 16, 18, 20, 24, 20, 18],
  l: [12, 4, 4, 4, 4, 4, 14],
  m: [0, 0, 26, 21, 21, 21, 21],
  n: [0, 0, 30, 17, 17, 17, 17],
  o: [0, 0, 14, 17, 17, 17, 14],
  p: [0, 0, 30, 17, 30, 16, 16],
  q: [0, 0, 15, 17, 15, 1, 1],
  r: [0, 0, 22, 25, 16, 16, 16],
  s: [0, 0, 15, 16, 14, 1, 30],
  t: [8, 8, 28, 8, 8, 8, 6],
  u: [0, 0, 17, 17, 17, 17, 15],
  v: [0, 0, 17, 17, 17, 10, 4],
  w: [0, 0, 17, 17, 21, 21, 10],
  x: [0, 0, 17, 10, 4, 10, 17],
  y: [0, 0, 17, 17, 15, 1, 14],
  z: [0, 0, 31, 2, 4, 8, 31],
  '…': [0, 0, 0, 0, 0, 21, 0],
  '?': [14, 17, 1, 2, 4, 0, 4],
};

type Rgba = { r: number; g: number; b: number; a: number };

function setPixel(
  data: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  c: Rgba,
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4;
  data[i] = c.r;
  data[i + 1] = c.g;
  data[i + 2] = c.b;
  data[i + 3] = c.a;
}

function fillRect(
  data: Buffer,
  width: number,
  height: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  c: Rgba,
  radius = 0,
): void {
  const x1 = x0 + w;
  const y1 = y0 + h;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (radius > 0) {
        const dx = x < x0 + radius ? x0 + radius - x : x >= x1 - radius ? x - (x1 - radius - 1) : 0;
        const dy = y < y0 + radius ? y0 + radius - y : y >= y1 - radius ? y - (y1 - radius - 1) : 0;
        if (dx > 0 && dy > 0 && dx * dx + dy * dy > radius * radius) continue;
      }
      setPixel(data, width, height, x, y, c);
    }
  }
}

function measureText(text: string, scale: number): number {
  let w = 0;
  for (const ch of text) {
    const rows = GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS['?'];
    w += rows ? scale * 6 : scale * 6;
  }
  return w;
}

function drawChar(
  data: Buffer,
  width: number,
  height: number,
  ch: string,
  x: number,
  y: number,
  scale: number,
  color: Rgba,
): number {
  const rows = GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS['?'];
  if (!rows) return scale * 6;
  for (let row = 0; row < 7; row++) {
    const bits = rows[row]!;
    for (let col = 0; col < 5; col++) {
      if (bits & (1 << (4 - col))) {
        fillRect(
          data,
          width,
          height,
          x + col * scale,
          y + row * scale,
          scale,
          scale,
          color,
        );
      }
    }
  }
  return scale * 6;
}

function drawText(
  data: Buffer,
  width: number,
  height: number,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: Rgba,
): void {
  let cx = x;
  for (const ch of text) {
    cx += drawChar(data, width, height, ch, cx, y, scale, color);
  }
}

function parseProfitHero(profitLabel: string): {
  hero: string;
  caption: string;
  negative: boolean;
} {
  const profit = (profitLabel || '').trim() || 'Sale';
  const split = profit.match(/^(.*)\s+(profit|sale)$/i);
  const amountText = (split?.[1] ?? profit).trim();
  const kind = (split?.[2] ?? '').toLowerCase();
  const negative = /^-|£\s*-|£-|−/.test(amountText);
  const hero = negative ? 'New sale' : amountText;
  const caption =
    !negative && kind === 'profit'
      ? 'profit'
      : !negative && kind === 'sale'
        ? 'sale'
        : '';
  return { hero, caption, negative };
}

function decodeImage(buf: Buffer): { width: number; height: number; data: Buffer } | null {
  try {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) {
      const png = PNG.sync.read(buf);
      return { width: png.width, height: png.height, data: png.data as Buffer };
    }
    // JPEG SOI
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
      const decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
      return {
        width: decoded.width,
        height: decoded.height,
        data: Buffer.from(decoded.data),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function blitCover(
  dest: Buffer,
  destW: number,
  destH: number,
  src: { width: number; height: number; data: Buffer },
  dx: number,
  dy: number,
  size: number,
): void {
  const scale = Math.max(size / src.width, size / src.height);
  const sw = Math.max(1, Math.floor(size / scale));
  const sh = Math.max(1, Math.floor(size / scale));
  const sx0 = Math.max(0, Math.floor((src.width - sw) / 2));
  const sy0 = Math.max(0, Math.floor((src.height - sh) / 2));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = sx0 + Math.min(sw - 1, Math.floor(x / scale));
      const sy = sy0 + Math.min(sh - 1, Math.floor(y / scale));
      const si = (sy * src.width + sx) * 4;
      const c: Rgba = {
        r: src.data[si] ?? 0,
        g: src.data[si + 1] ?? 0,
        b: src.data[si + 2] ?? 0,
        a: src.data[si + 3] ?? 255,
      };
      setPixel(dest, destW, destH, dx + x, dy + y, c);
    }
  }
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const png = new PNG({ width, height });
  rgba.copy(png.data);
  return PNG.sync.write(png);
}

/**
 * Small notification card: product thumb + bright green £ amount (matches app).
 * Pure JS (pngjs/jpeg-js) — no sharp/libvips (avoids Docker Fontconfig segfaults).
 */
export async function renderSalePushCard(opts: {
  imageUrl: string | null;
  profitLabel: string;
  title?: string | null;
}): Promise<Buffer | null> {
  try {
    const titleRaw = (opts.title ?? '').trim();
    const title =
      titleRaw.length > 28 ? `${titleRaw.slice(0, 25)}…` : titleRaw;
    const { hero, caption, negative } = parseProfitHero(opts.profitLabel);
    const heroColor = negative ? MUTED : LIME;

    // Opaque card plate — avoid transparent corners that some OSes template.
    const data = Buffer.alloc(W * H * 4);
    fillRect(data, W, H, 0, 0, W, H, BG, 0);
    fillRect(data, W, H, THUMB_PAD, THUMB_PAD, THUMB, THUMB, THUMB_BG, 12);

    const src = (opts.imageUrl ?? '').trim();
    if (src && isAllowedPushImageUrl(src)) {
      try {
        const upstream = await fetch(src, {
          headers: {
            'User-Agent': 'SellerBunkerPushCard/1.0',
            Accept: 'image/*',
          },
          redirect: 'follow',
        });
        if (upstream.ok) {
          const buf = Buffer.from(await upstream.arrayBuffer());
          const decoded = decodeImage(buf);
          if (decoded) {
            blitCover(data, W, H, decoded, THUMB_PAD, THUMB_PAD, THUMB);
          }
        }
      } catch {
        // Keep placeholder thumb panel.
      }
    }

    const textX = THUMB_PAD + THUMB + 18;
    // Larger scale so the £ figure dominates the card (user: "the 6.40 in green").
    const amountScale = hero.length <= 7 ? 5 : 4;

    if (title) {
      drawText(data, W, H, title, textX, 22, 2, MUTED);
      drawText(data, W, H, hero, textX, 48, amountScale, heroColor);
      if (caption) {
        drawText(data, W, H, caption, textX, 48 + amountScale * 7 + 8, 2, EMERALD_SOFT);
      }
    } else {
      drawText(data, W, H, hero, textX, 42, amountScale, heroColor);
      if (caption) {
        drawText(data, W, H, caption, textX, 42 + amountScale * 7 + 8, 2, EMERALD_SOFT);
      }
    }

    return encodePng(W, H, data);
  } catch {
    // Never throw — sharp-era segfaults taught us to fail soft.
    return null;
  }
}

/**
 * Square notification icon with a big bright-green £ amount.
 * Fully opaque dark-green plate (no transparent corners) — iOS often treats
 * transparent-corner icons as monochrome templates (white-on-dark).
 * Lock-screen *body* text still cannot be colored on Apple Web Push.
 */
export function renderSalePushAmountIcon(opts: {
  profitLabel: string;
}): Buffer | null {
  try {
    const { hero, caption, negative } = parseProfitHero(opts.profitLabel);
    const heroColor = negative ? MUTED : LIME;
    // Opaque fill first — every pixel must have alpha 255.
    const data = Buffer.alloc(ICON * ICON * 4);
    fillRect(data, ICON, ICON, 0, 0, ICON, ICON, ICON_BG, 0);
    // Inner brighter green frame so the tile reads as "green" even when tiny.
    fillRect(data, ICON, ICON, 8, 8, ICON - 16, ICON - 16, {
      r: 0x06,
      g: 0x4e,
      b: 0x3b,
      a: 255,
    }, 0);

    // Fit amount on the square — shorter figures get a bigger scale.
    let scale = hero.length <= 5 ? 7 : hero.length <= 7 ? 6 : hero.length <= 9 ? 5 : 4;
    let width = measureText(hero, scale);
    while (width > ICON - 24 && scale > 3) {
      scale -= 1;
      width = measureText(hero, scale);
    }
    const amountY = caption ? 52 : Math.floor((ICON - scale * 7) / 2);
    drawText(
      data,
      ICON,
      ICON,
      hero,
      Math.max(8, Math.floor((ICON - width) / 2)),
      amountY,
      scale,
      heroColor,
    );
    if (caption) {
      const capScale = 3;
      const capW = measureText(caption, capScale);
      drawText(
        data,
        ICON,
        ICON,
        caption,
        Math.max(8, Math.floor((ICON - capW) / 2)),
        amountY + scale * 7 + 12,
        capScale,
        LIME,
      );
    }

    return encodePng(ICON, ICON, data);
  } catch {
    return null;
  }
}
