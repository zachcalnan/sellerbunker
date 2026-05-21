/**
 * Copy LWA_CLIENT_ID / LWA_CLIENT_SECRET from env into every active seller_accounts.credentials JSON.
 * Run after Amazon secret rotation so DB snapshots match env (optional once env override is deployed).
 *
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register src/scripts/refresh-lwa-secrets-in-db.ts
 */
import { PrismaService } from '../prisma/prisma.service';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';

async function main() {
  const envId = process.env.LWA_CLIENT_ID?.trim() ?? '';
  const envSecret = process.env.LWA_CLIENT_SECRET?.trim() ?? '';
  if (!envId || !envSecret) {
    console.error('Set LWA_CLIENT_ID and LWA_CLIENT_SECRET in backend/.env first.');
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const rows = await prisma.sellerAccount.findMany({
      where: { marketplace: 'amazon', isActive: true },
      select: { id: true, userId: true, credentials: true },
    });
    let updated = 0;
    for (const row of rows) {
      const c =
        row.credentials && typeof row.credentials === 'object'
          ? { ...(row.credentials as Record<string, unknown>) }
          : {};
      if (c.lwaClientId === envId && c.lwaClientSecret === envSecret) continue;
      c.lwaClientId = envId;
      c.lwaClientSecret = envSecret;
      await prisma.sellerAccount.update({
        where: { id: row.id },
        data: { credentials: c as object },
      });
      updated += 1;
      console.log(`updated userId=${row.userId.slice(0, 8)}…`);
    }
    console.log(`done: ${updated}/${rows.length} account(s) patched`);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
