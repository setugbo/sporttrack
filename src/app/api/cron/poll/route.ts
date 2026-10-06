import { errorMessage, fail, isAuthorisedCron, json } from '@/lib/api/helpers';
import { pollAllSources } from '@/lib/services/tracker.service';

/**
 * Cron-friendly poll endpoint.
 *
 * Kept separate from /api/poll so the Vercel `crons` entry and any external
 * scheduler hit a stable, purpose-built path. Idempotent and safe to call more
 * often than the configured interval: the poller self-throttles.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handler(request: Request) {
  if (!isAuthorisedCron(request)) {
    return fail('Unauthorized. Set the Authorization header to Bearer $CRON_SECRET.', 401);
  }

  try {
    const results = await pollAllSources();

    return json({
      ok: true,
      polledAt: new Date().toISOString(),
      summary: {
        sources: results.length,
        eventsSeen: results.reduce((sum, r) => sum + r.outcome.eventsSeen, 0),
        newMatches: results.reduce((sum, r) => sum + r.outcome.newMatches, 0),
        finishedMatches: results.reduce((sum, r) => sum + r.outcome.finishedMatches, 0),
        unknownMatches: results.reduce((sum, r) => sum + r.outcome.unknownMatches, 0),
        resultsWritten: results.reduce((sum, r) => sum + r.outcome.resultsWritten, 0),
        throttledSources: results.filter((r) => r.outcome.throttled).length,
      },
      sources: results.map(({ source, outcome }) => ({
        sourceId: source.id,
        name: source.name,
        throttled: outcome.throttled,
        eventsSeen: outcome.eventsSeen,
        newMatches: outcome.newMatches,
        finishedMatches: outcome.finishedMatches,
        unknownMatches: outcome.unknownMatches,
        resultsWritten: outcome.resultsWritten,
        upstream: outcome.upstreamUrl,
        bizCode: outcome.bizCode,
      })),
    });
  } catch (error) {
    return fail(errorMessage(error), 500);
  }
}

export const GET = handler;
export const POST = handler;