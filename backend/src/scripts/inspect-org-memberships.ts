import { PrismaClient } from '@prisma/client';

async function main() {
  const userId = process.argv[2]?.trim();
  if (!userId) throw new Error('Usage: inspect-org-memberships.ts <userId>');
  const prisma = new PrismaClient();
  try {
    const rows = await (prisma as any).organizationMembership.findMany({
      where: { userId },
      select: {
        id: true,
        role: true,
        orgId: true,
        createdAt: true,
        org: { select: { id: true, name: true, createdAt: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

