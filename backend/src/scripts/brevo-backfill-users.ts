/**
 * One-off: backfill Brevo contacts missing from the signup list (BREVO_SIGNUP_LIST_ID).
 *
 * Usage (from `backend/`):
 *   npm run brevo:backfill-users
 *
 * Optional env:
 *   BREVO_BACKFILL_LIMIT=5000        (batch size per round, default 5000)
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { UsersService } from '../users/users.service';

async function main() {
  const limitRaw = Number(process.env.BREVO_BACKFILL_LIMIT ?? 5000);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(50_000, Math.floor(limitRaw)))
    : 5000;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const usersSvc = app.get(UsersService);

    let totalSynced = 0;
    let rounds = 0;
    const maxRounds = 50;

    while (rounds < maxRounds) {
      const result = await usersSvc.syncPendingBrevoContacts({ limit });
      totalSynced += result.synced;
      rounds += 1;
      console.log(
        `[brevo] round ${rounds}: synced=${result.synced} attempted=${result.attempted} stillPending=${result.pending}`,
      );
      if (result.pending === 0 || result.attempted === 0) break;
    }

    console.log(`[brevo] done. totalSynced=${totalSynced} rounds=${rounds}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
