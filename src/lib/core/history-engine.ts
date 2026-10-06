/**
 * Historical-results engine.
 *
 * Applies the source's `historical_mode` to produce one merged, de-duplicated,
 * correctly-labelled result set.
 *
 *   APP_TRACKED      only application-collected results. This is the mode
 *                    SportyBet forces today, because no vFootball historical
 *                    endpoint exists.
 *   PROVIDER_HISTORY only provider-supplied results, and only if the provider
 *                    actually offers them. Unavailable history yields nothing
 *                    rather than silently falling back.
 *   HYBRID           union of both, de-duplicated on `dedupe_key`, with
 *                    provenance preserved per row.
 *
 * A row collected by this application is never relabelled as provider history,
 * even in HYBRID mode.
 */

import {
  computeHistoryDedupeKey,
  mergeHistoricalRecords,
  type FingerprintInput,
} from './dedupe.ts';
import type {
  HistoricalMode,
  ProviderHistoryPage,
  ResultSource,
} from './types.ts';

export interface HistoryCandidate {
  externalEventId: string | null;
  sportId: string | null;
  leagueId: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  playedAt: Date | null;
  source: ResultSource;
  matchId?: string | null;
}

export interface HistoryResult {
  dedupeKey: string;
  source: ResultSource;
  matchId: string | null;
  externalEventId: string | null;
  sportId: string | null;
  leagueId: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  playedAt: Date | null;
}

export interface HistoryEngineReport {
  mode: HistoricalMode;
  /** The mode actually applied, after clamping to provider capability. */
  effectiveMode: 'APP_TRACKED' | 'PROVIDER_HISTORY' | 'HYBRID';
  results: HistoryResult[];
  appCount: number;
  providerCount: number;
  overlapCount: number;
  conflicts: ReturnType<typeof mergeHistoricalRecords>['conflicts'];
  /** Set when a mode requested provider history the provider cannot supply. */
  providerUnavailableReason: string | null;
  notes: string[];
}

export interface HistoryEngineInput {
  mode: HistoricalMode;
  providerHasHistory: boolean;
  /** Rows already stored with `source = TRACKED_BY_APP`. */
  appCollected: HistoryCandidate[];
  /** Rows already stored with `source = SPORTYBET_HISTORY`. */
  providerStored: HistoryCandidate[];
  /** Fresh provider history, when it was fetched this cycle. */
  providerFetch?: ProviderHistoryPage | null;
  sourceType: string;
}

function fingerprintInputFor(
  sourceType: string,
  candidate: HistoryCandidate,
): FingerprintInput {
  return {
    sourceType,
    sportId: candidate.sportId,
    leagueId: candidate.leagueId,
    homeTeam: candidate.homeTeam,
    awayTeam: candidate.awayTeam,
    scheduledAt: candidate.playedAt,
  };
}

function toKeyed(
  sourceType: string,
  candidate: HistoryCandidate,
): HistoryResult & { dedupeKey: string } {
  const dedupeKey = computeHistoryDedupeKey({
    sourceType,
    sportId: candidate.sportId,
    externalEventId: candidate.externalEventId,
    fingerprint: fingerprintInputFor(sourceType, candidate),
  });

  return {
    dedupeKey,
    source: candidate.source,
    matchId: candidate.matchId ?? null,
    externalEventId: candidate.externalEventId,
    sportId: candidate.sportId,
    leagueId: candidate.leagueId,
    homeTeam: candidate.homeTeam,
    awayTeam: candidate.awayTeam,
    homeScore: candidate.homeScore,
    awayScore: candidate.awayScore,
    playedAt: candidate.playedAt,
  };
}

/**
 * Rejects impossible scorelines before they can reach history. A negative,
 * fractional or absurd goal count means the payload was malformed, and one bad
 * row would poison every derived statistic.
 */
function isPlausibleScore(homeScore: number, awayScore: number): boolean {
  return (
    Number.isInteger(homeScore) &&
    Number.isInteger(awayScore) &&
    homeScore >= 0 &&
    awayScore >= 0 &&
    homeScore <= 99 &&
    awayScore <= 99
  );
}

export function buildHistory(input: HistoryEngineInput): HistoryEngineReport {
  const notes: string[] = [];
  let effectiveMode: HistoryEngineReport['effectiveMode'] =
    input.mode === 'PROVIDER_HISTORY' ? 'PROVIDER_HISTORY' : input.mode;

  const providerReason =
    input.providerFetch?.unavailableReason ??
    (input.providerHasHistory
      ? null
      : 'Provider is not known to expose a usable historical-results feed.');

  if (
    (input.mode === 'PROVIDER_HISTORY' || input.mode === 'HYBRID') &&
    providerReason !== null
  ) {
    notes.push(
      `Mode "${input.mode}" requires provider history but it is unavailable (${providerReason}). Clamping to APP_TRACKED.`,
    );
    effectiveMode = 'APP_TRACKED';
  }

  const appRows = input.appCollected
    .filter((row) => isPlausibleScore(row.homeScore, row.awayScore))
    .map((row) => toKeyed(input.sourceType, row));

  const droppedApp = input.appCollected.length - appRows.length;
  if (droppedApp > 0) {
    notes.push(`Discarded ${droppedApp} stored result(s) with implausible scores.`);
  }

  if (effectiveMode === 'APP_TRACKED') {
    notes.push('Using application-collected history only.');
    return {
      mode: input.mode,
      effectiveMode,
      results: appRows,
      appCount: appRows.length,
      providerCount: 0,
      overlapCount: 0,
      conflicts: [],
      providerUnavailableReason: providerReason,
      notes,
    };
  }

  const fetched = input.providerFetch ?? null;
  const fetchedCandidates: HistoryCandidate[] = (
    fetched?.records ?? []
  ).map((record) => ({
    externalEventId: record.externalEventId,
    sportId: record.sportId,
    leagueId: record.leagueId,
    homeTeam: record.homeTeam,
    awayTeam: record.awayTeam,
    homeScore: record.homeScore,
    awayScore: record.awayScore,
    playedAt: record.playedAt,
    source: 'SPORTYBET_HISTORY' as const,
    matchId: null,
  }));

  const providerRows = [...input.providerStored, ...fetchedCandidates]
    .filter((row) => isPlausibleScore(row.homeScore, row.awayScore))
    .map((row) => toKeyed(input.sourceType, row));

  if (effectiveMode === 'PROVIDER_HISTORY') {
    notes.push('Using provider-supplied history only.');
    return {
      mode: input.mode,
      effectiveMode,
      results: providerRows,
      appCount: 0,
      providerCount: providerRows.length,
      overlapCount: 0,
      conflicts: [],
      providerUnavailableReason: null,
      notes,
    };
  }

  // HYBRID
  notes.push(
    'Merging application-collected and provider history on dedupe_key; provider is authoritative on disagreement.',
  );
  const merge = mergeHistoricalRecords(appRows, providerRows);
  notes.push(`Overlap between the two datasets: ${merge.overlapCount} match(es).`);

  return {
    mode: input.mode,
    effectiveMode,
    results: merge.merged,
    appCount: merge.appCount,
    providerCount: merge.providerCount,
    overlapCount: merge.overlapCount,
    conflicts: merge.conflicts,
    providerUnavailableReason: null,
    notes,
  };
}