/**
 * Lightweight Catalog Items API (2022-04-01) parsers for title + main image.
 * Shared by purchase ASIN lookup (and mirrors backfillProductTitles logic).
 */

function unwrapCatalogPayload(input: unknown): Record<string, unknown> {
  let cur: unknown = input;
  for (let i = 0; i < 5; i += 1) {
    if (cur && typeof cur === 'object') {
      const obj = cur as Record<string, unknown>;
      if (obj.payload != null) {
        cur = obj.payload;
        continue;
      }
      if (obj.Payload != null) {
        cur = obj.Payload;
        continue;
      }
    }
    break;
  }
  return cur && typeof cur === 'object'
    ? (cur as Record<string, unknown>)
    : {};
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function parseCatalogItemTitle(
  payloadRaw: unknown,
  marketplaceId: string,
): string | null {
  const payload = unwrapCatalogPayload(payloadRaw);
  const summaries = payload.summaries ?? payload.Summaries;
  const summaryList: unknown[] = Array.isArray(summaries) ? summaries : [];

  const pickSummaryName = (s: unknown): string | null => {
    if (!s || typeof s !== 'object') return null;
    const o = s as Record<string, unknown>;
    return (
      asNonEmptyString(o.itemName) ??
      asNonEmptyString(o.ItemName) ??
      asNonEmptyString(o.item_name)
    );
  };

  const matchingSummary =
    summaryList.find((s) => {
      if (!s || typeof s !== 'object') return false;
      const o = s as Record<string, unknown>;
      const mid = o.marketplaceId ?? o.marketplace_id;
      return mid === marketplaceId;
    }) ?? summaryList[0];
  const fromSummary = pickSummaryName(matchingSummary);
  if (fromSummary) return fromSummary;

  const attrs = payload.attributes ?? payload.Attributes;
  if (!attrs || typeof attrs !== 'object') return null;
  const attrObj = attrs as Record<string, unknown>;
  const candidates =
    attrObj.item_name ??
    attrObj.itemName ??
    attrObj.title ??
    attrObj.Title ??
    null;
  const list = Array.isArray(candidates) ? candidates : [candidates];
  const matching =
    list.find((c) => {
      if (!c || typeof c !== 'object') return false;
      const o = c as Record<string, unknown>;
      return (
        (o.marketplace_id ?? o.marketplaceId) === marketplaceId
      );
    }) ?? list[0];
  if (!matching || typeof matching !== 'object') return null;
  const m = matching as Record<string, unknown>;
  return (
    asNonEmptyString(m.value) ??
    asNonEmptyString(m.Value) ??
    asNonEmptyString(m.name)
  );
}

export function parseCatalogItemImageUrl(
  payloadRaw: unknown,
  marketplaceId: string,
): string | null {
  const payload = unwrapCatalogPayload(payloadRaw);
  const images = payload.images ?? payload.Images;
  if (!Array.isArray(images) || images.length === 0) return null;

  const matching =
    images.find((x) => {
      if (!x || typeof x !== 'object') return false;
      const o = x as Record<string, unknown>;
      return (o.marketplaceId ?? o.marketplace_id) === marketplaceId;
    }) ?? images[0];

  if (!matching || typeof matching !== 'object') return null;
  const m = matching as Record<string, unknown>;
  const listRaw = m.images ?? m.Images ?? m.imageSet ?? m.ImageSet;
  const list: unknown[] = Array.isArray(listRaw) ? listRaw : [];
  if (list.length === 0) return null;

  const pick =
    list.find((img) => {
      if (!img || typeof img !== 'object') return false;
      const o = img as Record<string, unknown>;
      return String(o.variant ?? o.Variant ?? '').toUpperCase() === 'MAIN';
    }) ?? list[0];

  if (!pick || typeof pick !== 'object') return null;
  const p = pick as Record<string, unknown>;
  return (
    asNonEmptyString(p.link) ??
    asNonEmptyString(p.Link) ??
    asNonEmptyString(p.url) ??
    asNonEmptyString(p.URL) ??
    asNonEmptyString(p.uri) ??
    asNonEmptyString(p.URI)
  );
}

export function normalizePurchaseAsin(raw: string): string | null {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s/g, '');
  if (!s) return null;
  if (/^[A-Z0-9]{10}$/.test(s)) return s;
  return null;
}
