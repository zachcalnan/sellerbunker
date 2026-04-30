import { PrismaClient } from '@prisma/client';
import { createClerkClient } from '@clerk/backend';

type ClerkUserLike = {
  emailAddresses?: Array<{ id?: string; emailAddress?: string }>;
  primaryEmailAddressId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

function pickEmail(u: ClerkUserLike): string | null {
  const emails = Array.isArray(u.emailAddresses) ? u.emailAddresses : [];
  const primaryId = u.primaryEmailAddressId ?? null;
  const primary = primaryId
    ? emails.find((e) => e?.id === primaryId)?.emailAddress
    : undefined;
  const fallback = emails[0]?.emailAddress;
  const raw = String(primary ?? fallback ?? '').trim();
  return raw && raw.includes('@') ? raw : null;
}

function buildName(u: ClerkUserLike): string | null {
  const first = String(u.firstName ?? '').trim();
  const last = String(u.lastName ?? '').trim();
  const full = `${first} ${last}`.trim();
  return full ? full : null;
}

function clerkIdFromPlaceholderEmail(email: string): string | null {
  const m = String(email).match(/^(.+?)@placeholder\.local$/i);
  if (!m) return null;
  const id = (m[1] ?? '').trim();
  return id ? id : null;
}

async function main() {
  const secretKey = process.env.CLERK_SECRET_KEY ?? process.env.CLERK_SECRETKEY;
  if (!secretKey) {
    throw new Error('CLERK_SECRET_KEY is not configured in env');
  }

  const prisma = new PrismaClient();
  const clerk = createClerkClient({ secretKey });

  const rows = await prisma.user.findMany({
    where: { email: { endsWith: '@placeholder.local' } },
    select: { id: true, email: true, clerkId: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  let repaired = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const clerkId = row.clerkId ?? clerkIdFromPlaceholderEmail(row.email);
    if (!clerkId) {
      skipped++;
      continue;
    }
    try {
      const u: any = await (clerk as any).users.getUser(clerkId);
      const email = pickEmail(u);
      if (!email) {
        skipped++;
        continue;
      }
      const name = row.name || buildName(u) || undefined;
      await prisma.user.update({
        where: { id: row.id },
        data: { clerkId, email, name },
      });
      repaired++;
    } catch (err) {
      failed++;
      // eslint-disable-next-line no-console
      console.warn('Failed to repair row', row.id, row.email, err);
    }
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ placeholderRows: rows.length, repaired, skipped, failed }, null, 2));

  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

