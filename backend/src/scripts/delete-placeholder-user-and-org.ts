import { PrismaClient } from '@prisma/client';

async function main() {
  const userId = process.argv[2]?.trim();
  const orgId = process.argv[3]?.trim();
  if (!userId || !orgId) {
    throw new Error(
      'Usage: delete-placeholder-user-and-org.ts <placeholderUserId> <placeholderOrgId>',
    );
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, activeOrgId: true, clerkId: true },
    });
    const org = await (prisma as any).organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true },
    });

    if (!user) throw new Error(`User not found: ${userId}`);
    if (!org) throw new Error(`Org not found: ${orgId}`);
    if (!String(user.email).endsWith('@placeholder.local')) {
      throw new Error(`Refusing: user is not placeholder.local (${user.email})`);
    }
    if (user.activeOrgId !== orgId) {
      throw new Error(`Refusing: user.activeOrgId != orgId (${user.activeOrgId} != ${orgId})`);
    }

    const counts = {
      memberships: await (prisma as any).organizationMembership.count({
        where: { orgId },
      }),
      ruleSets: await (prisma as any).repricerRuleSet.count({ where: { orgId } }),
      selectedSkus: await (prisma as any).repricerSelectedSku.count({ where: { orgId } }),
      logs: await (prisma as any).repricerLog.count({ where: { orgId } }),
    };

    await prisma.$transaction(async (tx) => {
      await (tx as any).repricerLog.deleteMany({ where: { orgId } });
      await (tx as any).repricerSelectedSku.deleteMany({ where: { orgId } });
      await (tx as any).repricerRuleSet.deleteMany({ where: { orgId } });
      await (tx as any).organizationMembership.deleteMany({ where: { orgId } });
      await (tx as any).organization.delete({ where: { id: orgId } });
      await tx.user.delete({ where: { id: userId } });
    });

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          deleted: { userId, orgId },
          priorCounts: counts,
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

