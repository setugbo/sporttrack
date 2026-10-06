import { errorMessage, fail, intParam, json, stringParam } from '@/lib/api/helpers';
import { getSql } from '@/lib/db/client';
import { getSource, getSourceByUrl, listSources } from '@/lib/db/queries';
import { getHistory } from '@/lib/services/history.service';
import type { ResultSource } from '@/lib/core/types';

/**
 * Historical results, merged per the source's historical mode and labelled with
 * the provenance of each row.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const url = stringParam(params, 'url');
  const sourceId = stringParam(params, 'sourceId');
  const homeTeam = stringParam(params, 'homeTeam');
  const awayTeam = stringParam(params, 'awayTeam');
  const leagueId = stringParam(params, 'leagueId');
  const source = stringParam(params, 'source');
  const limit = intParam(params, 'limit', 100, 1, 500);
  const offset = intParam(params, 'offset', 0, 0, 100_000);

  if (source !== undefined && !['SPORTYBET_HISTORY', 'TRACKED_BY_APP'].includes(source)) {
    return fail('source must be SPORTYBET_HISTORY or TRACKED_BY_APP.', 400);
  }

  try {
    const sql = getSql();

    let resolved = null;
    if (url) {
      resolved = await getSourceByUrl(url, sql);
    } else if (sourceId) {
      resolved = await getSource(sourceId, sql);
    } else {
      const all = await listSources(sql);
      resolved = all[0] ?? null;
    }

    if (!resolved) {
      return fail('No source registered. POST to /api/sources first.', 404);
    }

    const history = await getHistory(
      resolved,
      {
        homeTeam,
        awayTeam,
        leagueId,
        source: source as ResultSource | undefined,
        limit,
        offset,
      },
      { fetchProviderHistory: true, sql },
    );

    return json(history);
  } catch (error) {
    return fail(errorMessage(error), 500);
  }
}