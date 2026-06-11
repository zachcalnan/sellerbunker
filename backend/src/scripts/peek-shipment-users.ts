import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();
const ids = process.argv.slice(2);

async function main() {
  const users = await p.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, email: true, activeOrgId: true },
  });
  const mem = await p.organizationMembership.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, orgId: true },
  });
  const accts = await p.sellerAccount.findMany({
    where: { userId: { in: ids }, marketplace: 'amazon' },
    select: { userId: true, sellerId: true },
  });
  console.log(JSON.stringify({ users, mem, accts }, null, 2));
}

main().finally(() => p.$disconnect());
