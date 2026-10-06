import { asRecord, errorMessage, fail, isAuthorisedCron, isSameOriginBrowser, json, readJsonBody, stringParam } from '@/lib/api/helpers';
import { isAllowedSourceUrl } from '@/lib/core/url-allowlist';
import { getSql } from '@/lib/db/client';
import { pollAllSources, pollSource, resolveStoredSourceByUrl } from '@/lib/services/tracker.service';

/**
 * Manual and scheduled polling.
 *
 * GET polls every non-paused source and is what Vercel Cron calls.
 * POST polls a single named source, which is what the dashboard button uses.
 *
 * Polling is server-side only: the upstream API sends no CORS headers, so a
 * browser cannot reach it directly, and proxying from the browser would also
 * expose the endpoint.
 */

export const dynamic = 'force-dynamic';
// A full ingest issues several hundred small queries (one per tracked match),
// so the budget is generous rather than tight.
export const maxDuration = 120;

export async function GET(request: Request) {
  if (!isAuthorisedCron(request)) {
    return fail('Unauthorized.', 401);
  }

  try {
    const url = new URL(request.url);
    // Vercel Cron always adds its own ?url= param for path-less cron entries;
    // it is ignored unless it names a specific source.
    const specific = stringParam(url.searchParams, 'url');

    if (specific) {
      const { source, outcome } = await pollByUrl(specific);
      return json({ polled: [{ sourceId: source.id, ...summarise(outcome) }] });
    }

    const results = await pollAllSources();
    return json({
      polled: results.map(({ source, outcome }) => ({
        sourceId: source.id,
        name: source.name,
        ...summarise(outcome),
      })),
      polledAt: new Date().toISOString(),
    });
  } catch (error) {
    return fail(errorMessage(error), 500);
  }
}

export async function POST(request: Request) {
  // Cron may post a single source by URL; the dashboard button posts the same
  // shape from this origin without the cron secret.
  if (!isAuthorisedCron(request) && !isSameOriginBrowser(request)) {
    return fail('Unauthorized.', 401);
  }

  const body = await readJsonBody(request);
  if (!body.ok) return fail(body.message, 415);

  const record = asRecord(body.data);
  const url = typeof record.url === 'string' ? record.url.trim() : null;

  if (!url) {
    return fail('Expected { url: "<allowlisted SportyBet vFootball URL>" }.', 400);
  }

  try {
    const { source, outcome } = await pollByUrl(url);
    return json({ sourceId: source.id, ...summarise(outcome) });
  } catch (error) {
    return fail(errorMessage(error), 400);
  }
}

async function pollByUrl(url: string) {
  if (!isAllowedSourceUrl(url)) {
    throw new Error(
      'That URL is not an allowlisted SportyBet vFootball live-list page, so it cannot be polled.',
    );
  }
  const sql = getSql();
  const { source, descriptor } = await resolveStoredSourceByUrl(url, sql);
  // The allowlisted descriptor wins over the stored copy, so an endpoint
  // change in code takes effect without a database edit.
  const { outcome } = await pollSource(
    { ...source, baseUrl: descriptor.apiBaseUrl },
    { sql },
  );
  return { source, outcome };
}

/** Compact poll summary; the full per-match trace is on /api/debug. */
function summarise(outcome: Awaited<ReturnType<typeof pollSource>>['outcome']) {
  return {
    polledAt: outcome.polledAt.toISOString(),
    throttled: outcome.throttled,
    cached: outcome.cached,
    upstream: {
      url: outcome.upstreamUrl,
      method: outcome.upstreamMethod,
      bizCode: outcome.bizCode,
      httpStatus: outcome.httpStatus,
    },
    eventsSeen: outcome.eventsSeen,
    newMatches: outcome.newMatches,
    updatedMatches: outcome.updatedMatches,
    finishedMatches: outcome.finishedMatches,
    unknownMatches: outcome.unknownMatches,
    resultsWritten: outcome.resultsWritten,
  };
}