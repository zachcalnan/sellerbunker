import { PrismaClient } from '@prisma/client';

async function main() {
  const orgId = process.argv[2]?.trim();
  if (!orgId) throw new Error('Usage: inspect-org-relations.ts <orgId>');
  const prisma = new PrismaClient();
  try {
    const org = await (prisma as any).organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, createdAt: true },
    });
    if (!org) {
      // eslint-disable-next-line no-console
      console.log('No org found for id', orgId);
      return;
    }
    const [memberships, selectedSkus, ruleSets, logs] = await Promise.all([
      (prisma as any).organizationMembership.count({ where: { orgId } }),
      (prisma as any).repricerSelectedSku.count({ where: { orgId } }),
      (prisma as any).repricerRuleSet.count({ where: { orgId } }),
      (prisma as any).repricerLog.count({ where: { orgId } }),
    ]);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ org, relations: { memberships, selectedSkus, ruleSets, logs } }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

