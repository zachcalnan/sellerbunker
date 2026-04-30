import { PrismaClient } from '@prisma/client';
import { createClerkClient } from '@clerk/backend';

type ClerkUserLike = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  emailAddresses?: Array<{ id: string; emailAddress: string }>;
  primaryEmailAddressId?: string | null;
};

function pickEmail(u: ClerkUserLike): string | null {
  const list = Array.isArray(u.emailAddresses) ? u.emailAddresses : [];
  const primaryId = u.primaryEmailAddressId ?? null;
  const primary = primaryId ? list.find((e) => e.id === primaryId)?.emailAddress : null;
  const fallback = list[0]?.emailAddress ?? null;
  const email = (primary ?? fallback ?? '').trim();
  return email && email.includes('@') ? email : null;
}

function buildName(u: ClerkUserLike): string | null {
  const first = String(u.firstName ?? '').trim();
  const last = String(u.lastName ?? '').trim();
  const full = `${first} ${last}`.trim();
  return full ? full : null;
}

async function main() {
  const secretKey = process.env.CLERK_SECRET_KEY ?? process.env.CLERK_SECRETKEY;
  if (!secretKey) {
    throw new Error('CLERK_SECRET_KEY is not configured in env');
  }

  const prisma = new PrismaClient();
  const clerk = createClerkClient({ secretKey });

  let created = 0;
  let linked = 0;
  let updated = 0;
  let skippedNoEmail = 0;

  const limit = 100;
  let offset = 0;

  while (true) {
    // Clerk SDK shapes differ across versions; treat as "any" and normalize.
    const res: any = await (clerk as any).users.getUserList({ limit, offset });
    const data: ClerkUserLike[] = Array.isArray(res) ? res : (res?.data ?? []);
    if (!data || data.length === 0) break;

    for (const u of data) {
      const clerkId = String(u.id ?? '').trim();
      if (!clerkId) continue;
      const email = pickEmail(u);
      if (!email) {
        skippedNoEmail++;
        continue;
      }
      const name = buildName(u);

      const byClerk = await prisma.user.findUnique({ where: { clerkId } });
      if (byClerk) {
        const needsEmailUpdate =
          byClerk.email.endsWith('@placeholder.local') || byClerk.email !== email;
        const needsNameUpdate = !byClerk.name && name;
        if (needsEmailUpdate || needsNameUpdate) {
          await prisma.user.update({
            where: { id: byClerk.id },
            data: {
              email,
              name: needsNameUpdate ? name : undefined,
            },
          });
          updated++;
        }
        continue;
      }

      // Try link by real email
      const byEmail = await prisma.user.findUnique({ where: { email } });
      if (byEmail) {
        await prisma.user.update({
          where: { id: byEmail.id },
          data: {
            clerkId,
            name: byEmail.name || name || undefined,
          },
        });
        linked++;
        continue;
      }

      // Try link/repair placeholder email row for this clerkId.
      const placeholderEmail = `${clerkId}@placeholder.local`;
      const byPlaceholder = await prisma.user.findUnique({
        where: { email: placeholderEmail },
      });
      if (byPlaceholder) {
        await prisma.user.update({
          where: { id: byPlaceholder.id },
          data: {
            clerkId,
            email,
            name: byPlaceholder.name || name || undefined,
          },
        });
        linked++;
        continue;
      }

      await prisma.user.create({
        data: {
          clerkId,
          email,
          passwordHash: '',
          name: name ?? undefined,
        },
      });
      created++;
    }

    offset += data.length;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      { created, linked, updated, skippedNoEmail },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

