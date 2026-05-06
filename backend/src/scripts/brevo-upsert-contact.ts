/**
 * One-off: Upsert a Brevo contact (for debugging signup → Brevo sync).
 *
 * Usage (from `backend/`):
 *   BREVO_UPSERT_EMAIL="foo@bar.com" npm run brevo:upsert-contact
 *
 * Notes:
 * - Requires BREVO_API_KEY in env.
 * - This does NOT add to a specific Brevo list; it only upserts the contact record.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { EmailService } from '../email/email.service';

async function main() {
  const email = String(process.env.BREVO_UPSERT_EMAIL ?? '').trim().toLowerCase();
  if (!email) {
    console.error('Set BREVO_UPSERT_EMAIL');
    process.exitCode = 1;
    return;
  }
  const firstName = String(process.env.BREVO_UPSERT_FIRSTNAME ?? '').trim() || undefined;
  const lastName = String(process.env.BREVO_UPSERT_LASTNAME ?? '').trim() || undefined;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const emailService = app.get(EmailService);
    await emailService.addToBrevoList(email, firstName, lastName);
    console.log(`[brevo] attempted upsert for ${email}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

