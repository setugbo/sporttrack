import 'server-only';

import { classifyMatch } from '../core/state-machine.ts';
import { computeEventKey, computeHistoryDedupeKey } from '../core/dedupe.ts';
import {
  DEFAULT_COMPLETION_SETTINGS,
  type CompletionSettings,
  type PollIngestResult,
  type ProviderEvent,
  type ProviderSnapshot,
  type SourceDescriptor,
  type TrackedMatch,
} from '../core/types.ts';
import { getSql, type Sql } from '../db/client.ts';
import {
  descriptorFromSource,
  findMatchByEventKey,
  findMatchByExternalId,
  insertHistoricalResult,
  insertMatch,
  insertPollRun,
  insertSnapshot,
  listActiveMatches,
  listOpenMatches,
  listTargetMatchIds,
  touchSession,
  updateMatch,
  updateSourceStatus,
  type SourceRow,
  type TrackingSessionRow,
} from '../db/queries.ts';

/**
 * Poll -> normalise -> classify -> persist.
 *
 * Ordering matters. A poll that fails upstream must leave every stored match
 * untouched, in particular `absent_polls`, because completion detection treats
 * absence as evidence. Counting a failed request as an observation would let a
 * brief upstream outage manufacture finished results.
 */

export interface PollOptions {
  source: SourceRow;
  session: TrackingSessionRow | null;
  descriptor: SourceDescriptor;
  timeoutMs?: number;
  now?: Date;
}

export interface PollOutcome extends PollIngestResult {
  /** Per-match reasoning trace, shown on the debug screen. */
  traces: Array<{
    matchId: string;
    externalEventId: string | null;
    homeTeam: string;
    awayTeam: string;
    fromStatus: TrackedMatch['status'];
    toStatus: TrackedMatch['status'];
    finishReason: string | null;
    notes: string[];
  }>;
  upstreamUrl: string;
  upstreamMethod: string;
  httpStatus: number | null;
  bizCode: number | null;
  rawExcerpt: string;
  /** True when the poll was skipped because it ran too soon after the last. */
  throttled: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function resolveSettings(session: TrackingSessionRow | null): CompletionSettings {
  const raw = session?.settings ?? {};
  return {
    regulationMinutes:
      typeof raw.regulationMinutes === 'number'
        ? raw.regulationMinutes
        : DEFAULT_COMPLETION_SETTINGS.regulationMinutes,
    highConfidenceClockMinutes:
      typeof raw.highConfidenceClockMinutes === 'number'
        ? raw.highConfidenceClockMinutes
        : DEFAULT_COMPLETION_SETTINGS.highConfidenceClockMinutes,
    confirmAbsentPolls:
      typeof raw.confirmAbsentPolls === 'number'
        ? raw.confirmAbsentPolls
        : DEFAULT_COMPLETION_SETTINGS.confirmAbsentPolls,
    maxAbsentPolls:
      typeof raw.maxAbsentPolls === 'number'
        ? raw.maxAbsentPolls
        : DEFAULT_COMPLETION_SETTINGS.maxAbsentPolls,
  };
}

/**
 * Throttles to the session's configured interval. Cron may fire more often
 * than the provider actually refreshes, and hitting upstream needlessly both
 * wastes requests and makes absence counters jump by more than one per poll.
 */
export function shouldSkipPoll(
  session: TrackingSessionRow | null,
  source: SourceRow,
  now: Date,
): boolean {
  const reference = session?.lastPollAt ?? source.lastPollAt;
  if (!reference) return false;
  const intervalSeconds = session?.pollInterval ?? 30;
  const elapsed = (now.getTime() - new Date(reference).getTime()) / 1000;
  return elapsed < intervalSeconds;
}

function fingerprintFor(source: SourceRow, event: ProviderEvent) {
  return {
    sourceType: source.sourceType,
    sportId: event.sportId,
    leagueId: event.leagueId,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    scheduledAt: event.scheduledAt,
  };
}

async function locateMatch(
  source: SourceRow,
  event: ProviderEvent,
  eventKey: string,
  sql: Sql,
): Promise<TrackedMatch | null> {
  // The provider event id is authoritative. The fingerprint is only consulted
  // when it is missing, which is what keeps de-duplication cheap and exact.
  if (event.externalEventId) {
    const byId = await findMatchByExternalId(source.id, event.externalEventId, sql);
    if (byId) return byId;
  }
  return findMatchByEventKey(source.id, eventKey, sql);
}

async function writeHistoryForFinishedMatch(
  source: SourceRow,
  session: TrackingSessionRow | null,
  match: TrackedMatch,
  snapshot: {
    homeScore: number | null;
    awayScore: number | null;
    finishReason: string | null;
    finishConfidence: string;
  },
  sql: Sql,
): Promise<boolean> {
  if (snapshot.homeScore === null || snapshot.awayScore === null) {
    return false;
  }

  const dedupeKey = computeHistoryDedupeKey({
    sourceType: source.sourceType,
    sportId: match.sportId,
    externalEventId: match.externalEventId,
    fingerprint: {
      sourceType: source.sourceType,
      sportId: match.sportId,
      leagueId: match.leagueId,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      scheduledAt: match.scheduledAt,
    },
  });

  return insertHistoricalResult(
    {
      matchId: match.id,
      sourceId: source.id,
      externalEventId: match.externalEventId,
      dedupeKey,
      // Always TRACKED_BY_APP: the provider supplied no terminal result.
      source: 'TRACKED_BY_APP',
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      homeTeamId: match.homeTeamId,
      awayTeamId: match.awayTeamId,
      homeScore: snapshot.homeScore,
      awayScore: snapshot.awayScore,
      leagueId: match.leagueId,
      leagueName: match.leagueName,
      playedAt: match.scheduledAt ?? match.finishedAt ?? null,
      trackingSessionId: session?.id ?? null,
      finishReason: snapshot.finishReason,
      finishConfidence: snapshot.finishConfidence,
    },
    sql,
  );
}

/**
 * Applies an already-fetched snapshot to the database.
 *
 * Exported separately from `runPoll` so the ingest path can be tested with a
 * recorded snapshot and no network.
 */
export async function ingestSnapshot(
  snapshot: ProviderSnapshot,
  options: PollOptions,
  meta: {
    upstreamUrl: string;
    upstreamMethod: string;
    httpStatus: number | null;
  },
  sql: Sql = getSql(),
): Promise<PollOutcome> {
  const now = options.now ?? new Date();
  const settings = resolveSettings(options.session);
  const traces: PollOutcome['traces'] = [];

  let newMatches = 0;
  let updatedMatches = 0;
  let finishedMatches = 0;
  let unknownMatches = 0;
  let resultsWritten = 0;
  let liveCount = 0;

  // Which matches the session is responsible for. `track_all` sessions follow
  // everything; otherwise only hand-picked targets are processed, which stops a
  // session from silently ingesting thousands of unrequested events.
  const targetMatchIds = options.session
    ? await listTargetMatchIds(options.session.id, sql)
    : [];
  const targetSet = new Set(targetMatchIds);

  const seenMatchIds = new Set<string>();

  for (const event of snapshot.events) {
    const eventKey = computeEventKey(fingerprintFor(options.source, event));
    let match = await locateMatch(options.source, event, eventKey, sql);
    let isNew = false;

    if (!match) {
      // In a targeted session, an untracked event is only recorded when the
      // session follows everything. Otherwise it is skipped entirely.
      if (options.session && !options.session.trackAll) {
        continue;
      }
      match = await insertMatch(
        {
          sourceId: options.source.id,
          externalEventId: event.externalEventId,
          eventKey,
          sportId: event.sportId,
          leagueId: event.leagueId,
          leagueName: event.leagueName,
          homeTeam: event.homeTeam,
          awayTeam: event.awayTeam,
          homeTeamId: event.homeTeamId,
          awayTeamId: event.awayTeamId,
          scheduledAt: event.scheduledAt,
          status: 'DISCOVERED',
        },
        sql,
      );
      isNew = true;
      newMatches += 1;
    }

    if (options.session && !options.session.trackAll && !targetSet.has(match.id)) {
      continue;
    }

    seenMatchIds.add(match.id);

    const fromStatus = match.status;
    const result = classifyMatch({
      match,
      observation: event,
      settings,
      now,
    });

    await updateMatch(
      match.id,
      {
        homeScore: result.homeScore,
        awayScore: result.awayScore,
        htHomeScore: match.htHomeScore,
        htAwayScore: match.htAwayScore,
        status: result.status,
        clock: result.clock,
        clockMinute: result.clockMinute,
        maxClockMinute: result.maxClockMinute,
        absentPolls: result.absentPolls,
        seenCount: result.seenCount,
        finishReason: result.finishReason,
        finishConfidence: result.finishConfidence,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        lastSeenAt: now,
        leagueId: event.leagueId,
        leagueName: event.leagueName,
      },
      sql,
    );

    if (!isNew) updatedMatches += 1;

    if (
      result.writeSnapshot &&
      result.homeScore !== null &&
      result.awayScore !== null
    ) {
      await insertSnapshot(
        {
          matchId: match.id,
          homeScore: result.homeScore,
          awayScore: result.awayScore,
          clock: result.clock,
          clockMinute: result.clockMinute,
          status: result.status,
        },
        sql,
      );
    }

    if (result.writeHistory) {
      const written = await writeHistoryForFinishedMatch(
        options.source,
        options.session,
        match,
        {
          homeScore: result.homeScore,
          awayScore: result.awayScore,
          finishReason: result.finishReason,
          finishConfidence: result.finishConfidence,
        },
        sql,
      );
      if (written) resultsWritten += 1;
    }

    if (result.status === 'LIVE') liveCount += 1;
    if (result.status === 'FINISHED') finishedMatches += 1;
    if (result.status === 'UNKNOWN') unknownMatches += 1;

    traces.push({
      matchId: match.id,
      externalEventId: match.externalEventId,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      fromStatus,
      toStatus: result.status,
      finishReason: result.finishReason,
      notes: result.notes,
    });
  }

  // -------------------------------------------------------------------------
  // Absence detection.
  //
  // Only open matches that this session follows and that were NOT seen in this
  // successful poll are advanced. A failed poll never reaches this code path,
  // which is what keeps a transient outage from fabricating completions.
  // -------------------------------------------------------------------------
  const openMatches = await listOpenMatches(options.source.id, {}, sql);
  for (const match of openMatches) {
    if (seenMatchIds.has(match.id)) continue;
    if (options.session && !options.session.trackAll && !targetSet.has(match.id)) {
      continue;
    }

    const fromStatus = match.status;
    const result = classifyMatch({ match, observation: null, settings, now });

    await updateMatch(
      match.id,
      {
        homeScore: result.homeScore,
        awayScore: result.awayScore,
        htHomeScore: match.htHomeScore,
        htAwayScore: match.htAwayScore,
        status: result.status,
        clock: result.clock,
        clockMinute: result.clockMinute,
        maxClockMinute: result.maxClockMinute,
        absentPolls: result.absentPolls,
        seenCount: result.seenCount,
        finishReason: result.finishReason,
        finishConfidence: result.finishConfidence,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        lastSeenAt: match.lastSeenAt,
        leagueId: match.leagueId,
        leagueName: match.leagueName,
      },
      sql,
    );

    if (result.writeHistory) {
      const written = await writeHistoryForFinishedMatch(
        options.source,
        options.session,
        match,
        {
          homeScore: result.homeScore,
          awayScore: result.awayScore,
          finishReason: result.finishReason,
          finishConfidence: result.finishConfidence,
        },
        sql,
      );
      if (written) resultsWritten += 1;
    }

    if (result.status === 'FINISHED') finishedMatches += 1;
    if (result.status === 'UNKNOWN') unknownMatches += 1;

    traces.push({
      matchId: match.id,
      externalEventId: match.externalEventId,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      fromStatus,
      toStatus: result.status,
      finishReason: result.finishReason,
      notes: result.notes,
    });
  }

  await insertPollRun(
    {
      sourceId: options.source.id,
      requestedUrl: options.descriptor.pageUrl,
      upstreamUrl: meta.upstreamUrl,
      upstreamMethod: meta.upstreamMethod,
      httpStatus: meta.httpStatus,
      bizCode: snapshot.bizCode,
      ok: true,
      error: null,
      durationMs: null,
      matchesFound: snapshot.events.length,
      liveCount,
      completedCount: finishedMatches,
      unknownCount: unknownMatches,
      newMatches,
      rawExcerpt: snapshot.rawExcerpt,
      responseAt: snapshot.fetchedAt,
    },
    sql,
  );

  await updateSourceStatus(
    options.source.id,
    {
      status: 'ACTIVE',
      lastError: null,
      lastCheckedAt: now,
      lastOkAt: now,
      lastPollAt: now,
    },
    sql,
  );

  if (options.session) {
    await touchSession(options.session.id, sql);
  }

  return {
    polledAt: now,
    eventsSeen: snapshot.events.length,
    newMatches,
    updatedMatches,
    finishedMatches,
    unknownMatches,
    resultsWritten,
    cached: false,
    traces,
    upstreamUrl: meta.upstreamUrl,
    upstreamMethod: meta.upstreamMethod,
    httpStatus: meta.httpStatus,
    bizCode: snapshot.bizCode,
    rawExcerpt: snapshot.rawExcerpt,
    throttled: false,
  };
}

/**
 * Full poll cycle: fetch upstream, then ingest. Upstream failures are recorded
 * in `poll_runs` and surfaced to the source row, but never mutate match state.
 */
export async function runPoll(
  provider: {
    fetchEvents(
      descriptor: SourceDescriptor,
      options: { timeoutMs: number; signal?: AbortSignal },
    ): Promise<ProviderSnapshot>;
  },
  options: PollOptions,
  sql: Sql = getSql(),
): Promise<PollOutcome> {
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const upstreamUrl = `${options.descriptor.apiBaseUrl}${options.descriptor.eventsPath}`;
  const startedAt = Date.now();

  if (shouldSkipPoll(options.session, options.source, now)) {
    return {
      polledAt: now,
      eventsSeen: 0,
      newMatches: 0,
      updatedMatches: 0,
      finishedMatches: 0,
      unknownMatches: 0,
      resultsWritten: 0,
      cached: true,
      traces: [],
      upstreamUrl,
      upstreamMethod: 'POST',
      httpStatus: null,
      bizCode: null,
      rawExcerpt: '',
      throttled: true,
    };
  }

  try {
    const snapshot = await provider.fetchEvents(options.descriptor, { timeoutMs });
    const durationMs = Date.now() - startedAt;

    const outcome = await ingestSnapshot(
      snapshot,
      { ...options, now },
      { upstreamUrl, upstreamMethod: 'POST', httpStatus: 200 },
      sql,
    );

    await sql`
      UPDATE poll_runs SET duration_ms = ${durationMs}
      WHERE id = (
        SELECT id FROM poll_runs WHERE source_id = ${options.source.id}
        ORDER BY id DESC LIMIT 1
      )
    `;

    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startedAt;

    await insertPollRun(
      {
        sourceId: options.source.id,
        requestedUrl: options.descriptor.pageUrl,
        upstreamUrl,
        upstreamMethod: 'POST',
        httpStatus: null,
        bizCode: null,
        ok: false,
        error: message,
        durationMs,
        matchesFound: 0,
        liveCount: 0,
        completedCount: 0,
        unknownCount: 0,
        newMatches: 0,
        rawExcerpt: null,
        responseAt: null,
      },
      sql,
    );

    await updateSourceStatus(
      options.source.id,
      {
        status: 'ERROR',
        lastError: message,
        lastCheckedAt: now,
      },
      sql,
    );

    return {
      polledAt: now,
      eventsSeen: 0,
      newMatches: 0,
      updatedMatches: 0,
      finishedMatches: 0,
      unknownMatches: 0,
      resultsWritten: 0,
      cached: false,
      traces: [],
      upstreamUrl,
      upstreamMethod: 'POST',
      httpStatus: null,
      bizCode: null,
      rawExcerpt: '',
      throttled: false,
    };
  }
}

export { descriptorFromSource, listActiveMatches };