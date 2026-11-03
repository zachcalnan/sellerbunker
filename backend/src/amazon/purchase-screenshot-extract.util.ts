/**
 * Normalize vision-model JSON into a purchase-ingest draft.
 * Keeps parsing deterministic so unit tests do not call OpenAI.
 */

export type ExtractedPurchaseLine = {
  productTitle?: string;
  asin?: string;
  sku?: string;
  qty: number;
  unitRrpIncVat?: number;
  unitCostIncVat?: number;
  lineTotalIncVat?: number;
  deliveryCostIncVat?: number;
  prepCostIncVat?: number;
  /** Top listing matches from the seller's catalog (UI only; stripped before ingest). */
  listingCandidates?: Array<{
    asin: string;
    sku: string;
    title: string;
    score: number;
  }>;
};

export type ExtractedPurchaseDraft = {
  supplier: string;
  orderNumber: string;
  purchaseDate: string;
  currency: string;
  vatRatePct: number;
  fulfilment: string;
  /** Sheet Home/Prep: HOME vs PREP CENTER */
  shipDestination?: 'HOME' | 'PREP CENTER';
  supplierLink?: string;
  promo?: { type: 'none' | 'buy_3_get_1_free' };
  lines: ExtractedPurchaseLine[];
  warnings: string[];
  rawModelText?: string;
};

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t || undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v
      .replace(/£/g, '')
      .replace(/,/g, '')
      .replace(/[^\d.-]/g, '')
      .trim();
    if (!cleaned) return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asInt(v: unknown, fallback = 1): number {
  const n = asNumber(v);
  if (n === undefined) return fallback;
  return Math.max(1, Math.floor(n));
}

/**
 * Pull leading qty from titles like "10x Otamatone Classic White" / "10 × Product".
 * Returns cleaned title and qty when found.
 */
export function splitQtyPrefixFromTitle(
  title: string | undefined | null,
): { title?: string; qty?: number } {
  const raw = (title ?? '').trim();
  if (!raw) return {};
  const m =
    /^(\d{1,4})\s*[x×]\s+(.+)$/i.exec(raw) ??
    /^qty\s*[:=]?\s*(\d{1,4})\s+(.+)$/i.exec(raw);
  if (!m) return { title: raw };
  const qty = Math.max(1, Math.floor(Number(m[1])));
  const rest = m[2].trim();
  return { title: rest || raw, qty: Number.isFinite(qty) ? qty : undefined };
}

/**
 * Qty from strings like "Landmark (8 items)", "8 items", "Items: 8".
 */
export function parseItemCountHint(
  ...chunks: Array<string | number | null | undefined>
): number | undefined {
  for (const raw of chunks) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) {
      return Math.floor(raw);
    }
    const s = asString(raw);
    if (!s) continue;
    const m =
      /\((\d{1,4})\s*items?\)/i.exec(s) ??
      /\b(\d{1,4})\s*items?\b/i.exec(s) ??
      /items?\s*[:=]?\s*(\d{1,4})\b/i.exec(s);
    if (m) {
      const n = Math.floor(Number(m[1]));
      if (n >= 1) return n;
    }
  }
  return undefined;
}

/** Map vision / UI values onto purchase-sheet Home/Prep labels. */
export function parseShipDestination(
  raw: unknown,
  shippingAddressHint?: unknown,
): 'HOME' | 'PREP CENTER' | undefined {
  const chunks = [raw, shippingAddressHint]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!chunks) return undefined;

  if (
    /prep\s*cent(er|re)|blue\s*30|blue30|stambridge|fulfilment\s*cent|fulfillment\s*cent|\bep\s*cent|\brep\s*cent|\bfc\b|amazon\s*fc/.test(
      chunks,
    )
  ) {
    return 'PREP CENTER';
  }
  if (/\bhome\b|house|residential|personal\s*address/.test(chunks)) {
    return 'HOME';
  }
  if (raw != null && String(raw).trim()) {
    const s = String(raw).trim().toUpperCase().replace(/_/g, ' ');
    if (s === 'HOME') return 'HOME';
    if (s === 'PREP CENTER' || s === 'PREP CENTRE') return 'PREP CENTER';
  }
  return undefined;
}
const MONTH_NAME_TO_NUM: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function ymd(y: number, m: number, d: number): string | undefined {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) {
    return undefined;
  }
  // Reject impossible days lightly (Feb 31 etc.) via Date.UTC round-trip.
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return undefined;
  }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Accept ISO, YYYY-MM-DD, UK D/M/YYYY, and written dates like
 * "8 September 2026" / "Sep 8, 2026".
 * Returns undefined when the value cannot be parsed (caller may default).
 */
export function tryParsePurchaseDate(raw: unknown): string | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Excel serial day (unlikely from vision, but harmless).
    const excelEpoch = Date.UTC(1899, 11, 30);
    const d = new Date(excelEpoch + raw * 86400000);
    if (!Number.isNaN(d.getTime())) {
      return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
  }

  const s = asString(raw);
  if (!s) return undefined;

  const isoDay = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (isoDay) {
    return ymd(Number(isoDay[1]), Number(isoDay[2]), Number(isoDay[3]));
  }

  // UK numeric: D/M/YYYY or D-M-YYYY (Healf / UK retailers).
  const uk = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (uk) {
    const d = Number(uk[1]);
    const m = Number(uk[2]);
    let y = Number(uk[3]);
    if (y < 100) y += 2000;
    const parsed = ymd(y, m, d);
    if (parsed) return parsed;
  }

  // "8 September 2026" / "8th Sept 2026"
  const dMonthY =
    /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/.exec(s);
  if (dMonthY) {
    const m = MONTH_NAME_TO_NUM[dMonthY[2].toLowerCase()];
    if (m) {
      const parsed = ymd(Number(dMonthY[3]), m, Number(dMonthY[1]));
      if (parsed) return parsed;
    }
  }

  // "September 8, 2026" / "Sep 8 2026"
  const monthDY =
    /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (monthDY) {
    const m = MONTH_NAME_TO_NUM[monthDY[1].toLowerCase()];
    if (m) {
      const parsed = ymd(Number(monthDY[3]), m, Number(monthDY[2]));
      if (parsed) return parsed;
    }
  }

  // Last resort: Date.parse, then take UTC calendar day (ISO-ish inputs).
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return ymd(
      parsed.getUTCFullYear(),
      parsed.getUTCMonth() + 1,
      parsed.getUTCDate(),
    );
  }
  return undefined;
}

/** Accept ISO, YYYY-MM-DD, UK D/M/YYYY, or written month names. */
export function normalizePurchaseDate(raw: unknown, now = new Date()): string {
  return (
    tryParsePurchaseDate(raw) ??
    ymd(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()) ??
    now.toISOString().slice(0, 10)
  );
}

export function normalizeAsin(raw: unknown): string | undefined {
  const s = asString(raw)?.toUpperCase().replace(/\s/g, '');
  if (!s) return undefined;
  // Amazon ASINs are typically 10 alphanumeric chars.
  if (/^[A-Z0-9]{10}$/.test(s)) return s;
  const embedded = s.match(/B0[A-Z0-9]{8}/);
  return embedded?.[0];
}

export function stripJsonFence(text: string): string {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(t);
  return fenced ? fenced[1].trim() : t;
}

export function parseVisionPurchaseJson(
  text: string,
  now = new Date(),
): ExtractedPurchaseDraft {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch {
    throw new Error('Model returned non-JSON output');
  }

  const root = asObject(parsed);
  if (!root) throw new Error('Model JSON root must be an object');

  const supplier = asString(root.supplier) ?? 'Unknown supplier';
  let orderNumber =
    asString(root.orderNumber) ??
    asString(root.order_number) ??
    asString(root.orderId) ??
    asString(root.order_id) ??
    asString(root.confirmationNumber);
  if (!orderNumber) {
    // Thomann / some retailers only show "Order placed successfully" without an ID
    // on the success screen — still extract lines/totals and let the user fill ID.
    const day =
      ymd(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()) ??
      now.toISOString().slice(0, 10);
    orderNumber = `PENDING-${day.replace(/-/g, '')}`;
    warnings.push(
      'Order number not visible on screenshot — placeholder set; replace with the real order ID before confirm.',
    );
  }

  const currency = (asString(root.currency) ?? 'GBP').toUpperCase();
  const vatRatePct = Math.max(0, asNumber(root.vatRatePct) ?? 0);
  const fulfilment = asString(root.fulfilment) ?? 'FBA';
  const supplierLink = asString(root.supplierLink);

  let promoType: 'none' | 'buy_3_get_1_free' = 'none';
  const promoObj = asObject(root.promo);
  const promoRaw =
    asString(promoObj?.type) ??
    asString(root.promoType) ??
    asString(root.promo);
  if (
    promoRaw === 'buy_3_get_1_free' ||
    /4[\s-]*for[\s-]*3|buy\s*3\s*get\s*1/i.test(promoRaw ?? '')
  ) {
    promoType = 'buy_3_get_1_free';
  }

  const linesRaw = Array.isArray(root.lines) ? root.lines : [];
  const lines: ExtractedPurchaseLine[] = [];
  for (const row of linesRaw) {
    const o = asObject(row);
    if (!o) continue;
    const titleRaw = asString(o.productTitle ?? o.title ?? o.product);
    const split = splitQtyPrefixFromTitle(titleRaw);
    let qty = asInt(o.qty ?? o.quantity ?? o.units, 0);
    // Prefer "10x Title" over a default/misread qty of 1.
    if (split.qty && split.qty > 1 && (qty <= 0 || qty === 1)) {
      qty = split.qty;
    }
    if (qty <= 0) qty = 1;
    let unitCostIncVat = asNumber(o.unitCostIncVat ?? o.unitCost ?? o.unit_price);
    const unitRrpIncVat = asNumber(o.unitRrpIncVat ?? o.rrp ?? o.listPrice);
    let lineTotalIncVat = asNumber(
      o.lineTotalIncVat ?? o.lineTotal ?? o.total ?? o.orderCost,
    );
    if (
      (unitCostIncVat === undefined || unitCostIncVat <= 0) &&
      lineTotalIncVat != null &&
      lineTotalIncVat > 0
    ) {
      unitCostIncVat = Number((lineTotalIncVat / qty).toFixed(2));
    } else if (
      lineTotalIncVat != null &&
      lineTotalIncVat > 0 &&
      qty > 1 &&
      unitCostIncVat != null &&
      Math.abs(unitCostIncVat - lineTotalIncVat) < 0.01
    ) {
      // unitCost was wrongly set to the line total; derive per-unit.
      unitCostIncVat = Number((lineTotalIncVat / qty).toFixed(2));
    } else if (
      lineTotalIncVat == null &&
      unitCostIncVat != null &&
      unitCostIncVat > 0 &&
      qty > 1 &&
      // Huge "unit" that looks like a line total for multi-qty titles.
      split.qty &&
      split.qty > 1 &&
      unitCostIncVat > 50
    ) {
      lineTotalIncVat = unitCostIncVat;
      unitCostIncVat = Number((lineTotalIncVat / qty).toFixed(2));
    }
    lines.push({
      productTitle: split.title ?? titleRaw,
      asin: normalizeAsin(o.asin),
      sku: asString(o.sku ?? o.articleId ?? o.articleNumber ?? o.supplierSku),
      qty,
      unitRrpIncVat,
      unitCostIncVat,
      lineTotalIncVat,
      deliveryCostIncVat: asNumber(o.deliveryCostIncVat ?? o.shipping),
      prepCostIncVat: asNumber(o.prepCostIncVat ?? o.prep),
    });
  }

  const orderTotalIncVat = asNumber(
    root.orderTotalIncVat ??
      root.orderTotal ??
      root.totalPaid ??
      root.total ??
      root.grandTotal,
  );
  const originalTotalIncVat = asNumber(
    root.originalTotalIncVat ??
      root.originalTotal ??
      root.subtotalBeforeDiscount ??
      root.rrpTotal,
  );
  const shippingMethod = asString(
    root.shippingMethod ?? root.shipping_method ?? root.deliveryMethod,
  );
  const itemCountHint = parseItemCountHint(
    root.itemCount as string | number | null | undefined,
    root.items as string | number | null | undefined,
    root.item_count as string | number | null | undefined,
    root.quantity as string | number | null | undefined,
    shippingMethod,
    asString(root.shippingAddress),
  );

  // If lines exist but qty is still 1 while itemCount says otherwise, fix single-line carts.
  if (lines.length === 1 && itemCountHint && itemCountHint > 1) {
    const line = lines[0];
    if (line.qty <= 1) {
      line.qty = itemCountHint;
      if (line.lineTotalIncVat != null && line.lineTotalIncVat > 0) {
        line.unitCostIncVat = Number(
          (line.lineTotalIncVat / line.qty).toFixed(2),
        );
      } else if (orderTotalIncVat != null && orderTotalIncVat > 0) {
        line.lineTotalIncVat = orderTotalIncVat;
        line.unitCostIncVat = Number((orderTotalIncVat / line.qty).toFixed(2));
      }
    }
  }

  // Order-summary-only screenshots: no SKU rows, but totals / item count visible.
  if (
    lines.length === 0 ||
    lines.every(
      (l) =>
        !l.productTitle &&
        (l.unitCostIncVat == null || l.unitCostIncVat <= 0) &&
        (l.lineTotalIncVat == null || l.lineTotalIncVat <= 0),
    )
  ) {
    if (orderTotalIncVat != null && orderTotalIncVat > 0) {
      let qty = asInt(root.qty ?? root.quantity ?? root.units, 0);
      let inferredPromo: 'none' | 'buy_3_get_1_free' = promoType;
      let unitRrpIncVat: number | undefined;
      let unitCostIncVat: number | undefined;
      const titleHint = asString(
        root.productTitle ?? root.title ?? root.product,
      );
      const split = splitQtyPrefixFromTitle(titleHint);

      // £379.96 → £284.97 is classic 4×RRP → 3×RRP (4-for-3).
      if (
        originalTotalIncVat != null &&
        originalTotalIncVat > orderTotalIncVat &&
        Math.abs(orderTotalIncVat / originalTotalIncVat - 0.75) < 0.02
      ) {
        inferredPromo = 'buy_3_get_1_free';
        qty = qty > 0 ? qty : 4;
        unitRrpIncVat = Number((originalTotalIncVat / qty).toFixed(2));
        unitCostIncVat = Number((orderTotalIncVat / qty).toFixed(2));
        warnings.push(
          'Inferred 4-for-3 from order summary strikethrough totals (paid ≈ 75% of original).',
        );
      } else {
        // Prefer qty from "8 items" / itemCount / title prefix over defaulting to 1.
        qty =
          qty > 0
            ? qty
            : split.qty && split.qty > 0
              ? split.qty
              : itemCountHint && itemCountHint > 0
                ? itemCountHint
                : 1;
        unitCostIncVat = Number((orderTotalIncVat / qty).toFixed(2));
        if (originalTotalIncVat != null && originalTotalIncVat > 0) {
          unitRrpIncVat = Number((originalTotalIncVat / qty).toFixed(2));
        }
        warnings.push(
          'Product rows not visible — used Order summary totals. Check qty/title/ASIN before submit.',
        );
      }

      promoType = inferredPromo;
      lines.length = 0;
      lines.push({
        productTitle: split.title ?? titleHint,
        asin: normalizeAsin(root.asin),
        sku: asString(root.sku),
        qty,
        unitRrpIncVat,
        unitCostIncVat,
        lineTotalIncVat: orderTotalIncVat,
        deliveryCostIncVat: asNumber(root.deliveryCostIncVat ?? root.shipping),
      });
    } else if (lines.length === 0) {
      // Fall back to single empty-ish line from top-level fields.
      const titleHint = asString(
        root.productTitle ?? root.title ?? root.product,
      );
      const split = splitQtyPrefixFromTitle(titleHint);
      let qty = asInt(root.qty ?? root.quantity ?? root.units, 0);
      if (qty <= 0 && split.qty) qty = split.qty;
      if (qty <= 0) qty = 1;
      const lineTotalIncVat = asNumber(
        root.lineTotalIncVat ?? root.orderTotal ?? root.total,
      );
      const unitCostIncVat =
        asNumber(root.unitCostIncVat) ??
        (lineTotalIncVat != null
          ? Number((lineTotalIncVat / qty).toFixed(2))
          : undefined);
      lines.push({
        productTitle: split.title ?? titleHint,
        asin: normalizeAsin(root.asin),
        sku: asString(root.sku),
        qty,
        unitRrpIncVat: asNumber(root.unitRrpIncVat ?? root.rrp),
        unitCostIncVat,
        lineTotalIncVat,
        deliveryCostIncVat: asNumber(root.deliveryCostIncVat ?? root.shipping),
      });
    }
  }

  if (Array.isArray(root.warnings)) {
    for (const w of root.warnings) {
      const s = asString(w);
      if (s) warnings.push(s);
    }
  }

  // Drop unhelpful model warning once we've recovered totals.
  const filteredWarnings = warnings.filter((w) => {
    if (/no product lines found/i.test(w) && lines.some((l) => (l.unitCostIncVat ?? 0) > 0)) {
      return false;
    }
    return true;
  });
  warnings.length = 0;
  warnings.push(...filteredWarnings);

  for (const line of lines) {
    if (!line.asin) {
      warnings.push(
        `ASIN missing for "${line.productTitle ?? 'line'}" — fill it in before submit.`,
      );
    }
    if (
      (line.unitCostIncVat == null || line.unitCostIncVat <= 0) &&
      (line.unitRrpIncVat == null || line.unitRrpIncVat <= 0)
    ) {
      warnings.push(
        `Unit cost missing for "${line.productTitle ?? 'line'}" — fill it in before submit.`,
      );
    }
  }

  // Heuristic: qty 4 with RRP and paid ~75% → 4-for-3.
  for (const line of lines) {
    if (
      promoType === 'none' &&
      line.qty === 4 &&
      line.unitRrpIncVat &&
      line.unitCostIncVat &&
      Math.abs(line.unitCostIncVat - (line.unitRrpIncVat * 3) / 4) < 0.05
    ) {
      promoType = 'buy_3_get_1_free';
      warnings.push('Detected likely 4-for-3 pricing; promo set to buy_3_get_1_free.');
    }
  }

  // Also from order-level strikethrough totals when lines already exist but lack cost.
  if (
    promoType === 'none' &&
    orderTotalIncVat != null &&
    originalTotalIncVat != null &&
    originalTotalIncVat > orderTotalIncVat &&
    Math.abs(orderTotalIncVat / originalTotalIncVat - 0.75) < 0.02
  ) {
    promoType = 'buy_3_get_1_free';
  }

  for (const line of lines) {
    if (
      (line.unitCostIncVat == null || line.unitCostIncVat <= 0) &&
      orderTotalIncVat != null &&
      orderTotalIncVat > 0
    ) {
      line.lineTotalIncVat = line.lineTotalIncVat ?? orderTotalIncVat;
      line.unitCostIncVat = Number((orderTotalIncVat / line.qty).toFixed(2));
    }
    if (
      (line.unitRrpIncVat == null || line.unitRrpIncVat <= 0) &&
      originalTotalIncVat != null &&
      originalTotalIncVat > 0
    ) {
      line.unitRrpIncVat = Number((originalTotalIncVat / line.qty).toFixed(2));
    }
  }

  const rawDate =
    root.purchaseDate ??
    root.orderDate ??
    root.order_date ??
    root.date ??
    root.placedAt ??
    root.placed_at ??
    root.confirmationDate;
  const parsedDate = tryParsePurchaseDate(rawDate);
  if (!parsedDate) {
    warnings.push(
      'Purchase date not found in screenshot — set the correct date before confirm (defaulted to today).',
    );
  }

  const shipDestination = parseShipDestination(
    root.shipDestination ?? root.shipTo ?? root.destination ?? root.homePrep,
    root.shippingAddress ??
      root.shipping_address ??
      root.deliveryAddress ??
      root.shipToAddress,
  );
  if (!shipDestination) {
    warnings.push(
      'Ship-to not clear (HOME vs PREP CENTER) — pick Home/Prep before confirm.',
    );
  }

  return {
    supplier,
    orderNumber,
    purchaseDate: parsedDate ?? normalizePurchaseDate(undefined, now),
    currency,
    vatRatePct,
    fulfilment,
    shipDestination,
    supplierLink,
    promo: { type: promoType },
    lines,
    warnings,
    rawModelText: text,
  };
}

export const PURCHASE_SCREENSHOT_SYSTEM_PROMPT = `You extract supplier purchase-order details from a screenshot for an Amazon seller COGS ledger.
Return ONLY a JSON object (no markdown) with this shape:
{
  "supplier": string,
  "orderNumber": string | null,
  "purchaseDate": "YYYY-MM-DD" | null,
  "currency": "GBP",
  "orderTotalIncVat": number | null,
  "originalTotalIncVat": number | null,
  "itemCount": number | null,
  "shippingMethod": string | null,
  "promo": { "type": "none" | "buy_3_get_1_free" },
  "shipDestination": "HOME" | "PREP CENTER" | null,
  "shippingAddress": string | null,
  "supplierLink": string | null,
  "lines": [{
    "productTitle": string | null,
    "asin": string | null,
    "sku": string | null,
    "qty": number | null,
    "unitRrpIncVat": number | null,
    "unitCostIncVat": number | null,
    "lineTotalIncVat": number | null,
    "deliveryCostIncVat": number | null,
    "prepCostIncVat": number | null
  }],
  "warnings": string[]
}
Rules:
- Works for ANY retailer (iHerb, Healf, Thomann, Amazon, Shopify, etc.). Read logo/domain/app chrome (e.g. "Search iHerb" → supplier "iHerb").
- Mobile confirmation pages often show ONLY a product thumbnail + qty badge (e.g. "8") and NO text line-item rows. You MUST still fill lines[]:
  1) Read brand/product text visible ON the bottle/packaging in the thumbnail (e.g. "PURA D'OR Anti-Thinning Biotin Shampoo").
  2) Qty from the badge on the thumbnail, OR from shipping text like "Landmark (8 items)" / "8 items" → set itemCount and lines[].qty.
  3) lineTotalIncVat = order total when there is a single product; unitCostIncVat = total / qty.
- Always capture order totals and order numbers (#556284648, H-1234567, etc.).
- orderTotalIncVat = amount paid. originalTotalIncVat = pre-discount when shown. FREE shipping → deliveryCostIncVat 0.
- If the user message includes "Your Amazon listings", pick the CLOSEST listing by title/brand and set asin (+ sku when given). Prefer a real match over leaving asin null. If unsure between several, still set productTitle from the image and put the best asin.
- Parse "10x Product" / "10 × Product" into qty + title without the prefix.
- Money is GBP (£) unless clearly otherwise. Numbers only in JSON.
- promo.type = buy_3_get_1_free only when paid ≈ 75% of original (Healf-style); else "none".
- purchaseDate: Order date / Placed on / written dates. Delivery windows like "SEP 15 – SEP 17" are NOT the purchase date — set purchaseDate null if only a delivery window is shown.
- shipDestination: PREP CENTER for Blue30 / Stambridge / prep centres; HOME for personal addresses. Always copy shippingAddress when visible.
- Do not invent order numbers or purchase dates. DO extract productTitle from packaging text even if OCR is imperfect.`;
