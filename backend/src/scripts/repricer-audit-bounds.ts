import { PrismaClient } from '@prisma/client';

type Ctx = {
  ruleSetId?: string;
  ruleSetName?: string;
  cost?: number | null;
  fee?: number | null;
  minProfit?: number | null;
  minRoiPct?: number | null;
  bounds?: { minPrice?: number | null; maxPrice?: number | null } | null;
};

function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : null;
}

function safeCtx(raw: unknown): Ctx {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as any;
  return {
    ruleSetId: typeof r.ruleSetId === 'string' ? r.ruleSetId : undefined,
    ruleSetName: typeof r.ruleSetName === 'string' ? r.ruleSetName : undefined,
    cost: toNum(r.cost),
    fee: toNum(r.fee),
    minProfit: toNum(r.minProfit),
    minRoiPct: toNum(r.minRoiPct),
    bounds: r.bounds && typeof r.bounds === 'object' ? r.bounds : null,
  };
}

async function main() {
  const orgId = process.argv[2]?.trim();
  const limit = Math.max(50, Math.min(2000, Number(process.argv[3] ?? 300) || 300));
  if (!orgId) throw new Error('Usage: repricer-audit-bounds.ts <orgId> [limit]');

  const prisma = new PrismaClient();
  try {
    const logs = await (prisma as any).repricerLog.findMany({
      where: { orgId, kind: 'decision' },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        productId: true,
        sku: true,
        message: true,
        prevPrice: true,
        nextPrice: true,
        createdAt: true,
        context: true,
        product: { select: { currentListedPrice: true } },
      },
    });

    const rows: Array<{
      ts: string;
      sku: string;
      current: number | null;
      next: number | null;
      minP: number | null;
      maxP: number | null;
      cost: number | null;
      fee: number | null;
      roiPctAtCurrent: number | null;
      roiMin: number | null;
      minProfit: number | null;
      rule: string | null;
      msg: string;
    }> = [];

    for (const l of logs ?? []) {
      const ctx = safeCtx(l.context);
      const current = toNum(l.product?.currentListedPrice) ?? null;
      const next = toNum(l.nextPrice) ?? null;
      const minP = toNum(ctx.bounds?.minPrice) ?? null;
      const maxP = toNum(ctx.bounds?.maxPrice) ?? null;
      const cost = ctx.cost ?? null;
      const feeAbs = ctx.fee != null ? Math.abs(ctx.fee) : null;
      const profitAtCurrent =
        current != null && cost != null ? current - (feeAbs ?? 0) - cost : null;
      const roiPctAtCurrent =
        profitAtCurrent != null && cost != null && cost > 0
          ? (profitAtCurrent / cost) * 100
          : null;

      const violating =
        minP != null && current != null && Number.isFinite(current) && current + 1e-9 < minP;
      if (!violating) continue;

      rows.push({
        ts: new Date(l.createdAt).toISOString(),
        sku: String(l.sku ?? ''),
        current,
        next,
        minP,
        maxP,
        cost,
        fee: feeAbs,
        roiPctAtCurrent:
          roiPctAtCurrent != null && Number.isFinite(roiPctAtCurrent)
            ? Math.round(roiPctAtCurrent * 10) / 10
            : null,
        roiMin: ctx.minRoiPct ?? null,
        minProfit: ctx.minProfit ?? null,
        rule: ctx.ruleSetName ?? ctx.ruleSetId ?? null,
        msg: String(l.message ?? ''),
      });
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          orgId,
          checkedLogs: (logs ?? []).length,
          violatingCount: rows.length,
          violating: rows.slice(0, 50),
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

