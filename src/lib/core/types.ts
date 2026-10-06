/**
 * Domain types shared by the provider layer, the tracker, the history engine
 * and the API surface.
 *
 * Nothing in `core/` imports Next.js, React or the database driver: these are
 * pure types plus pure functions so they can be unit-tested in isolation and
 * reused from the CLI poller.
 */

/** Match lifecycle. Mirrors the `match_status` Postgres enum. */
export type MatchStatus =
  | 'DISCOVERED'
  | 'LIVE'
  | 'FINISHED'
  | 'CANCELLED'
  | 'UNKNOWN';

/** Provenance of a historical result row. */
export type ResultSource = 'SPORTYBET_HISTORY' | 'TRACKED_BY_APP';

/** How strong the evidence was for a FINISHED determination. */
export type FinishConfidence = 'DEFINITIVE' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

/** Which historical pipeline feeds a source. */
export type HistoricalMode = 'PROVIDER_HISTORY' | 'APP_TRACKED' | 'HYBRID';

/** Why a match was classified as finished. */
export type FinishReason =
  | 'TERMINAL_STATUS'
  | 'REGULATION_CLOCK_REACHED'
  | 'DISAPPEARED_AFTER_LATE_CLOCK'
  | 'PROVIDER_CANCELLED';

/** Per-session completion-detection thresholds. */
export interface CompletionSettings {
  /** Match minute at which a match is treated as fully played (90 + stoppage). */
  regulationMinutes: number;
  /**
   * Minimum match minute at disappearance time for the disappearance to count
   * as evidence of completion. Below this the result is UNKNOWN, because the
   * provider's feed is a rolling window and a match can leave it by ageing out.
   */
  highConfidenceClockMinutes: number;
  /** Consecutive *successful* polls without a sighting required to act. */
  confirmAbsentPolls: number;
  /** Consecutive successful polls before a never-started match is UNKNOWN. */
  maxAbsentPolls: number;
}

export const DEFAULT_COMPLETION_SETTINGS: CompletionSettings = {
  regulationMinutes: 90,
  highConfidenceClockMinutes: 88,
  confirmAbsentPolls: 2,
  maxAbsentPolls: 6,
};

/** A source descriptor resolved from an allowlisted URL. */
export interface SourceDescriptor {
  /** Provider key, e.g. `sportybet`. */
  provider: string;
  /** Display name for the `sources` table. */
  name: string;
  /** Canonical page URL this source tracks. */
  pageUrl: string;
  /** API root the provider derives its endpoints from. */
  apiBaseUrl: string;
  countryCode: string;
  sportId: string | null;
  /** Endpoint path for the live/scheduled feed. */
  eventsPath: string;
  /** True when the provider is known to expose usable historical results. */
  providerHasHistory: boolean;
}

/** A single event exactly as the provider reported it, before normalisation. */
export interface ProviderEvent {
  externalEventId: string | null;
  sportId: string | null;
  leagueId: string | null;
  leagueName: string | null;
  homeTeam: string;
  awayTeam: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  /** Running score. Null for scheduled events. */
  homeScore: number | null;
  awayScore: number | null;
  /** Half-time split when the provider supplies it. */
  htHomeScore: number | null;
  htAwayScore: number | null;
  /** Raw provider status code (SportyBet: 0 = scheduled, 1 = in play). */
  rawStatus: string | null;
  /** Human-readable provider status ("Not start", "H2", "FT", ...). */
  rawMatchStatus: string | null;
  /** Match clock, e.g. "88:00". */
  clock: string | null;
  clockMinute: number | null;
  scheduledAt: Date | null;
  /** Opaque provider payload fields kept for the debug view. */
  raw: Record<string, unknown>;
}

/** One poll's worth of provider data. */
export interface ProviderSnapshot {
  provider: string;
  fetchedAt: Date;
  events: ProviderEvent[];
  /** Envelope `bizCode`; 10000 means success for SportyBet. */
  bizCode: number | null;
  /** Trimmed body excerpt for the debug screen (no credentials). */
  rawExcerpt: string;
}

/** Provider-reported finished result, used only in hybrid mode. */
export interface ProviderHistoryRecord {
  externalEventId: string | null;
  sportId: string | null;
  leagueId: string | null;
  leagueName: string | null;
  homeTeam: string;
  awayTeam: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  homeScore: number;
  awayScore: number;
  playedAt: Date | null;
}

export interface ProviderHistoryPage {
  records: ProviderHistoryRecord[];
  /**
   * Why no history was returned. `null` when the provider did return rows.
   * SportyBet currently returns `NO_HISTORY_ENDPOINT`.
   */
  unavailableReason: string | null;
}

/**
 * Everything upstream-specific lives behind this interface. If the endpoint,
 * sport id or field names change, only the implementation changes.
 */
export interface MatchProvider {
  readonly key: string;
  /** Allowlist + descriptor derivation. Throws `UrlNotAllowedError`. */
  resolve(url: string): SourceDescriptor;
  fetchEvents(
    descriptor: SourceDescriptor,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ProviderSnapshot>;
  fetchHistoricalResults(
    descriptor: SourceDescriptor,
    options: { since?: Date | null; timeoutMs: number; signal?: AbortSignal },
  ): Promise<ProviderHistoryPage>;
}

/** A match row as the tracker needs it, independent of storage. */
export interface TrackedMatch {
  id: string;
  sourceId: string;
  externalEventId: string | null;
  eventKey: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  homeScore: number | null;
  awayScore: number | null;
  htHomeScore: number | null;
  htAwayScore: number | null;
  status: MatchStatus;
  clock: string | null;
  clockMinute: number | null;
  /** Highest whole minute ever observed for this match. */
  maxClockMinute: number | null;
  leagueId: string | null;
  leagueName: string | null;
  sportId: string | null;
  scheduledAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  absentPolls: number;
  finishReason: FinishReason | null;
  finishConfidence: FinishConfidence;
  seenCount: number;
}

/** Outcome of classifying one event against a stored match. */
export interface MatchObservation {
  matchId: string;
  status: MatchStatus;
  /** True when this poll changed stored state. */
  changed: boolean;
  /** True when the snapshot row should be written. */
  snapshotChanged: boolean;
  finishedNow: boolean;
}

export interface PollIngestResult {
  polledAt: Date;
  eventsSeen: number;
  newMatches: number;
  updatedMatches: number;
  finishedMatches: number;
  unknownMatches: number;
  resultsWritten: number;
  /** True when the poll was served from cache instead of hitting upstream. */
  cached: boolean;
}

/** Rows are returned to the API as plain JSON. */
export interface HistoricalResultRow {
  id: string;
  matchId: string | null;
  sourceId: string;
  externalEventId: string | null;
  source: ResultSource;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  leagueId: string | null;
  leagueName: string | null;
  playedAt: string | null;
  capturedAt: string;
  trackingSessionId: string | null;
  finishReason: FinishReason | null;
  finishConfidence: FinishConfidence | null;
}

export interface TeamStatistics {
  team: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  avgGoalsScored: number;
  avgGoalsConceded: number;
  avgTotalGoals: number;
  over15: number;
  over25: number;
  btts: number;
  cleanSheets: number;
  failedToScore: number;
  /** Percentage values, 0-100, one decimal place. */
  winRate: number;
  drawRate: number;
  lossRate: number;
  over15Rate: number;
  over25Rate: number;
  bttsRate: number;
  cleanSheetRate: number;
}