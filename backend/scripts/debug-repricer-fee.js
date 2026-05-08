const { PrismaClient } = require("@prisma/client");

async function main() {
  const asin = process.env.ASIN || "B0DG5GG9GQ";
  const prisma = new PrismaClient();
  try {
    const prod = await prisma.product.findFirst({
      where: { asin },
      select: {
        id: true,
        sku: true,
        asin: true,
        currentListedPrice: true,
        currentListedPriceUpdatedAt: true,
        costOfGoods: true,
        estimatedAmazonFeePerUnit: true,
        estimatedReferralFeePerUnit: true,
        estimatedFbaFeePerUnit: true,
        estimatedDigitalServiceFeePerUnit: true,
      },
    });
    console.log("PRODUCT", prod);
    if (!prod) return;

    const logs = await prisma.repricerLog.findMany({
      where: { productId: prod.id },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: {
        createdAt: true,
        kind: true,
        message: true,
        context: true,
        prevPrice: true,
        nextPrice: true,
      },
    });

    const slim = logs.map((l) => ({
      createdAt: l.createdAt,
      kind: l.kind,
      prevPrice: l.prevPrice,
      nextPrice: l.nextPrice,
      message: String(l.message ?? "").slice(0, 240),
      ctx_fee: l.context && typeof l.context === "object" ? l.context.fee : null,
      ctx_cost: l.context && typeof l.context === "object" ? l.context.cost : null,
      ctx_minRoiPct:
        l.context && typeof l.context === "object" ? l.context.minRoiPct : null,
      ctx_bounds:
        l.context && typeof l.context === "object" ? l.context.bounds : null,
    }));
    console.log("REPRICER_LOGS", slim);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

