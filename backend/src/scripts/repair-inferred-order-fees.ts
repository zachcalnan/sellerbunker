/**
 * Recompute order-line fees that were wrongly copied flat from another sale price
 * (feesSource=finances but no settled breakdown, or inflated amazonFeesTotal).
 *
 * Usage: npx ts-node -r tsconfig-paths/register src/scripts/repair-inferred-order-fees.ts [ASIN]
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AmazonService } from '../amazon/amazon.service';
import { PrismaService } from '../prisma/prisma.service';

async function main() {
  const asinFilter = (process.argv[2] ?? '').trim().toUpperCase() || null;
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const amazon = app.get(AmazonService);

  try {
    const broken = await prisma.orderItem.findMany({
      where: {
        marketplace: 'amazon',
        ...(asinFilter ? { asin: asinFilter } : {}),
        OR: [
          {
            feesSource: 'finances',
            settledReferralFeeTotal: null,
            OR: [{ amazonFeesTotal: { lt: 0 } }, { amazonFeesTotal: { gt: 0 } }],
          },
          {
            feesSource: 'estimate_sold',
            OR: [{ amazonFeesTotal: { lt: 0 } }, { amazonFeesTotal: { gt: 0 } }],
          },
        ],
      },
      select: {
        id: true,
        userId: true,
        asin: true,
        revenueTotal: true,
        quantity: true,
        amazonFeesTotal: true,
        cogsTotal: true,
        taxChargedTotal: true,
        orderDate: true,
        profit: true,
      },
      take: 500,
    });

    let fixed = 0;
    for (const row of broken) {
      if (!row.asin) continue;
      const product = await prisma.product.findFirst({
        where: { userId: row.userId, asin: row.asin },
        select: {
          estimatedReferralFeePerUnit: true,
          estimatedFbaFeePerUnit: true,
          estimatedDigitalServiceFeePerUnit: true,
          estimatedAmazonFeePerUnit: true,
        },
      });
      const orderDate = row.orderDate instanceof Date ? row.orderDate : new Date(row.orderDate);
      const vatSettings = await (amazon as any).getVatSettingsForUser(row.userId);

      let inferred: {
        itemFees: number;
        referralLine: number | null;
        fbaLine: number | null;
        digitalLine: number | null;
      } | null = null;

      const fromProduct = product
        ? (amazon as any).orderItemFeeEstimateScStyleFromProduct(
            product,
            Number(row.quantity) || 1,
            orderDate,
            vatSettings,
          )
        : null;

      const template = await (amazon as any).findBestSameAsinSettledTemplate(
        row.userId,
        row.asin,
        Number(row.revenueTotal),
      );
      const fromAsin = template
        ? (amazon as any).inferFeesFromSameAsinTemplate(
            template,
            Number(row.revenueTotal),
            Number(row.quantity) || 1,
          )
        : null;

      if (fromProduct && fromAsin) {
        const prodMag = Math.abs(fromProduct.itemFees);
        const asinMag = Math.abs(fromAsin.itemFees);
        inferred = prodMag <= asinMag ? fromProduct : fromAsin;
      } else {
        inferred = fromProduct ?? fromAsin;
      }
      if (!inferred) continue;
      const oldFees = Number(row.amazonFeesTotal);
      const newFees = inferred.itemFees;
      if (Math.abs(Math.abs(oldFees) - Math.abs(newFees)) < 0.02) continue;

      const vatResult = (amazon as any).computeOrderItemVatAndProfit(
        Number(row.revenueTotal),
        row.cogsTotal != null ? Number(row.cogsTotal) : null,
        Number(row.quantity) || 1,
        orderDate,
        newFees,
        Number(row.taxChargedTotal ?? 0),
        vatSettings,
      );

      await prisma.orderItem.update({
        where: { id: row.id },
        data: {
          amazonFeesTotal: newFees,
          feesSource: 'estimate_sold',
          settledReferralFeeTotal: null,
          settledFbaFeeTotal: null,
          settledDigitalServiceFeeTotal: null,
          atSaleEstimateReferralFeeTotal: inferred.referralLine,
          atSaleEstimateFbaFeeTotal: inferred.fbaLine,
          atSaleEstimateDigitalServiceFeeTotal: inferred.digitalLine,
          profit: vatResult.profit != null ? Number(vatResult.profit.toFixed(2)) : null,
        },
      });
      fixed += 1;
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          asin: row.asin,
          revenue: row.revenueTotal,
          oldFees,
          newFees,
          oldProfit: row.profit,
          newProfit: vatResult.profit,
        }),
      );
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ scanned: broken.length, fixed }, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
