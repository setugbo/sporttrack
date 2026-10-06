/**
 * Match-provider abstraction.
 *
 * All SportyBet-specific knowledge is confined to `sportybet-provider.ts`.
 * Callers depend on the `MatchProvider` interface from `core/types.ts`.
 */

import {
  resolveSource,
  type UrlNotAllowedError,
} from './url-allowlist.ts';
import type {
  MatchProvider,
  ProviderEvent,
  ProviderHistoryPage,
  ProviderHistoryRecord,
  ProviderSnapshot,
  SourceDescriptor,
} from './types.ts';

export { resolveSource, isAllowedSourceUrl, UrlNotAllowedError, buildEventsUrl } from './url-allowlist.ts';

/** Statuses that mean the match has left play and reached a terminal state. */
const TERMINAL_MATCH_STATUSES = new Set([
  'FT',
  'FINISHED',
  'ENDED',
  'END',
  'FULLTIME',
  'FULL-TIME',
  'AET',
  'PEN',
  'COMPLETED',
  'SETTLED',
  'FINISHED_AWD',
]);

/** Statuses that mean the fixture was cancelled or postponed. */
const VOID_MATCH_STATUSES = new Set([
  'CANCELLED',
  'CANCELED',
  'POSTPONED',
  'SUSPENDED',
  'ABANDONED',
]);

/**
 * Request body for SportyBet's live feed. The array wrapper and the JSON
 * content type are both mandatory: a bare object or a form-encoded body is
 * rejected with 403/500.
 */
interface WapEventsRequestBody {
  sportId: string;
  withTwoUpMarket: boolean;
  withOneUpMarket: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function asInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/** Pulls the first defined value out of a list of candidate field names. */
function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}

function pickString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  return asString(pick(record, ...keys));
}

function pickInteger(
  record: Record<string, unknown>,
  ...keys: string[]
): number | null {
  return asInteger(pick(record, ...keys));
}

/**
 * Parses upstream timestamps. SportyBet sends `estimateStartTime` as a
 * 13-digit epoch-milliseconds number; passing a numeric-looking string to
 * `new Date(...)` yields an Invalid Date that later explodes on `.toISOString()`.
 */
function asDate(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value);
  }
  const raw = asString(value);
  if (!raw) return null;
  if (/^-?\d{10,13}$/.test(raw)) return new Date(Number(raw));
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Parses the "H1:H2" score strings SportyBet sends in `setScore`. */
function parseColonScore(value: unknown): { home: number; away: number } | null {
  const raw = asString(value);
  if (!raw) return null;
  const match = /^(\d{1,3})\s*[:\-]\s*(\d{1,3})$/.exec(raw);
  if (!match) return null;
  return {
    home: Number.parseInt(match[1] as string, 10),
    away: Number.parseInt(match[2] as string, 10),
  };
}

/**
 * `gameScore` is an array of per-half score strings, e.g. `["2:0","1:1"]`,
 * whose first element is the half-time score and whose sum equals `setScore`.
 */
function parseHalfScores(value: unknown): { home: number; away: number } | null {
  if (!Array.isArray(value)) return null;
  return parseColonScore(value[0]);
}

/**
 * SportyBet sends vFootball leagues as a nested object map. It has been observed
 * as both an array of objects and a plain object keyed by league id.
 */
function normalizeLeagueContainer(value: unknown): {
  leagueId: string | null;
  leagueName: string | null;
} {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const name = pickString(entry, 'tournamentName', 'name', 'title');
      const id = pickString(entry, 'tournamentId', 'id');
      if (name || id) {
        return { leagueId: id, leagueName: name };
      }
    }
    return { leagueId: null, leagueName: null };
  }

  if (isRecord(value)) {
    // The container may already be the league object itself...
    const ownName = pickString(value, 'tournamentName', 'name', 'title');
    if (ownName) {
      return {
        leagueId: pickString(value, 'tournamentId', 'id'),
        leagueName: ownName,
      };
    }

    // ...or a map keyed by league id, e.g. { "lg1": { tournamentName: ... } }.
    for (const [key, entry] of Object.entries(value)) {
      if (isRecord(entry)) {
        const name = pickString(entry, 'tournamentName', 'name', 'title');
        if (name) {
          return { leagueId: pickString(entry, 'tournamentId', 'id') ?? key, leagueName: name };
        }
      }
    }
    return { leagueId: null, leagueName: null };
  }

  return { leagueId: null, leagueName: null };
}

/** `sports` is an array; the category lives under `sport.category.tournament`. */
function normalizeLeague(event: Record<string, unknown>): {
  leagueId: string | null;
  leagueName: string | null;
} {
  const sports = pick(event, 'sports');
  const sportEntry = Array.isArray(sports)
    ? sports.find(isRecord)
    : isRecord(sports)
      ? sports
      : null;

  if (!sportEntry) {
    return normalizeLeagueContainer(pick(event, 'category', 'tournament'));
  }

  const category = pick(sportEntry, 'category', 'tournament');
  const nested = normalizeLeagueContainer(category);
  if (nested.leagueName) {
    return nested;
  }

  return {
    leagueId: pickString(sportEntry, 'categoryId', 'tournamentId'),
    leagueName: pickString(sportEntry, 'categoryName', 'tournamentName'),
  };
}

/**
 * Normalises `playedSeconds`, which arrives as either a number of seconds
 * (5400) or a colon-delimited clock string ("88:00" / "45+2").
 * Returns the display string and the whole-minute floor.
 */
export function normalizeClock(
  playedSeconds: unknown,
  rawClock: unknown,
): { clock: string | null; clockMinute: number | null } {
  const totalSeconds = asInteger(playedSeconds);

  if (totalSeconds !== null && totalSeconds >= 0) {
    const minutes = Math.floor(totalSeconds / 60);
    return { clock: `${minutes}:00`, clockMinute: minutes };
  }

  // The SportyBet feed sends the clock in `playedSeconds` as "73:00", so a
  // colon string must be accepted from either field.
  const asClockString = asString(rawClock) ?? asString(playedSeconds);

  if (asClockString) {
    const withStoppage = /^(\d{1,3})\s*\+\s*(\d{1,2})$/.exec(asClockString);
    if (withStoppage) {
      return {
        clock: asClockString,
        clockMinute: Number.parseInt(withStoppage[1] as string, 10),
      };
    }
    const colon = /^(\d{1,3}):(\d{2})$/.exec(asClockString);
    if (colon) {
      return {
        clock: asClockString,
        clockMinute: Number.parseInt(colon[1] as string, 10),
      };
    }
    const bare = /^(\d{1,3})$/.exec(asClockString);
    if (bare) {
      return { clock: asClockString, clockMinute: Number.parseInt(bare[1] as string, 10) };
    }
  }

  return { clock: null, clockMinute: null };
}

/**
 * Maps provider status onto the application's lifecycle.
 *
 * SportyBet's vFootball feed only ever reports status 0 ("Not start") and
 * status 1 ("H2"); it never publishes a terminal state. See
 * docs/sportybet-integration.md sections 4 and 6.
 */
export function mapProviderStatus(
  rawStatus: string | null,
  rawMatchStatus: string | null,
): 'DISCOVERED' | 'LIVE' | 'FINISHED' | 'CANCELLED' {
  const label = (rawMatchStatus ?? '').trim().toUpperCase();
  const code = (rawStatus ?? '').trim();

  if (label && TERMINAL_MATCH_STATUSES.has(label)) {
    return 'FINISHED';
  }
  if (label && VOID_MATCH_STATUSES.has(label)) {
    return 'CANCELLED';
  }

  // SportyBet: status "1" means in-play, "0" means scheduled.
  if (code === '1') {
    return 'LIVE';
  }
  if (code === '0') {
    return 'DISCOVERED';
  }

  if (label.startsWith('H') && /^\d/.test(label)) {
    return 'LIVE';
  }
  if (label.startsWith('H')) {
    return 'LIVE';
  }
  if (label === 'NOT START' || label === 'SCHEDULED') {
    return 'DISCOVERED';
  }

  // Unknown label: treat as live only when a clock is already running, which
  // the caller decides. Returning LIVE here would create false history.
  return 'DISCOVERED';
}

/** Converts one raw event object into the provider-neutral shape. */
export function normalizeProviderEvent(
  raw: Record<string, unknown>,
  fallbackSportId: string | null,
): ProviderEvent | null {
  const externalEventId = pickString(raw, 'eventId', 'eventID', 'id');
  const homeTeam =
    pickString(raw, 'homeTeam', 'home', 'homeName', 'homeTeamName') ?? '';
  const awayTeam =
    pickString(raw, 'awayTeam', 'away', 'awayName', 'awayTeamName') ?? '';

  if (!homeTeam || !awayTeam || homeTeam === awayTeam) {
    // Without two distinct named teams the row cannot be matched against
    // history later, so it is discarded rather than stored ambiguously.
    return null;
  }

  const { clock, clockMinute } = normalizeClock(
    pick(raw, 'playedSeconds', 'elapsedSeconds'),
    pick(raw, 'matchTime', 'clock', 'time'),
  );

  const league = normalizeLeague(raw);

  const totalScore = parseColonScore(pick(raw, 'setScore', 'score', 'totalScore'));
  const halfScore = parseHalfScores(raw.gameScore);

  return {
    externalEventId,
    sportId: pickString(raw, 'sportId', 'sportID') ?? fallbackSportId,
    leagueId: league.leagueId,
    leagueName: league.leagueName,
    homeTeam,
    awayTeam,
    homeTeamId: pickString(raw, 'homeTeamId', 'homeId'),
    awayTeamId: pickString(raw, 'awayTeamId', 'awayId'),
    homeScore:
      pickInteger(raw, 'homeScore', 'homePoint', 'hScore') ?? totalScore?.home ?? null,
    awayScore:
      pickInteger(raw, 'awayScore', 'awayPoint', 'aScore') ?? totalScore?.away ?? null,
    htHomeScore: pickInteger(raw, 'htHomeScore', 'firstHalfHome') ?? halfScore?.home ?? null,
    htAwayScore: pickInteger(raw, 'htAwayScore', 'firstHalfAway') ?? halfScore?.away ?? null,
    rawStatus: pickString(raw, 'status'),
    rawMatchStatus: pickString(raw, 'matchStatus'),
    clock,
    clockMinute,
    scheduledAt: asDate(pick(raw, 'estimateStartTime', 'startTime', 'scheduledAt')),
    raw,
  };
}

/**
 * SportyBet wraps payloads as `{ bizCode, message, data }`; older shapes used
 * `code`. A non-10000 value means the request was rejected even though HTTP
 * returned 200, so it must never be mistaken for a successful poll.
 */
export function extractBizCode(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  return asInteger(payload.bizCode) ?? asInteger(payload.code);
}

/** Walks an unknown payload looking for an array of event-like objects. */
function findEventArray(payload: unknown): unknown[] | null {
  const containers = [
    'events',
    'list',
    'items',
    'data',
    'result',
  ];

  const queue: unknown[] = [payload];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined || seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      if (node.length === 0) return [];
      const looksLikeEvents = node.some(
        (entry) => isRecord(entry) && ('eventId' in entry || 'homeTeam' in entry),
      );
      if (looksLikeEvents) return node;
      queue.push(...node);
      continue;
    }

    if (isRecord(node)) {
      for (const key of containers) {
        if (key in node) queue.push(node[key]);
      }
      for (const value of Object.values(node)) {
        if (isRecord(value) || Array.isArray(value)) queue.push(value);
      }
    }
  }

  return null;
}

/** Redacts anything that could carry a token before logging/display. */
function redactForExcerpt(value: string): string {
  return value
    .replace(/("?(?:token|authorization|cookie|password|secret)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [REDACTED]');
}

const EXCERPT_LIMIT = 4000;

export class SportyBetProvider implements MatchProvider {
  readonly key = 'sportybet';

  resolve(url: string): SourceDescriptor {
    return resolveSource(url);
  }

  async fetchEvents(
    descriptor: SourceDescriptor,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ProviderSnapshot> {
    if (!descriptor.sportId) {
      throw new Error(
        `Source descriptor for ${descriptor.pageUrl} has no sportId; cannot build the feed request.`,
      );
    }

    const body: WapEventsRequestBody[] = [
      {
        sportId: descriptor.sportId,
        withTwoUpMarket: true,
        withOneUpMarket: true,
      },
    ];

    const upstreamUrl = `${descriptor.apiBaseUrl}${descriptor.eventsPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const external = options.signal;
    const onAbort = () => controller.abort();
    external?.addEventListener('abort', onAbort);

    try {
      const response = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: controller.signal,
      });

      const text = await response.text();
      const rawExcerpt = redactForExcerpt(text).slice(0, EXCERPT_LIMIT);

      if (!response.ok) {
        throw new Error(
          `SportyBet feed returned HTTP ${response.status} for ${upstreamUrl}. Body: ${rawExcerpt.slice(0, 500)}`,
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(
          `SportyBet feed returned non-JSON content for ${upstreamUrl}. Body: ${rawExcerpt.slice(0, 500)}`,
        );
      }

      const bizCode = extractBizCode(payload);
      // 10000 is SportyBet's success envelope code.
      if (bizCode !== null && bizCode !== 10000) {
        throw new Error(
          `SportyBet feed returned envelope code ${bizCode} for ${upstreamUrl}. Body: ${rawExcerpt.slice(0, 500)}`,
        );
      }

      const eventArray = findEventArray(payload) ?? [];
      const events: ProviderEvent[] = [];
      for (const entry of eventArray) {
        if (!isRecord(entry)) continue;
        const normalized = normalizeProviderEvent(entry, descriptor.sportId);
        if (normalized) events.push(normalized);
      }

      return {
        provider: this.key,
        fetchedAt: new Date(),
        events,
        bizCode,
        rawExcerpt,
      };
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * SportyBet exposes no usable vFootball historical endpoint (verified across
   * several candidate paths, all returning empty or error envelopes), and the
   * live feed never reports a terminal state. This is therefore always
   * unavailable, which is what keeps the app in APP_TRACKED mode.
   */
  async fetchHistoricalResults(
    _descriptor: SourceDescriptor,
    _options: { since?: Date | null; timeoutMs: number; signal?: AbortSignal },
  ): Promise<ProviderHistoryPage> {
    return {
      records: [] as ProviderHistoryRecord[],
      unavailableReason:
        'NO_HISTORY_ENDPOINT: SportyBet publishes no vFootball historical-results endpoint. History is application-collected.',
    };
  }
}

export function createSportyBetProvider(): MatchProvider {
  return new SportyBetProvider();
}