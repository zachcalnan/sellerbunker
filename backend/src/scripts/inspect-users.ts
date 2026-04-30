import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const db = process.env.DATABASE_URL || '';
    try {
      const u = new URL(db);
      // eslint-disable-next-line no-console
      console.log(`DB: ${u.host}${u.pathname}`);
    } catch {
      // eslint-disable-next-line no-console
      console.log('DB: (invalid DATABASE_URL)');
    }
    const count = await prisma.user.count();
    const rows = await prisma.user.findMany({
      select: { id: true, email: true, createdAt: true, clerkId: true },
      orderBy: { createdAt: 'asc' },
    });

    // eslint-disable-next-line no-console
    console.log(`User count: ${count}`);
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(`${r.createdAt.toISOString()}  ${r.email}  id=${r.id}  clerkId=${r.clerkId ?? ''}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

