import 'server-only';

import type postgres from 'postgres';
import { getSql, type Sql } from './client.ts';
import { computeEventKey } from '../core/dedupe.ts';
import type {
  FinishConfidence,
  FinishReason,
  HistoricalMode,
  MatchStatus,
  SourceDescriptor,
  TrackedMatch,
} from '../core/types.ts';

export type SourceStatus = 'ACTIVE' | 'PAUSED' | 'ERROR';

/**
 * Data access. Every function returns camelCased rows (the `postgres.js`
 * client is configured with `postgres.camel`), so the shapes line up with
 * `core/types.ts` without hand-written row mappers.
 */

export interface SourceRow {
  id: string;
  name: string;
  sourceUrl: string;
  baseUrl: string;
  sourceType: string;
  status: SourceStatus;
  historicalMode: HistoricalMode;
  countryCode: string;
  sportId: string | null;
  lastCheckedAt: Date | null;
  lastOkAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  lastPollAt: Date | null;
  createdAt: Date;
}

export interface TrackingSessionRow {
  id: string;
  sourceId: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
  sourceUrl: string;
  trackAll: boolean;
  startedAt: Date;
  endedAt: Date | null;
  lastPollAt: Date | null;
  pollInterval: number;
  settings: Record<string, unknown>;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export async function listSources(sql: Sql = getSql()): Promise<SourceRow[]> {
  return sql<SourceRow[]>`
    SELECT * FROM sources ORDER BY created_at ASC
  `;
}

export async function getSource(id: string, sql: Sql = getSql()): Promise<SourceRow | null> {
  const rows = await sql<SourceRow[]>`SELECT * FROM sources WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function getSourceByUrl(
  url: string,
  sql: Sql = getSql(),
): Promise<SourceRow | null> {
  const rows = await sql<SourceRow[]>`
    SELECT * FROM sources WHERE source_url = ${url} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function insertSource(
  descriptor: SourceDescriptor,
  sql: Sql = getSql(),
): Promise<SourceRow> {
  const rows = await sql<SourceRow[]>`
    INSERT INTO sources (name, source_url, base_url, country_code, sport_id)
    VALUES (
      ${descriptor.name},
      ${descriptor.pageUrl},
      ${descriptor.apiBaseUrl},
      ${descriptor.countryCode || 'ng'},
      ${descriptor.sportId}
    )
    RETURNING *
  `;
  return rows[0] as SourceRow;
}

export async function updateSourceStatus(
  id: string,
  patch: {
    status?: SourceStatus;
    lastError?: string | null;
    lastCheckedAt?: Date;
    lastOkAt?: Date;
    lastPollAt?: Date;
  },
  sql: Sql = getSql(),
): Promise<void> {
  await sql`
    UPDATE sources SET
      status = COALESCE(${patch.status ?? null}, status),
      last_error = ${patch.lastError ?? null},
      last_checked_at = COALESCE(${patch.lastCheckedAt ?? null}, last_checked_at),
      last_ok_at = COALESCE(${patch.lastOkAt ?? null}, last_ok_at),
      last_poll_at = COALESCE(${patch.lastPollAt ?? null}, last_poll_at)
    WHERE id = ${id}
  `;
}

export async function updateSourceHistoricalMode(
  id: string,
  mode: HistoricalMode,
  sql: Sql = getSql(),
): Promise<void> {
  await sql`UPDATE sources SET historical_mode = ${mode} WHERE id = ${id}`;
}

/** Builds a provider descriptor from a stored source row. */
export function descriptorFromSource(row: SourceRow): SourceDescriptor {
  return {
    provider: 'sportybet',
    name: row.name,
    pageUrl: row.sourceUrl,
    apiBaseUrl: row.baseUrl,
    countryCode: row.countryCode,
    sportId: row.sportId,
    eventsPath: '/factsCenter/wapEvents',
    providerHasHistory: false,
  };
}

// ---------------------------------------------------------------------------
// Tracking sessions
// ---------------------------------------------------------------------------

export async function getActiveSession(
  sourceId: string,
  sql: Sql = getSql(),
): Promise<TrackingSessionRow | null> {
  const rows = await sql<TrackingSessionRow[]>`
    SELECT * FROM tracking_sessions
    WHERE source_id = ${sourceId} AND status IN ('ACTIVE', 'PAUSED')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listSessions(
  sourceId?: string,
  sql: Sql = getSql(),
): Promise<TrackingSessionRow[]> {
  if (sourceId) {
    return sql<TrackingSessionRow[]>`
      SELECT * FROM tracking_sessions WHERE source_id = ${sourceId}
      ORDER BY created_at DESC
    `;
  }
  return sql<TrackingSessionRow[]>`
    SELECT * FROM tracking_sessions ORDER BY created_at DESC
  `;
}

export async function createSession(
  input: {
    sourceId: string;
    name: string;
    sourceUrl: string;
    trackAll: boolean;
    pollInterval: number;
    settings: Record<string, unknown>;
  },
  sql: Sql = getSql(),
): Promise<TrackingSessionRow> {
  // The partial unique index enforces one open session per source; surface a
  // readable error rather than a raw constraint violation.
  const existing = await getActiveSession(input.sourceId, sql);
  if (existing) {
    throw new Error(
      `A session named "${existing.name}" is already open for this source. End it before starting another.`,
    );
  }

  const rows = await sql<TrackingSessionRow[]>`
    INSERT INTO tracking_sessions
      (source_id, name, source_url, track_all, poll_interval, settings)
    VALUES
      (${input.sourceId}, ${input.name}, ${input.sourceUrl},
       ${input.trackAll}, ${input.pollInterval}, ${sql.json(input.settings as postgres.JSONValue)})
    RETURNING *
  `;
  return rows[0] as TrackingSessionRow;
}

export async function endSession(
  id: string,
  sql: Sql = getSql(),
): Promise<TrackingSessionRow | null> {
  const rows = await sql<TrackingSessionRow[]>`
    UPDATE tracking_sessions
    SET status = 'COMPLETED', ended_at = now()
    WHERE id = ${id} AND status <> 'COMPLETED'
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function touchSession(id: string, sql: Sql = getSql()): Promise<void> {
  await sql`
    UPDATE tracking_sessions SET last_poll_at = now() WHERE id = ${id}
  `;
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

function toTrackedMatch(row: Record<string, unknown>): TrackedMatch {
  return {
    id: row.id as string,
    sourceId: row.sourceId as string,
    externalEventId: (row.externalEventId as string | null) ?? null,
    eventKey: row.eventKey as string,
    homeTeam: row.homeTeam as string,
    awayTeam: row.awayTeam as string,
    homeTeamId: (row.homeTeamId as string | null) ?? null,
    awayTeamId: (row.awayTeamId as string | null) ?? null,
    homeScore: (row.homeScore as number | null) ?? null,
    awayScore: (row.awayScore as number | null) ?? null,
    htHomeScore: (row.htHomeScore as number | null) ?? null,
    htAwayScore: (row.htAwayScore as number | null) ?? null,
    status: row.status as MatchStatus,
    clock: (row.clock as string | null) ?? null,
    clockMinute: (row.clockMinute as number | null) ?? null,
    maxClockMinute: (row.maxClockMinute as number | null) ?? null,
    leagueId: (row.leagueId as string | null) ?? null,
    leagueName: (row.leagueName as string | null) ?? null,
    sportId: (row.sportId as string | null) ?? null,
    scheduledAt: (row.scheduledAt as Date | null) ?? null,
    startedAt: (row.startedAt as Date | null) ?? null,
    finishedAt: (row.finishedAt as Date | null) ?? null,
    firstSeenAt: row.firstSeenAt as Date,
    lastSeenAt: row.lastSeenAt as Date,
    absentPolls: (row.absentPolls as number) ?? 0,
    finishReason: (row.finishReason as FinishReason | null) ?? null,
    finishConfidence: (row.finishConfidence as FinishConfidence) ?? 'NONE',
    seenCount: (row.seenCount as number) ?? 0,
  };
}

export async function findMatchByExternalId(
  sourceId: string,
  externalEventId: string,
  sql: Sql = getSql(),
): Promise<TrackedMatch | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM matches
    WHERE source_id = ${sourceId} AND external_event_id = ${externalEventId}
    LIMIT 1
  `;
  return rows[0] ? toTrackedMatch(rows[0]) : null;
}

export async function findMatchByEventKey(
  sourceId: string,
  eventKey: string,
  sql: Sql = getSql(),
): Promise<TrackedMatch | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM matches
    WHERE source_id = ${sourceId} AND event_key = ${eventKey}
    LIMIT 1
  `;
  return rows[0] ? toTrackedMatch(rows[0]) : null;
}

export interface NewMatchInput {
  sourceId: string;
  externalEventId: string | null;
  eventKey: string;
  sportId: string | null;
  leagueId: string | null;
  leagueName: string | null;
  homeTeam: string;
  awayTeam: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  scheduledAt: Date | null;
  status: MatchStatus;
}

export async function insertMatch(input: NewMatchInput, sql: Sql = getSql()): Promise<TrackedMatch> {
  const rows = await sql<Record<string, unknown>[]>`
    INSERT INTO matches (
      source_id, external_event_id, event_key, sport_id, league_id, league_name,
      home_team, away_team, home_team_id, away_team_id,
      scheduled_at, status, seen_count, last_seen_at
    )
    VALUES (
      ${input.sourceId}, ${input.externalEventId}, ${input.eventKey}, ${input.sportId},
      ${input.leagueId}, ${input.leagueName}, ${input.homeTeam}, ${input.awayTeam},
      ${input.homeTeamId}, ${input.awayTeamId}, ${input.scheduledAt}, ${input.status},
      1, now()
    )
    RETURNING *
  `;
  return toTrackedMatch(rows[0] as Record<string, unknown>);
}

export interface MatchUpdate {
  homeScore: number | null;
  awayScore: number | null;
  htHomeScore: number | null;
  htAwayScore: number | null;
  status: MatchStatus;
  clock: string | null;
  clockMinute: number | null;
  maxClockMinute: number | null;
  absentPolls: number;
  seenCount: number;
  finishReason: FinishReason | null;
  finishConfidence: FinishConfidence;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastSeenAt: Date | null;
  leagueId: string | null;
  leagueName: string | null;
}

export async function updateMatch(id: string, patch: MatchUpdate, sql: Sql = getSql()): Promise<void> {
  await sql`
    UPDATE matches SET
      home_score = ${patch.homeScore},
      away_score = ${patch.awayScore},
      ht_home_score = ${patch.htHomeScore},
      ht_away_score = ${patch.htAwayScore},
      status = ${patch.status},
      clock = ${patch.clock},
      clock_minute = ${patch.clockMinute},
      max_clock_minute = ${patch.maxClockMinute},
      absent_polls = ${patch.absentPolls},
      seen_count = ${patch.seenCount},
      finish_reason = ${patch.finishReason},
      finish_confidence = ${patch.finishConfidence},
      started_at = COALESCE(started_at, ${patch.startedAt}),
      finished_at = ${patch.finishedAt},
      last_seen_at = COALESCE(${patch.lastSeenAt}, last_seen_at),
      league_id = COALESCE(${patch.leagueId}, league_id),
      league_name = COALESCE(${patch.leagueName}, league_name)
    WHERE id = ${id}
  `;
}

/**
 * Matches still eligible for completion detection.
 *
 * Deliberately has no staleness window. A row whose `last_seen_at` is older
 * than any window (a polling gap, a paused source) must keep flowing through
 * absence detection, or it would sit LIVE forever with a frozen
 * `absent_polls`. Closing a row that fell off the feed is the state machine's
 * job — UNKNOWN or FINISHED after `maxAbsentPolls` — not a query filter's.
 */
export async function listOpenMatches(
  sourceId: string,
  sql: Sql = getSql(),
): Promise<TrackedMatch[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM matches
    WHERE source_id = ${sourceId}
      -- UNKNOWN is a decided outcome (no further evidence can change it), so
      -- only still-open lifecycles are re-examined on each poll.
      AND status IN ('DISCOVERED', 'LIVE')
    ORDER BY last_seen_at DESC
  `;
  return rows.map(toTrackedMatch);
}

export async function listActiveMatches(
  sourceId: string,
  limit = 100,
  sql: Sql = getSql(),
): Promise<TrackedMatch[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM matches
    WHERE source_id = ${sourceId} AND status IN ('DISCOVERED', 'LIVE')
    ORDER BY scheduled_at DESC NULLS LAST, last_seen_at DESC
    LIMIT ${limit}
  `;
  return rows.map(toTrackedMatch);
}

export async function getMatch(id: string, sql: Sql = getSql()): Promise<TrackedMatch | null> {
  const rows = await sql<Record<string, unknown>[]>`SELECT * FROM matches WHERE id = ${id}`;
  return rows[0] ? toTrackedMatch(rows[0]) : null;
}

export async function listSnapshots(
  matchId: string,
  limit = 100,
  sql: Sql = getSql(),
): Promise<
  Array<{
    id: number;
    homeScore: number;
    awayScore: number;
    clock: string | null;
    clockMinute: number | null;
    status: MatchStatus;
    capturedAt: Date;
  }>
> {
  return sql`
    SELECT id, home_score, away_score, clock, clock_minute, status, captured_at
    FROM match_snapshots
    WHERE match_id = ${matchId}
    ORDER BY clock_minute ASC NULLS LAST, captured_at ASC
    LIMIT ${limit}
  `;
}

export async function insertSnapshot(
  input: {
    matchId: string;
    homeScore: number;
    awayScore: number;
    clock: string | null;
    clockMinute: number | null;
    status: MatchStatus;
  },
  sql: Sql = getSql(),
): Promise<void> {
  // The unique constraint on (match_id, clock_minute, home_score, away_score)
  // collapses repeated identical states, so this is safe to call every poll.
  await sql`
    INSERT INTO match_snapshots
      (match_id, home_score, away_score, clock, clock_minute, status)
    VALUES
      (${input.matchId}, ${input.homeScore}, ${input.awayScore},
       ${input.clock}, ${input.clockMinute}, ${input.status})
    ON CONFLICT ON CONSTRAINT match_snapshots_dedupe_key DO NOTHING
  `;
}

// ---------------------------------------------------------------------------
// Tracking targets
// ---------------------------------------------------------------------------

export async function addTarget(
  sessionId: string,
  matchId: string,
  sql: Sql = getSql(),
): Promise<void> {
  await sql`
    INSERT INTO tracking_targets (tracking_session_id, match_id)
    VALUES (${sessionId}, ${matchId})
    ON CONFLICT ON CONSTRAINT tracking_targets_unique DO NOTHING
  `;
}

export async function listTargetMatchIds(
  sessionId: string,
  sql: Sql = getSql(),
): Promise<string[]> {
  const rows = await sql<{ matchId: string }[]>`
    SELECT match_id FROM tracking_targets
    WHERE tracking_session_id = ${sessionId} AND status = 'ACTIVE'
  `;
  return rows.map((row) => row.matchId);
}

// ---------------------------------------------------------------------------
// Historical results
// ---------------------------------------------------------------------------

export interface InsertResultInput {
  matchId: string | null;
  sourceId: string;
  externalEventId: string | null;
  dedupeKey: string;
  source: 'SPORTYBET_HISTORY' | 'TRACKED_BY_APP';
  homeTeam: string;
  awayTeam: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  homeScore: number;
  awayScore: number;
  leagueId: string | null;
  leagueName: string | null;
  playedAt: Date | null;
  trackingSessionId: string | null;
  finishReason: string | null;
  finishConfidence: string | null;
}

/** Returns true when a row was inserted, false when the dedupe key already existed. */
export async function insertHistoricalResult(
  input: InsertResultInput,
  sql: Sql = getSql(),
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO historical_results (
      match_id, source_id, external_event_id, dedupe_key, source,
      home_team, away_team, home_team_id, away_team_id,
      home_score, away_score, league_id, league_name, played_at,
      tracking_session_id, finish_reason, finish_confidence
    )
    VALUES (
      ${input.matchId}, ${input.sourceId}, ${input.externalEventId}, ${input.dedupeKey}, ${input.source},
      ${input.homeTeam}, ${input.awayTeam}, ${input.homeTeamId}, ${input.awayTeamId},
      ${input.homeScore}, ${input.awayScore}, ${input.leagueId}, ${input.leagueName}, ${input.playedAt},
      ${input.trackingSessionId}, ${input.finishReason}, ${input.finishConfidence}
    )
    ON CONFLICT ON CONSTRAINT historical_results_dedupe_key_unique DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}

export interface HistoricalResultQuery {
  sourceId?: string;
  homeTeam?: string;
  awayTeam?: string;
  leagueId?: string;
  source?: 'SPORTYBET_HISTORY' | 'TRACKED_BY_APP';
  limit?: number;
  offset?: number;
  since?: Date | null;
}

export async function queryHistoricalResults(
  query: HistoricalResultQuery,
  sql: Sql = getSql(),
): Promise<
  Array<{
    id: string;
    matchId: string | null;
    sourceId: string;
    externalEventId: string | null;
    dedupeKey: string;
    source: 'SPORTYBET_HISTORY' | 'TRACKED_BY_APP';
    homeTeam: string;
    awayTeam: string;
    homeScore: number;
    awayScore: number;
    leagueId: string | null;
    leagueName: string | null;
    playedAt: Date | null;
    capturedAt: Date;
    trackingSessionId: string | null;
    finishReason: string | null;
    finishConfidence: string | null;
  }>
> {
  const limit = Math.min(query.limit ?? 100, 500);
  const offset = query.offset ?? 0;

  return sql`
    SELECT * FROM historical_results
    WHERE (${query.sourceId ?? null}::uuid IS NULL OR source_id = ${query.sourceId ?? null})
      AND (${query.homeTeam ?? null}::text IS NULL OR home_team = ${query.homeTeam ?? null})
      AND (${query.awayTeam ?? null}::text IS NULL OR away_team = ${query.awayTeam ?? null})
      AND (${query.leagueId ?? null}::text IS NULL OR league_id = ${query.leagueId ?? null})
      AND (${query.source ?? null}::result_source IS NULL OR source = ${query.source ?? null})
      AND (${query.since ?? null}::timestamptz IS NULL OR played_at >= ${query.since ?? null})
    ORDER BY played_at DESC NULLS LAST, captured_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function countHistoricalResults(
  query: HistoricalResultQuery,
  sql: Sql = getSql(),
): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM historical_results
    WHERE (${query.sourceId ?? null}::uuid IS NULL OR source_id = ${query.sourceId ?? null})
      AND (${query.homeTeam ?? null}::text IS NULL OR home_team = ${query.homeTeam ?? null})
      AND (${query.awayTeam ?? null}::text IS NULL OR away_team = ${query.awayTeam ?? null})
      AND (${query.leagueId ?? null}::text IS NULL OR league_id = ${query.leagueId ?? null})
      AND (${query.source ?? null}::result_source IS NULL OR source = ${query.source ?? null})
      AND (${query.since ?? null}::timestamptz IS NULL OR played_at >= ${query.since ?? null})
  `;
  return rows[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Poll runs
// ---------------------------------------------------------------------------

export interface PollRunInput {
  sourceId: string | null;
  requestedUrl: string | null;
  upstreamUrl: string | null;
  upstreamMethod: string | null;
  httpStatus: number | null;
  bizCode: number | null;
  ok: boolean;
  error: string | null;
  durationMs: number | null;
  matchesFound: number;
  liveCount: number;
  completedCount: number;
  unknownCount: number;
  newMatches: number;
  rawExcerpt: string | null;
  responseAt: Date | null;
}

export async function insertPollRun(input: PollRunInput, sql: Sql = getSql()): Promise<void> {
  await sql`
    INSERT INTO poll_runs (
      source_id, requested_url, upstream_url, upstream_method, http_status, biz_code,
      ok, error, duration_ms, matches_found, live_count, completed_count,
      unknown_count, new_matches, raw_excerpt, response_at
    )
    VALUES (
      ${input.sourceId}, ${input.requestedUrl}, ${input.upstreamUrl}, ${input.upstreamMethod},
      ${input.httpStatus}, ${input.bizCode}, ${input.ok}, ${input.error}, ${input.durationMs},
      ${input.matchesFound}, ${input.liveCount}, ${input.completedCount},
      ${input.unknownCount}, ${input.newMatches}, ${input.rawExcerpt}, ${input.responseAt}
    )
  `;
}

export async function listPollRuns(
  sourceId: string | null,
  limit = 25,
  sql: Sql = getSql(),
): Promise<Array<Record<string, unknown>>> {
  return sql`
    SELECT
      id, source_id, requested_url, upstream_url, upstream_method, http_status, biz_code,
      ok, error, duration_ms, matches_found, live_count, completed_count,
      unknown_count, new_matches, raw_excerpt, response_at, created_at
    FROM poll_runs
    WHERE (${sourceId}::uuid IS NULL OR source_id = ${sourceId})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

export { computeEventKey };