/**
 * Verify repricer can resolve Listings GET metadata (no price PATCH). Prisma + SP-API only (no Redis).
 *
 * Usage (from backend/):
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register src/scripts/verify-repricer-listing-meta.ts <orgId> [sku]
 */
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { AmazonSpApiClient, SpApiCredentials } from '../amazon/sp-api.client';
import {
  isListingsGetRetryableError,
  parseListingPatchMetaFromGetListingsItem,
} from '../repricer/repricer-listing-patch-meta.util';

const UK = 'A1F83G8C2ARO7P';

async function getOrgMemberUserIds(prisma: PrismaClient, orgId: string): Promise<string[]> {
  const rows = await prisma.organizationMembership.findMany({
    where: { orgId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** Mirrors AmazonService.getOrgAmazonAggregateUserIds (canonical seller per duplicate links). */
async function getOrgAmazonAggregateUserIds(prisma: PrismaClient, orgId: string): Promise<string[]> {
  const members = await getOrgMemberUserIds(prisma, orgId);
  if (members.length <= 1) return members;

  const accounts = await prisma.sellerAccount.findMany({
    where: { userId: { in: members }, marketplace: 'amazon', isActive: true },
    select: { userId: true, sellerId: true, ordersLastSyncedAt: true, updatedAt: true },
  });
  const accountByUser = new Map(accounts.map((a) => [a.userId, a] as const));
  const groups = new Map<string, string[]>();
  for (const uid of members) {
    const acc = accountByUser.get(uid);
    const sidRaw = acc?.sellerId != null ? String(acc.sellerId).trim() : '';
    const sid = sidRaw ? sidRaw.toUpperCase() : '';
    const key = sid || `__user_${uid}`;
    const arr = groups.get(key) ?? [];
    arr.push(uid);
    groups.set(key, arr);
  }
  const out: string[] = [];
  for (const [, uids] of groups) {
    if (uids.length === 1) {
      out.push(uids[0]!);
      continue;
    }
    let best = uids[0]!;
    let bestTs = -1;
    for (const uid of uids) {
      const acc = accountByUser.get(uid);
      const t1 = acc?.ordersLastSyncedAt instanceof Date ? acc.ordersLastSyncedAt.getTime() : 0;
      const t2 = acc?.updatedAt instanceof Date ? acc.updatedAt.getTime() : 0;
      const ts = Math.max(t1, t2);
      if (ts > bestTs || (ts === bestTs && uid < best)) {
        bestTs = ts;
        best = uid;
      }
    }
    out.push(best);
  }
  return [...new Set(out)];
}

function spApiCredentialsFromSellerAccountJson(c: Record<string, unknown>): SpApiCredentials {
  const region =
    c?.region === 'na' || c?.region === 'eu' || c?.region === 'fe' ? (c.region as SpApiCredentials['region']) : 'eu';
  return {
    region,
    lwaClientId: String(c?.lwaClientId ?? ''),
    lwaClientSecret: String(c?.lwaClientSecret ?? ''),
    refreshToken: String(c?.refreshToken ?? ''),
    awsAccessKeyId: String(c?.awsAccessKeyId ?? ''),
    awsSecretAccessKey: String(c?.awsSecretAccessKey ?? ''),
    awsRoleArn: process.env.AWS_ROLE_ARN,
  };
}

async function findCanonicalAccount(prisma: PrismaClient, orgId: string) {
  const userIds = await getOrgAmazonAggregateUserIds(prisma, orgId);
  return prisma.sellerAccount.findFirst({
    where: { userId: { in: userIds }, marketplace: 'amazon' },
    orderBy: { updatedAt: 'desc' },
    select: { userId: true, sellerId: true, credentials: true, updatedAt: true },
  });
}

async function findLegacyAccount(prisma: PrismaClient, orgId: string) {
  const memberIds = await getOrgMemberUserIds(prisma, orgId);
  return prisma.sellerAccount.findFirst({
    where: { userId: { in: memberIds }, marketplace: 'amazon' },
    orderBy: { updatedAt: 'desc' },
    select: { userId: true, sellerId: true, updatedAt: true },
  });
}

async function tryGetMeta(
  spApi: AmazonSpApiClient,
  creds: SpApiCredentials,
  sellerId: string,
  sku: string,
  fallbackProductType: string | null,
  label: string,
) {
  const defaultMid = creds.region === 'na' ? 'ATVPDKIKX0DER' : creds.region === 'fe' ? 'A1VC38T7YXB528' : UK;
  const mids = [
    defaultMid,
    ...spApi.marketplaceIdsForListingPriceRefresh(creds.region).filter((m) => m !== defaultMid),
  ];
  let lastErr: string | null = null;
  for (const mid of mids) {
    try {
      const res = await spApi.getListingsItem(creds, sellerId, sku.trim(), [mid], [
        'summaries',
        'offers',
        'attributes',
      ]);
      const meta = parseListingPatchMetaFromGetListingsItem(res, mid, fallbackProductType);
      const payload = (res as { payload?: unknown })?.payload ?? res;
      const p = payload as { summaries?: unknown[]; offers?: unknown[] };
      return {
        label,
        ok: meta != null,
        meta,
        marketplaceTried: mid,
        summaryCount: Array.isArray(p?.summaries) ? p.summaries.length : 0,
        offerCount: Array.isArray(p?.offers) ? p.offers.length : 0,
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (isListingsGetRetryableError(e)) continue;
      return { label, ok: false, error: lastErr, marketplaceTried: mid };
    }
  }
  if (fallbackProductType?.trim()) {
    return {
      label,
      ok: true,
      meta: {
        marketplaceId: defaultMid,
        productType: fallbackProductType.trim(),
        currency: 'GBP',
        source: 'db_product_type_fallback_only',
      },
      lastErr,
    };
  }
  return { label, ok: false, lastErr };
}

async function main() {
  const orgId = (process.argv[2] ?? 'c8e110bc-8ec0-4e21-ba7e-145e03ba23aa').trim();
  const skuArg = (process.argv[3] ?? 'N9-46CZ-2Z3N').trim();

  const prisma = new PrismaClient();
  const config = new ConfigService(process.env);
  const spApi = new AmazonSpApiClient(config);

  try {
    const legacyAccount = await findLegacyAccount(prisma, orgId);
    const canonicalAccount = await findCanonicalAccount(prisma, orgId);
    if (!canonicalAccount) throw new Error('No canonical Amazon seller account for org');

    const creds = spApiCredentialsFromSellerAccountJson(
      (canonicalAccount.credentials ?? {}) as Record<string, unknown>,
    );
    if (!creds.lwaClientId || !creds.refreshToken) {
      throw new Error('Canonical account credentials incomplete');
    }
    const sellerId =
      canonicalAccount.sellerId != null && String(canonicalAccount.sellerId).trim()
        ? String(canonicalAccount.sellerId).trim()
        : null;

    const memberIds = await getOrgMemberUserIds(prisma, orgId);
    const product = await prisma.product.findFirst({
      where: { sku: skuArg, userId: { in: memberIds } },
      select: { sku: true, asin: true, productType: true, currentListedPrice: true },
    });
    const fallbackPt = product?.productType?.trim() || null;

    const aggregateIds = await getOrgAmazonAggregateUserIds(prisma, orgId);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          step: 'account_compare',
          orgId,
          sku: skuArg,
          productAsin: product?.asin ?? null,
          dbProductType: fallbackPt,
          dbListedPrice: product?.currentListedPrice != null ? Number(product.currentListedPrice) : null,
          memberCount: memberIds.length,
          aggregateUserIds: aggregateIds,
          legacy: {
            userId: legacyAccount?.userId ?? null,
            sellerId: legacyAccount?.sellerId ?? null,
          },
          canonical: {
            userId: canonicalAccount.userId,
            sellerId,
            region: creds.region,
          },
          sellerIdMismatch:
            legacyAccount?.sellerId != null &&
            sellerId != null &&
            String(legacyAccount.sellerId).trim() !== sellerId,
          userIdMismatch:
            legacyAccount?.userId != null && legacyAccount.userId !== canonicalAccount.userId,
        },
        null,
        2,
      ),
    );

    if (!sellerId) throw new Error('Canonical context has no sellerId');

    const results: Array<Record<string, unknown>> = [];
    if (
      legacyAccount?.sellerId?.trim() &&
      String(legacyAccount.sellerId).trim() !== sellerId
    ) {
      results.push(
        await tryGetMeta(
          spApi,
          creds,
          String(legacyAccount.sellerId).trim(),
          skuArg,
          fallbackPt,
          'legacy_seller_id_with_canonical_creds',
        ),
      );
    }
    results.push(
      await tryGetMeta(spApi, creds, sellerId, skuArg, fallbackPt, 'canonical_seller_id'),
    );

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ step: 'listings_get', results }, null, 2));

    const canonicalOk = results.find((r) => r.label === 'canonical_seller_id')?.ok === true;
    if (!canonicalOk) {
      process.exitCode = 1;
      // eslint-disable-next-line no-console
      console.error('FAIL: canonical seller could not resolve listing patch metadata');
    } else {
      // eslint-disable-next-line no-console
      console.log('OK: repricer should be able to PATCH after deploy (metadata resolves)');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
