/**
 * Move Amazon-related rows from one `users` row to another (same database).
 *
 * Use when you have two logins (e.g. Clerk dev vs prod created two rows) and want one user to own all data.
 * Default is dry-run — pass --execute to apply.
 *
 *   cd backend && npm run merge-user-data -- --from=SOURCE_EMAIL --to=TARGET_EMAIL
 *
 * If both users synced the same Seller Central account, add:
 *   --delete-from-clashing-orders
 * so FROM's duplicate Amazon orders are removed (TARGET keeps theirs), then:
 *   --execute
 *
 * Does not delete the source `users` row or change Clerk ids; run SQL separately if needed.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function parseArgs(argv: string[]): {
  from: string;
  to: string;
  execute: boolean;
  /** Delete FROM user's orders that duplicate (order_id, marketplace) on TO (same seller synced twice). */
  deleteFromClashingOrders: boolean;
} {
  let from = '';
  let to = '';
  let execute = false;
  let deleteFromClashingOrders = false;
  for (const a of argv) {
    if (a === '--execute') execute = true;
    else if (a === '--delete-from-clashing-orders')
      deleteFromClashingOrders = true;
    else if (a.startsWith('--from=')) from = a.slice('--from='.length).trim();
    else if (a.startsWith('--to=')) to = a.slice('--to='.length).trim();
  }
  if (!from || !to) {
    throw new Error(
      'Usage: merge-user-data.ts --from=<email|uuid> --to=<email|uuid> [--delete-from-clashing-orders] [--execute]',
    );
  }
  return { from, to, execute, deleteFromClashingOrders };
}

async function resolveUserId(token: string): Promise<{ id: string; email: string }> {
  const t = token.trim();
  if (t.includes('@')) {
    const u = await prisma.user.findUnique({
      where: { email: t.toLowerCase() },
      select: { id: true, email: true },
    });
    if (!u) throw new Error(`No user with email: ${t}`);
    return u;
  }
  const u = await prisma.user.findUnique({
    where: { id: t },
    select: { id: true, email: true },
  });
  if (!u) throw new Error(`No user with id: ${t}`);
  return u;
}

async function main() {
  const { from, to, execute, deleteFromClashingOrders } = parseArgs(
    process.argv.slice(2),
  );
  const fromU = await resolveUserId(from);
  const toU = await resolveUserId(to);
  if (fromU.id === toU.id) {
    throw new Error('from and to are the same user');
  }

  const counts = async (uid: string) => {
    const [
      products,
      orders,
      orderItems,
      sellerAccounts,
      purchases,
      shipments,
      inventory,
      invByMp,
      agg,
      sub,
      sync,
      mpSettings,
      aff,
    ] = await Promise.all([
      prisma.product.count({ where: { userId: uid } }),
      prisma.order.count({ where: { userId: uid } }),
      prisma.orderItem.count({ where: { userId: uid } }),
      prisma.sellerAccount.count({ where: { userId: uid } }),
      prisma.purchase.count({ where: { userId: uid } }),
      prisma.shipment.count({ where: { userId: uid } }),
      prisma.inventory.count({ where: { userId: uid } }),
      prisma.inventoryByMarketplace.count({ where: { userId: uid } }),
      prisma.aggDailyKpiSummary.count({ where: { userId: uid } }),
      prisma.subscription.count({ where: { userId: uid } }),
      prisma.initialSyncProgress.count({ where: { userId: uid } }),
      prisma.userMarketplaceSetting.count({ where: { userId: uid } }),
      prisma.affiliateCommission.count({ where: { userId: uid } }),
    ]);
    return {
      products,
      orders,
      orderItems,
      sellerAccounts,
      purchases,
      shipments,
      inventory,
      invByMp,
      agg,
      sub,
      sync,
      mpSettings,
      aff,
    };
  };

  const beforeFrom = await counts(fromU.id);
  const beforeTo = await counts(toU.id);

  // eslint-disable-next-line no-console
  console.log('FROM', fromU.email, fromU.id, JSON.stringify(beforeFrom));
  // eslint-disable-next-line no-console
  console.log('TO  ', toU.email, toU.id, JSON.stringify(beforeTo));

  const orderKeyClashes = await prisma.$queryRaw<
    { order_id: string; marketplace: string }[]
  >`
    SELECT o."order_id" AS order_id, o.marketplace
    FROM orders o
    INNER JOIN orders o2
      ON o."order_id" = o2."order_id"
     AND o.marketplace = o2.marketplace
     AND o.user_id::text = ${fromU.id}
     AND o2.user_id::text = ${toU.id}
  `;
  if (orderKeyClashes.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n${orderKeyClashes.length} Amazon orders exist on BOTH users (same order_id + marketplace).`,
    );
    // eslint-disable-next-line no-console
    console.warn('Sample:', orderKeyClashes.slice(0, 5));
    if (!deleteFromClashingOrders) {
      // eslint-disable-next-line no-console
      console.warn(
        'Re-run with --delete-from-clashing-orders to drop FROM copies only (TO keeps theirs), then merge.',
      );
      return;
    }
    if (!execute) {
      // eslint-disable-next-line no-console
      console.warn(
        'Dry run: would delete those FROM orders (and their order_items via cascade) before merge. Add --execute.',
      );
      return;
    }
  }

  if (!execute) {
    // eslint-disable-next-line no-console
    console.log(
      '\nDry run only. Re-run with --execute after backing up the database.',
    );
    return;
  }

  await prisma.$transaction(
    async (tx) => {
      if (orderKeyClashes.length > 0 && deleteFromClashingOrders) {
        const del = await tx.$executeRaw`
          DELETE FROM orders o
          WHERE o.user_id::text = ${fromU.id}
            AND EXISTS (
              SELECT 1 FROM orders o2
              WHERE o2.user_id::text = ${toU.id}
                AND o2.order_id = o.order_id
                AND o2.marketplace = o.marketplace
            )
        `;
        // eslint-disable-next-line no-console
        console.log('Deleted clashing FROM orders (rows affected):', del);
      }

      const fromProducts = await tx.product.findMany({
        where: { userId: fromU.id },
        select: { id: true, sku: true },
      });
      const toProducts = await tx.product.findMany({
        where: { userId: toU.id },
        select: { id: true, sku: true },
      });
      const toSku = new Map(toProducts.map((p) => [p.sku, p.id]));

      for (const fp of fromProducts) {
        const toPid = toSku.get(fp.sku);
        if (!toPid) continue;

        await tx.order.updateMany({
          where: { productId: fp.id },
          data: { productId: toPid },
        });
        await tx.orderItem.updateMany({
          where: { productId: fp.id },
          data: { productId: toPid },
        });
        await tx.purchase.updateMany({
          where: { productId: fp.id },
          data: { productId: toPid },
        });
        await tx.repricerLog.updateMany({
          where: { productId: fp.id },
          data: { productId: toPid },
        });

        const selRows = await tx.repricerSelectedSku.findMany({
          where: { productId: fp.id },
        });
        for (const row of selRows) {
          const clash = await tx.repricerSelectedSku.findUnique({
            where: {
              orgId_productId: { orgId: row.orgId, productId: toPid },
            },
          });
          if (clash) {
            await tx.repricerSelectedSku.delete({ where: { id: row.id } });
          } else {
            await tx.repricerSelectedSku.update({
              where: { id: row.id },
              data: { productId: toPid },
            });
          }
        }

        await tx.inventory.deleteMany({ where: { productId: fp.id } });
        await tx.inventoryByMarketplace.deleteMany({
          where: { productId: fp.id },
        });
        await tx.product.delete({ where: { id: fp.id } });
      }

      await tx.product.updateMany({
        where: { userId: fromU.id },
        data: { userId: toU.id },
      });

      await tx.order.updateMany({
        where: { userId: fromU.id },
        data: { userId: toU.id },
      });
      await tx.orderItem.updateMany({
        where: { userId: fromU.id },
        data: { userId: toU.id },
      });

      await tx.inventory.updateMany({
        where: { userId: fromU.id },
        data: { userId: toU.id },
      });
      await tx.inventoryByMarketplace.updateMany({
        where: { userId: fromU.id },
        data: { userId: toU.id },
      });

      await tx.purchase.updateMany({
        where: { userId: fromU.id },
        data: { userId: toU.id },
      });
      const fromShipments = await tx.shipment.findMany({
        where: { userId: fromU.id },
        select: { id: true, shipmentId: true },
      });
      for (const s of fromShipments) {
        const twin = await tx.shipment.findFirst({
          where: { userId: toU.id, shipmentId: s.shipmentId },
          select: { id: true },
        });
        if (twin) {
          await tx.shipment.delete({ where: { id: s.id } });
        } else {
          await tx.shipment.update({
            where: { id: s.id },
            data: { userId: toU.id },
          });
        }
      }

      const fromAccounts = await tx.sellerAccount.findMany({
        where: { userId: fromU.id },
      });
      for (const acc of fromAccounts) {
        const twin = await tx.sellerAccount.findUnique({
          where: {
            userId_marketplace: {
              userId: toU.id,
              marketplace: acc.marketplace,
            },
          },
        });
        if (twin) {
          await tx.sellerAccount.delete({ where: { id: acc.id } });
        } else {
          await tx.sellerAccount.update({
            where: { id: acc.id },
            data: { userId: toU.id },
          });
        }
      }

      const fromMp = await tx.userMarketplaceSetting.findMany({
        where: { userId: fromU.id },
      });
      for (const row of fromMp) {
        const twin = await tx.userMarketplaceSetting.findUnique({
          where: {
            userId_marketplaceId: {
              userId: toU.id,
              marketplaceId: row.marketplaceId,
            },
          },
        });
        if (twin) {
          await tx.userMarketplaceSetting.delete({ where: { id: row.id } });
        } else {
          await tx.userMarketplaceSetting.update({
            where: { id: row.id },
            data: { userId: toU.id },
          });
        }
      }

      const fromSub = await tx.subscription.findFirst({
        where: { userId: fromU.id },
      });
      if (fromSub) {
        const toSub = await tx.subscription.findFirst({
          where: { userId: toU.id },
        });
        if (toSub) {
          await tx.subscription.delete({ where: { id: fromSub.id } });
        } else {
          await tx.subscription.update({
            where: { id: fromSub.id },
            data: { userId: toU.id },
          });
        }
      }

      const fromSync = await tx.initialSyncProgress.findUnique({
        where: { userId: fromU.id },
      });
      if (fromSync) {
        const toSync = await tx.initialSyncProgress.findUnique({
          where: { userId: toU.id },
        });
        if (toSync) {
          await tx.initialSyncProgress.delete({ where: { userId: fromU.id } });
        } else {
          await tx.initialSyncProgress.update({
            where: { userId: fromU.id },
            data: { userId: toU.id },
          });
        }
      }

      await tx.affiliateCommission.updateMany({
        where: { userId: fromU.id },
        data: { userId: toU.id },
      });

      await tx.aggDailyKpiSummary.deleteMany({ where: { userId: fromU.id } });
    },
    { timeout: 120_000 },
  );

  const afterFrom = await counts(fromU.id);
  const afterTo = await counts(toU.id);
  // eslint-disable-next-line no-console
  console.log('\nDone. FROM counts now:', JSON.stringify(afterFrom));
  // eslint-disable-next-line no-console
  console.log('TO counts now:', JSON.stringify(afterTo));
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
