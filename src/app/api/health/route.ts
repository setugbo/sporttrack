import { json } from '@/lib/api/helpers';
import { checkDatabase } from '@/lib/db/client';
import { listSources } from '@/lib/db/queries';
import { listActiveMatches } from '@/lib/db/queries';
import { countHistoricalResults } from '@/lib/db/queries';

/**
 * Liveness and configuration read-out. Deliberately reveals no secrets: it
 * reports only whether each variable is present.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const database = await checkDatabase();

  let sources: Array<{
    id: string;
    name: string;
    status: string;
    lastPollAt: Date | null;
    liveCount: number | null;
    historyCount: number | null;
  }> = [];
  let databaseError: string | null = null;

  if (database.ok) {
    try {
      const rows = await listSources();
      sources = await Promise.all(
        rows.map(async (source) => ({
          id: source.id,
          name: source.name,
          status: source.status,
          lastPollAt: source.lastPollAt,
          liveCount: (await listActiveMatches(source.id, 200)).length,
          historyCount: await countHistoricalResults({ sourceId: source.id }),
        })),
      );
    } catch (error) {
      databaseError = error instanceof Error ? error.message : String(error);
    }
  }

  return json({
    status: database.ok && !databaseError ? 'ok' : 'degraded',
    checkedAt: new Date().toISOString(),
    database: {
      reachable: database.ok || Boolean(databaseError),
      migrated: database.ok,
      tables: database.migrations,
      error: databaseError ?? database.error,
    },
    config: {
      databaseUrlPresent: Boolean(process.env.DATABASE_URL?.trim()),
      cronSecretPresent: Boolean(process.env.CRON_SECRET?.trim()),
      defaultPollInterval: process.env.DEFAULT_POLL_INTERVAL ?? '30',
      debugScreenEnabled: process.env.DISABLE_DEBUG_SCREEN !== '1',
    },
    sources,
  });
}