import { errorMessage, fail, json, stringParam } from '@/lib/api/helpers';
import { getSql } from '@/lib/db/client';
import { getSource, getSourceByUrl, listSources } from '@/lib/db/queries';
import { getAnalysis } from '@/lib/services/analysis.service';

/**
 * Descriptive statistics over collected history. Purely retrospective counts;
 * the response contains no forecast or recommendation.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const url = stringParam(params, 'url');
  const sourceId = stringParam(params, 'sourceId');
  const homeTeam = stringParam(params, 'homeTeam');
  const awayTeam = stringParam(params, 'awayTeam');

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

    return json(await getAnalysis(resolved, { homeTeam, awayTeam, sql }));
  } catch (error) {
    return fail(errorMessage(error), 500);
  }
}