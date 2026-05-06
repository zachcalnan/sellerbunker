import { PrismaClient } from '@prisma/client';

async function main() {
  const asin = process.argv[2]?.trim();
  if (!asin) throw new Error('Usage: debug-latest-purchase-by-asin.ts <asin>');
  const prisma = new PrismaClient();
  try {
    const row = await prisma.purchase.findFirst({
      where: { product: { asin } },
      orderBy: [{ purchaseDate: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        purchaseDate: true,
        updatedAt: true,
        supplier: true,
        supplierLink: true,
        bundleSize: true,
        qtyPurchased: true,
        qtyDelivered: true,
        currency: true,
        vatRatePct: true,
        unitCostIncVat: true,
        deliveryCostIncVat: true,
        prepCostIncVat: true,
        totalCostIncVat: true,
        product: { select: { id: true, sku: true, asin: true, title: true } },
      },
    });

    if (!row) {
      // eslint-disable-next-line no-console
      console.log('No purchase rows found for ASIN', asin);
      return;
    }

    const bundle = Math.max(1, Number(row.bundleSize ?? 1));
    const unit = Number(row.unitCostIncVat ?? 0);
    const del = Number(row.deliveryCostIncVat ?? 0);
    const prep = Number(row.prepCostIncVat ?? 0);
    const perUnitLedger = unit + del + prep;
    const perUnitIfTotalsOverQty =
      row.qtyPurchased && row.qtyPurchased > 0 ? (unit + del + prep) / row.qtyPurchased : null;
    const perUnitIfBundleSplit = (unit + del + prep) / bundle;

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          asin,
          purchase: {
            id: row.id,
            purchaseDate: row.purchaseDate.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            supplier: row.supplier,
            supplierLink: row.supplierLink,
            bundleSize: row.bundleSize,
            qtyPurchased: row.qtyPurchased,
            qtyDelivered: row.qtyDelivered,
            currency: row.currency,
            vatRatePct: Number(row.vatRatePct ?? 0),
            unitCostIncVat: unit,
            deliveryCostIncVat: del,
            prepCostIncVat: prep,
            totalCostIncVat: Number(row.totalCostIncVat ?? 0),
            product: row.product,
          },
          derived: {
            perUnitLedger_unitPlusDeliveryPlusPrep: Math.round(perUnitLedger * 100) / 100,
            perUnit_ifFieldsWereOrderTotals_divQtyPurchased:
              perUnitIfTotalsOverQty != null ? Math.round(perUnitIfTotalsOverQty * 100) / 100 : null,
            perUnit_ifBundleSplit: Math.round(perUnitIfBundleSplit * 100) / 100,
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

