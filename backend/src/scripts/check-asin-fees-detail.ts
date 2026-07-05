import { PrismaClient } from '@prisma/client';

async function main() {
  const asin = (process.argv[2] ?? 'B07RM5DCFR').toUpperCase();
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.orderItem.findMany({
      where: { asin, amazonFeesTotal: { not: 0 } },
      orderBy: { orderDate: 'desc' },
      take: 3,
      select: {
        revenueTotal: true,
        amazonFeesTotal: true,
        feesSource: true,
        profit: true,
        settledReferralFeeTotal: true,
        settledFbaFeeTotal: true,
        settledDigitalServiceFeeTotal: true,
        atSaleEstimateReferralFeeTotal: true,
        atSaleEstimateFbaFeeTotal: true,
        atSaleEstimateDigitalServiceFeeTotal: true,
        orderDate: true,
        sku: true,
      },
    });
    const prod = await prisma.product.findFirst({
      where: { asin, costOfGoods: { not: null } },
      select: {
        id: true,
        sku: true,
        feeEstimateRawJson: true,
        estimatedReferralFeePerUnit: true,
        estimatedFbaFeePerUnit: true,
        estimatedDigitalServiceFeePerUnit: true,
        estimatedAmazonFeePerUnit: true,
        currentListedPrice: true,
        costOfGoods: true,
      },
    });
    let priceAtEstimate: number | null = null;
    const raw = prod?.feeEstimateRawJson as Record<string, unknown> | null;
    if (raw) {
      const feeResult =
        (raw as any)?.payload?.FeesEstimateResult ??
        (raw as any)?.FeesEstimateResult ??
        raw;
      const pp =
        feeResult?.FeesEstimateIdentifier?.PriceToEstimateFees?.ListingPrice ??
        feeResult?.feesEstimateIdentifier?.priceToEstimateFees?.listingPrice;
      const amt = pp?.Amount ?? pp?.amount;
      const n = typeof amt === 'number' ? amt : typeof amt === 'string' ? parseFloat(amt) : null;
      if (n != null && Number.isFinite(n) && n > 0) priceAtEstimate = n;
    }
    const withBreakdown = await prisma.orderItem.findMany({
      where: {
        asin,
        OR: [
          { settledReferralFeeTotal: { not: null } },
          { atSaleEstimateReferralFeeTotal: { not: null } },
        ],
      },
      orderBy: { orderDate: 'desc' },
      take: 5,
      select: {
        revenueTotal: true,
        amazonFeesTotal: true,
        feesSource: true,
        settledReferralFeeTotal: true,
        settledFbaFeeTotal: true,
        settledDigitalServiceFeeTotal: true,
        atSaleEstimateReferralFeeTotal: true,
        atSaleEstimateFbaFeeTotal: true,
        atSaleEstimateDigitalServiceFeeTotal: true,
        orderDate: true,
      },
    });

    const cogs = prod?.costOfGoods != null ? Number(prod.costOfGoods) : 25.5;
    const price = 37.39;
    const ref = 4.79;
    const fba = 3.11;
    const dig = 0.16;
    const priceAtEst = priceAtEstimate ?? 39.94;
    const referralRate = ref / priceAtEst;
    const digRate = dig / (ref + fba);
    const k = referralRate * (1 + digRate);
    const b = fba * (1 + digRate);
    const feeLinear = k * price + b;
    const feeFlat = ref + fba + dig;
    const feeFinances = 10.65;
    const roi = (p: number, f: number) => ((p - cogs - f) / cogs) * 100;
    const minRoi15 = (fPu: number) => cogs * 1.15 + fPu;

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          asin,
          orders: rows,
          withBreakdown,
          product: prod
            ? {
                ...prod,
                feeEstimateRawJson: undefined,
                priceAtEstimate,
              }
            : null,
          repricerMath: {
            referralRate,
            k,
            b,
            feeAt3739_linear: Math.round(feeLinear * 100) / 100,
            feeAt3739_flat: Math.round(feeFlat * 100) / 100,
            feeFinancesPerUnit: feeFinances,
            profitAt3739_linear: Math.round((price - cogs - feeLinear) * 100) / 100,
            profitAt3739_flat: Math.round((price - cogs - feeFlat) * 100) / 100,
            profitAt3739_finances: Math.round((price - cogs - feeFinances) * 100) / 100,
            roiPct_linear: Math.round(roi(price, feeLinear) * 10) / 10,
            roiPct_flat: Math.round(roi(price, feeFlat) * 10) / 10,
            roiPct_finances: Math.round(roi(price, feeFinances) * 10) / 10,
            minPrice15pct_flat: Math.round(minRoi15(feeFlat) * 100) / 100,
            minPrice15pct_linear: Math.round(minRoi15(feeLinear) * 100) / 100,
            minPrice15pct_finances: Math.round(minRoi15(feeFinances) * 100) / 100,
          },
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
