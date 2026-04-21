/**
 * Point a DB `users` row at your **Clerk Production** user id so live JWTs match the same Postgres row
 * that already holds orders (single-DB, Dev+Prod Clerk split).
 *
 * Mode A — look up Production Clerk by email (needs live secret, do not commit it):
 *   CLERK_SECRET_KEY_PRODUCTION="sk_live_..." npx ts-node -r dotenv/config -r tsconfig-paths/register \
 *     src/scripts/align-user-clerk-from-prod.ts --email=rugby.4.lif3@hotmail.com --execute
 *
 * Mode B — paste Production user id from Clerk Dashboard → Users → your user:
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register \
 *     src/scripts/align-user-clerk-from-prod.ts --email=rugby.4.lif3@hotmail.com --clerk-id=user_XXXXX --execute
 *
 * Omit --execute to print the plan only.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function clerkUsersByEmail(
  secretKey: string,
  email: string,
): Promise<{ id: string }[]> {
  const u = new URL('https://api.clerk.com/v1/users');
  u.searchParams.set('email_address', email.trim());
  u.searchParams.set('limit', '10');
  const res = await fetch(u.toString(), {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clerk API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error('Clerk API: expected array of users');
  }
  return data.map((row: { id?: string }) => ({ id: String(row.id ?? '') })).filter((x) => x.id);
}

function parseArgs(argv: string[]) {
  let email = '';
  let clerkId: string | null = null;
  let execute = false;
  for (const a of argv) {
    if (a === '--execute') execute = true;
    else if (a.startsWith('--email=')) email = a.slice('--email='.length).trim();
    else if (a.startsWith('--clerk-id='))
      clerkId = a.slice('--clerk-id='.length).trim() || null;
  }
  if (!email) {
    throw new Error(
      'Usage: align-user-clerk-from-prod.ts --email=... [--clerk-id=user_xxx] [--execute]',
    );
  }
  return { email, clerkId, execute };
}

async function main() {
  const { email, clerkId: manualClerkId, execute } = parseArgs(
    process.argv.slice(2),
  );
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, email: true, clerkId: true },
  });
  if (!user) {
    throw new Error(`No user with email: ${email}`);
  }

  let newClerkId = manualClerkId?.trim() || '';
  if (!newClerkId) {
    const prodSecret = process.env.CLERK_SECRET_KEY_PRODUCTION?.trim();
    if (!prodSecret || !prodSecret.startsWith('sk_live')) {
      throw new Error(
        'Either pass --clerk-id=user_xxx (from Clerk **Production** dashboard), or set env CLERK_SECRET_KEY_PRODUCTION=sk_live_... (temporary, in shell only) so this script can look up the user by email.',
      );
    }
    const matches = await clerkUsersByEmail(prodSecret, email);
    if (matches.length !== 1) {
      throw new Error(
        `Clerk Production returned ${matches.length} users for that email; fix duplicates in Clerk or use --clerk-id= manually.`,
      );
    }
    newClerkId = matches[0]!.id;
  }

  // eslint-disable-next-line no-console
  console.log('DB user:', user.id, user.email);
  // eslint-disable-next-line no-console
  console.log('Current clerk_id:', user.clerkId);
  // eslint-disable-next-line no-console
  console.log('New clerk_id:   ', newClerkId);

  if (newClerkId === user.clerkId) {
    // eslint-disable-next-line no-console
    console.log('Already aligned. Nothing to do.');
    return;
  }

  if (!execute) {
    // eslint-disable-next-line no-console
    console.log('\nDry run. Re-run with --execute to apply.');
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { clerkId: newClerkId },
  });
  // eslint-disable-next-line no-console
  console.log('Updated. Production sign-in should now hit this DB row.');
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
