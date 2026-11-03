/**
 * Helpers for controlled qty number fields.
 * Coercing empty input to 1 on every keystroke traps mobile users at 1
 * (backspace → "" → 1), so draft text is kept while editing and snapped on blur.
 */

export function qtyDraftFromNumber(n: number): string {
  if (!Number.isFinite(n) || n < 1) return "1";
  return String(Math.floor(n));
}

/** Allow empty / partial digits while typing; reject non-numeric junk. */
export function sanitizeQtyDraft(raw: string): string {
  if (raw === "") return "";
  const digits = raw.replace(/[^\d]/g, "");
  if (digits === "") return "";
  // Strip leading zeros but keep a single zero while typing (then blur bumps to 1).
  const normalized = digits.replace(/^0+(?=\d)/, "");
  return normalized;
}

export function coerceQty(
  raw: string | number | null | undefined,
  fallback = 1,
): number {
  const n =
    typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || n < 1) return Math.max(1, Math.floor(fallback) || 1);
  return Math.max(1, Math.floor(n));
}
