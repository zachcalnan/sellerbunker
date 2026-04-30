import { PrismaClient } from '@prisma/client';

async function main() {
  const email = process.argv[2]?.trim();
  if (!email) throw new Error('Usage: lookup-user-by-email.ts <email>');
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        clerkId: true,
        name: true,
        activeOrgId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(user, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

