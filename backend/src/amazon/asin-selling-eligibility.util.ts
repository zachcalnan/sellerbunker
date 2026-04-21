/**
 * Interpret SP-API `getListingsRestrictions` JSON for FBA-style **new** condition restock decisions.
 * Response shape varies slightly by version; we read common camelCase fields.
 */
export function eligibilityFromListingsRestrictionsBody(body: unknown): {
  canRestock: boolean;
  notes: string | null;
} {
  if (body == null || typeof body !== 'object') {
    return { canRestock: false, notes: 'empty_or_invalid_response' };
  }
  const raw = body as Record<string, unknown>;
  const restrictions = raw.restrictions ?? raw.RestrictionList;
  if (!Array.isArray(restrictions) || restrictions.length === 0) {
    return { canRestock: true, notes: null };
  }
  const codes: string[] = [];
  for (const block of restrictions) {
    if (block == null || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const reasons = b.reasons ?? b.Reasons;
    if (!Array.isArray(reasons)) continue;
    for (const reason of reasons) {
      if (reason == null || typeof reason !== 'object') continue;
      const r = reason as Record<string, unknown>;
      const code = r.reasonCode ?? r.ReasonCode ?? r.code;
      if (code != null && String(code).trim()) codes.push(String(code).trim());
    }
  }
  if (codes.length === 0) {
    return { canRestock: true, notes: null };
  }
  return { canRestock: false, notes: [...new Set(codes)].join(', ') };
}
