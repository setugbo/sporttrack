import { errorMessage, fail, intParam, json, stringParam } from '@/lib/api/helpers';
import { getSql } from '@/lib/db/client';
import {
  getMatch,
  listActiveMatches,
  listSnapshots,
  listSources,
} from '@/lib/db/queries';

/**
 * Live and upcoming matches, plus a single match's score progression.
 * `status` is read from the URL path search params.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const sourceId = stringParam(params, 'sourceId');
  const matchId = stringParam(params, 'matchId');
  const status = stringParam(params, 'status');
  const limit = intParam(params, 'limit', 100, 1, 500);

  try {
    const sql = getSql();

    if (matchId) {
      const match = await getMatch(matchId, sql);
      if (!match) return fail('No match with that id.', 404);
      const snapshots = await listSnapshots(matchId, limit, sql);
      return json({ match, snapshots });
    }

    const sources = sourceId
      ? (await listSources(sql)).filter((source) => source.id === sourceId)
      : await listSources(sql);

    if (sources.length === 0) {
      return fail('No source registered. POST to /api/sources first.', 404);
    }

    const byStatus: Record<string, unknown[]> = {
      live: [],
      upcoming: [],
      finished: [],
      unknown: [],
    };

    for (const source of sources) {
      const active = await listActiveMatches(source.id, limit, sql);
      for (const match of active) {
        if (match.status === 'LIVE') byStatus.live?.push(match);
        else byStatus.upcoming?.push(match);
      }
    }

    // Status filtering for terminal states needs its own query because
    // `listActiveMatches` intentionally excludes them.
    if (status === 'finished' || status === 'unknown') {
      const filter = sourceId ?? null;
      const rows = await sql<Record<string, unknown>[]>`
        SELECT * FROM matches
        WHERE (${filter}::uuid IS NULL OR source_id = ${filter})
          AND status = ${status.toUpperCase()}
        ORDER BY COALESCE(finished_at, last_seen_at) DESC
        LIMIT ${limit}
      `;
      const key = status === 'finished' ? 'finished' : 'unknown';
      byStatus[key] = [...rows];
    }

    return json(byStatus);
  } catch (error) {
    return fail(errorMessage(error), 500);
  }
}