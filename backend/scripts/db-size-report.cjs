const { PrismaClient } = require("@prisma/client");
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const prisma = new PrismaClient();

async function main() {
  const dbRows = await prisma.$queryRawUnsafe(
    `SELECT pg_database_size(current_database())::bigint AS bytes`,
  );
  const dbBytes = Number(dbRows[0].bytes);

  const tblRows = await prisma.$queryRawUnsafe(`
    SELECT c.relname AS table_name, pg_total_relation_size(c.oid)::bigint AS bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY bytes DESC
  `);

  const userCount = await prisma.user.count();
  const orgCount = await prisma.organization.count();

  const out = {
    databaseTotalBytes: dbBytes,
    databaseTotalGb: Number((dbBytes / 1024 ** 3).toFixed(6)),
    userCount,
    orgCount,
    naiveAverageBytesPerUser: userCount ? Math.round(dbBytes / userCount) : null,
    naiveAverageGbPerUser: userCount
      ? Number((dbBytes / userCount / 1024 ** 3).toFixed(6))
      : null,
    note:
      "naiveAverage divides total DB (indexes + table data + all tenants) by user count; org-shared rows are not split per user.",
    tables: tblRows.map((r) => ({
      table: r.table_name,
      bytes: Number(r.bytes),
      gb: Number((Number(r.bytes) / 1024 ** 3).toFixed(6)),
    })),
  };

  console.log(JSON.stringify(out, null, 2));
}

main()
  .catch((e) => {
    console.error("QUERY_FAILED", e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
