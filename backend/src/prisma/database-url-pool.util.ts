/**
 * Append Prisma-recommended pool params when missing so `findUnique` etc. don't fail with
 * "Timed out fetching a new connection from the connection pool" under burst load / small Render DB caps.
 *
 * Override via full `DATABASE_URL` query string, or set `PRISMA_CONNECTION_LIMIT` (integer).
 */
export function mergeDatabaseUrlWithPoolDefaults(url: string | undefined): string {
  if (url == null || url === '') return '';
  let out = url.trim();
  const hasParam = (key: string) => new RegExp(`[?&]${key}=`, 'i').test(out);
  const append = (pair: string) => {
    out += (out.includes('?') ? '&' : '?') + pair;
  };
  if (!hasParam('pool_timeout')) {
    append('pool_timeout=30');
  }
  if (!hasParam('connect_timeout')) {
    append('connect_timeout=20');
  }
  const cap = process.env.PRISMA_CONNECTION_LIMIT?.trim();
  if (cap && /^\d+$/.test(cap) && !hasParam('connection_limit')) {
    append(`connection_limit=${cap}`);
  }
  return out;
}
