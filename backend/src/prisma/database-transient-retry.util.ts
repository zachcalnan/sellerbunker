/**
 * Prisma / Postgres sometimes drops the TCP session mid-long-job (extended order sync, backfills).
 * Codes: https://www.prisma.io/docs/reference/api-reference/error-reference#prisma-client-query-engine
 */
export function isPrismaTransientConnectionError(e: unknown): boolean {
  if (e == null || typeof e !== 'object') return false;
  const code = (e as { code?: string }).code;
  if (code === 'P1017' || code === 'P1001' || code === 'P1008') return true;
  const msg = String((e as { message?: string }).message ?? '').toLowerCase();
  return (
    msg.includes('server has closed the connection') ||
    msg.includes("can't reach database server") ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('connection terminated') ||
    msg.includes('connection closed')
  );
}

export async function withPrismaTransientRetry<T>(
  run: () => Promise<T>,
  options?: { maxAttempts?: number; baseDelayMs?: number },
): Promise<T> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 4);
  const base = Math.max(50, options?.baseDelayMs ?? 400);
  let last: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await run();
    } catch (e) {
      last = e;
      if (!isPrismaTransientConnectionError(e) || attempt === maxAttempts) throw e;
      await new Promise((r) => setTimeout(r, base * attempt));
    }
  }
  throw last;
}
