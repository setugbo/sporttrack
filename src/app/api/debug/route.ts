import { errorMessage, fail, intParam, isAuthorisedCron, json, stringParam } from '@/lib/api/helpers';
import { buildEventsUrl, resolveSource } from '@/lib/core/url-allowlist';
import { createSportyBetProvider } from '@/lib/core/provider';
import { getSql } from '@/lib/db/client';
import { listPollRuns, listSources } from '@/lib/db/queries';
import { upstreamTimeoutMs } from '@/lib/services/tracker.service';

/**
 * Admin / raw-data view.
 *
 * Shows the exact URL that will be requested, the response excerpt, HTTP and
 * envelope status, and how each event was normalised and classified. Set
 * `DISABLE_DEBUG_SCREEN=1` to turn this route off.
 *
 * No credentials are requested, sent or displayed: the provider feed is
 * unauthenticated, and `poll_runs.raw_excerpt` is redacted at write time.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (process.env.DISABLE_DEBUG_SCREEN === '1') {
    return fail('Debug screen is disabled.', 404);
  }

  if (!isAuthorisedCron(request)) {
    return fail('Unauthorized.', 401);
  }

  const params = new URL(request.url).searchParams;
  const limit = intParam(params, 'limit', 5, 1, 50);
  const probe = params.get('probe') === '1';

  try {
    const sql = getSql();
    const sources = await listSources(sql);
    const sourceId = stringParam(params, 'sourceId');
    const selected = sourceId
      ? sources.find((source) => source.id === sourceId) ?? null
      : (sources[0] ?? null);

    if (!selected) {
      return fail('No source registered. POST to /api/sources first.', 404);
    }

    // The allowlist is re-run here so the displayed request target is derived
    // server-side and cannot be influenced by the query string.
    const descriptor = resolveSource(selected.sourceUrl);
    const upstreamUrl = buildEventsUrl(descriptor);

    const payload = {
      source: {
        id: selected.id,
        name: selected.name,
        status: selected.status,
        historicalMode: selected.historicalMode,
        lastOkAt: selected.lastOkAt,
        lastError: selected.lastError,
      },
      request: {
        pageUrl: descriptor.pageUrl,
        upstreamUrl,
        method: 'POST',
        contentType: 'application/json',
        // The array-wrapped body is mandatory; a bare object returns 403.
        body: [
          {
            sportId: descriptor.sportId,
            withTwoUpMarket: true,
            withOneUpMarket: true,
          },
        ],
        headersSent: { 'Content-Type': 'application/json', Accept: 'application/json' },
        headersRequired: {},
        timeoutMs: upstreamTimeoutMs(),
      },
      recentPolls: await listPollRuns(selected.id, limit, sql),
    };

    if (!probe) {
      return json(payload);
    }

    const provider = createSportyBetProvider();
    const startedAt = Date.now();
    try {
      const snapshot = await provider.fetchEvents(descriptor, {
        timeoutMs: upstreamTimeoutMs(),
      });
      return json({
        ...payload,
        probe: {
          ok: true,
          durationMs: Date.now() - startedAt,
          bizCode: snapshot.bizCode,
          fetchedAt: snapshot.fetchedAt.toISOString(),
          eventCount: snapshot.events.length,
          events: snapshot.events,
          rawExcerpt: snapshot.rawExcerpt,
        },
      });
    } catch (error) {
      return json({
        ...payload,
        probe: {
          ok: false,
          durationMs: Date.now() - startedAt,
          error: errorMessage(error),
        },
      });
    }
  } catch (error) {
    return fail(errorMessage(error), 500);
  }
}