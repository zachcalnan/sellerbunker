import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
import { join } from 'path';

function csvEscape(v: string): string {
  const s = v ?? '';
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function splitName(fullNameRaw: string | null | undefined): {
  firstName: string;
  lastName: string;
} {
  const full = String(fullNameRaw ?? '').trim();
  if (!full) return { firstName: '', lastName: '' };
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      select: { email: true, name: true },
      orderBy: { createdAt: 'asc' },
    });

    const lines: string[] = [];
    lines.push(['email', 'first_name', 'last_name'].join(','));

    const isTestName = (nameRaw: string | null | undefined) => {
      const n = String(nameRaw ?? '').trim().toLowerCase();
      return n === 'test' || n.startsWith('test ');
    };

    const filtered = users.filter((u) => {
      const email = String(u.email ?? '').trim().toLowerCase();
      if (!email || !email.includes('@')) return false;
      if (email.endsWith('@placeholder.local')) return false;
      if (isTestName(u.name)) return false;
      return true;
    });

    for (const u of filtered) {
      const { firstName, lastName } = splitName(u.name);
      lines.push(
        [u.email, firstName, lastName].map((x) => csvEscape(String(x ?? ''))).join(','),
      );
    }

    const outPath = join(process.cwd(), 'users-brevo.csv');
    writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
    // eslint-disable-next-line no-console
    console.log(`Wrote ${filtered.length} users to ${outPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

