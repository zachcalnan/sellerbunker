/**
 * One-off: backfill Brevo contacts (and optionally a list) from existing users.
 *
 * Usage (from `backend/`):
 *   BREVO_SIGNUP_LIST_ID=123 npm run brevo:backfill-users
 *
 * Optional env:
 *   BREVO_BACKFILL_LIMIT=5000        (default 5000)
 *   BREVO_BACKFILL_SINCE_DAYS=14     (only users created within last N days; omit for all)
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';

async function main() {
  const limitRaw = Number(process.env.BREVO_BACKFILL_LIMIT ?? 5000);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50_000, Math.floor(limitRaw))) : 5000;
  const sinceDaysRaw = process.env.BREVO_BACKFILL_SINCE_DAYS != null ? Number(process.env.BREVO_BACKFILL_SINCE_DAYS) : null;
  const sinceDays =
    sinceDaysRaw != null && Number.isFinite(sinceDaysRaw)
      ? Math.max(1, Math.min(3650, Math.floor(sinceDaysRaw)))
      : null;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const prisma = app.get(PrismaService);
    const emailSvc = app.get(EmailService);

    const where =
      sinceDays != null
        ? { createdAt: { gte: new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000) } }
        : {};

    const users = await prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { email: true, name: true, createdAt: true },
    });

    if (!users.length) {
      console.log('[brevo] no users to backfill');
      return;
    }

    let ok = 0;
    for (const u of users) {
      await emailSvc.addToBrevoList(u.email, u.name ?? undefined);
      ok += 1;
      if (ok % 50 === 0) {
        console.log(`[brevo] backfilled ${ok}/${users.length}`);
      }
      // Gentle pacing to avoid bursting (Brevo limits vary by plan).
      await new Promise((r) => setTimeout(r, 150));
    }
    console.log(`[brevo] done. attempted=${ok}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

