/**
 * Standalone Brevo backfill (no Redis / Nest). Used when AppModule cannot boot locally.
 */
import { PrismaClient } from '@prisma/client';
import { BrevoClient } from '@getbrevo/brevo';
import * as dotenv from 'dotenv';

dotenv.config();

function isRealEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  return e.includes('@') && !e.endsWith('@placeholder.local');
}

async function main() {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  if (!apiKey) {
    console.error('BREVO_API_KEY missing');
    process.exit(1);
  }
  const listRaw = process.env.BREVO_SIGNUP_LIST_ID?.trim();
  const listId =
    listRaw && Number.isFinite(Number(listRaw)) && Number(listRaw) > 0
      ? Math.floor(Number(listRaw))
      : null;

  const prisma = new PrismaClient();
  const brevo = new BrevoClient({ apiKey, timeoutInSeconds: 30, maxRetries: 2 });

  const users = await prisma.user.findMany({
    where: { brevoSyncedAt: null },
    select: { id: true, email: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  let synced = 0;
  let failed = 0;
  for (const u of users) {
    if (!isRealEmail(u.email)) continue;
    const email = u.email.trim().toLowerCase();
    const parts = (u.name ?? '').trim().split(/\s+/).filter(Boolean);
    try {
      await brevo.contacts.createContact({
        email,
        attributes: {
          FIRSTNAME: parts[0] ?? '',
          LASTNAME: parts.slice(1).join(' '),
        },
        ...(listId ? { listIds: [listId] } : {}),
        updateEnabled: true,
      });
      await prisma.user.update({
        where: { id: u.id },
        data: { brevoSyncedAt: new Date() },
      });
      synced += 1;
      console.log(`[brevo] OK ${email}`);
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[brevo] FAIL ${email}: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  const pending = await prisma.user.count({ where: { brevoSyncedAt: null } });
  console.log(
    `[brevo] done synced=${synced} failed=${failed} total=${users.length} stillPending=${pending}`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
