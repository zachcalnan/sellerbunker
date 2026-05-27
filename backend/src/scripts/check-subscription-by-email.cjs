const { PrismaClient } = require('@prisma/client');

async function main() {
  const email = String(process.env.CHECK_EMAIL ?? '').trim().toLowerCase();
  if (!email) {
    console.error('Set CHECK_EMAIL');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        clerkId: true,
        brevoSyncedAt: true,
        createdAt: true,
      },
    });
    console.log('user', user);
    if (!user) return;

    const subscription = await prisma.subscription.findUnique({
      where: { userId: user.id },
    });
    console.log('subscription', subscription);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

