import { PrismaClient } from '@prisma/client';

async function main() {
  const orgId = process.argv[2]?.trim();
  if (!orgId) throw new Error('Usage: find-org-references.ts <orgId>');
  const prisma = new PrismaClient();
  try {
    const usersWithActiveOrg = await prisma.user.findMany({
      where: { activeOrgId: orgId },
      select: { id: true, email: true, clerkId: true, activeOrgId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const memberships = await (prisma as any).organizationMembership.findMany({
      where: { orgId },
      select: { id: true, userId: true, role: true, createdAt: true, user: { select: { email: true, clerkId: true } } },
      orderBy: { createdAt: 'asc' },
    });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ usersWithActiveOrg, memberships }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

