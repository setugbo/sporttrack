import 'server-only';

import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Database access.
 *
 * `postgres.js` in serverless mode (one connection per invocation, no pool),
 * which is the correct shape for Vercel and Neon. The client is cached on
 * `globalThis` so Next's dev-server hot reload does not open a new connection
 * on every module evaluation.
 */

export type Sql = ReturnType<typeof postgres>;

declare global {
  // eslint-disable-next-line no-var
  var __vfSql: Sql | undefined;
}

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and fill in your PostgreSQL connection string.',
    );
  }
  return url.trim();
}

export function getSql(): Sql {
  if (globalThis.__vfSql) return globalThis.__vfSql;

  const sql = postgres(connectionString(), {
    // Serverless: a short-lived connection is cheaper than a pool that the
    // platform will freeze anyway.
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    // Never risk logging credentials in a query trace.
    debug: false,
    onnotice: () => {},
    transform: postgres.camel,
    // Serverless platforms terminate connections aggressively; retry transient
    // failures rather than turning a blip into a failed poll.
    max_lifetime: 60 * 30,
  });

  globalThis.__vfSql = sql;
  return sql;
}

export async function closeSql(): Promise<void> {
  const sql = globalThis.__vfSql;
  if (!sql) return;
  globalThis.__vfSql = undefined;
  await sql.end({ timeout: 5 });
}

/** Absolute path to the migrations directory, resolved from the repo root. */
export function migrationsDir(): string {
  return path.join(process.cwd(), 'db', 'migrations');
}

/**
 * Applies every `.sql` file in lexicographic order, tracking which have run in
 * a `schema_migrations` table. Idempotent, so it is safe to call on boot and
 * from `npm run db:migrate`.
 */
export async function runMigrations(sql: Sql = getSql()): Promise<string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `;

  const applied = new Set(
    (
      await sql<{ filename: string }[]>`
        SELECT filename FROM schema_migrations
      `
    ).map((row) => row.filename),
  );

  const dir = migrationsDir();
  let files: string[];
  try {
    const { readdir } = await import('node:fs/promises');
    files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  } catch {
    throw new Error(
      `Could not read migrations directory at ${dir}. Migrations are read from the filesystem, so the CLI migrator must run from the project root.`,
    );
  }

  const ran: string[] = [];

  for (const filename of files) {
    if (applied.has(filename)) continue;

    const sqlText = await readFile(path.join(dir, filename), 'utf8');
    // Each migration runs in its own transaction so a failure leaves the
    // database on the last good version instead of a half-applied state.
    await sql.begin(async (tx) => {
      await tx.unsafe(sqlText);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${filename})`;
    });
    ran.push(filename);
  }

  return ran;
}

/** True when the schema is present and the app can start serving requests. */
export async function checkDatabase(): Promise<{
  ok: boolean;
  migrations: string[];
  error: string | null;
}> {
  try {
    const sql = getSql();
    await sql`SELECT 1`;
    const rows = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'sources', 'tracking_sessions', 'matches', 'match_snapshots',
          'historical_results', 'tracking_targets', 'poll_runs'
        )
    `;
    return { ok: rows.length === 7, migrations: rows.map((r) => r.tablename), error: null };
  } catch (error) {
    return {
      ok: false,
      migrations: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}