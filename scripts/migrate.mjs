/**
 * Applies pending database migrations.
 *
 *   npm run db:migrate
 *
 * Idempotent. Safe to run on every deploy.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    console.error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.',
    );
    process.exitCode = 1;
    return;
  }

  const { default: postgres } = await import('postgres');
  const sql = postgres(connectionString, {
    max: 1,
    onnotice: () => {},
    transform: postgres.camel,
  });

  try {
    const dir = path.join(projectRoot, 'db', 'migrations');
    const files = (await readdir(dir))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const applied = new Set(
      (
        await sql`SELECT filename FROM schema_migrations`
      ).map((row) => row.filename),
    );

    let count = 0;
    for (const filename of files) {
      if (applied.has(filename)) {
        console.log(`skip    ${filename} (already applied)`);
        continue;
      }
      const sqlText = await readFile(path.join(dir, filename), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(sqlText);
        await tx`INSERT INTO schema_migrations (filename) VALUES (${filename})`;
      });
      console.log(`applied ${filename}`);
      count += 1;
    }

    console.log(`\nDone. ${count} migration(s) applied, ${files.length} total.`);
  } catch (error) {
    console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();