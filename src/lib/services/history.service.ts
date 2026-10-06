import 'server-only';

import { buildHistory, type HistoryCandidate } from '../core/history-engine.ts';
import type { HistoricalResultRow, ResultSource } from '../core/types.ts';
import { getSql, type Sql } from '../db/client.ts';
import {
  descriptorFromSource,
  queryHistoricalResults,
  type HistoricalResultQuery,
  type SourceRow,
} from '../db/queries.ts';
import { createSportyBetProvider } from '../core/provider.ts';

/**
 * Reads history for a source, applying the source's `historical_mode`.
 *
 * For SportyBet the mode is effectively always APP_TRACKED, because
 * `fetchHistoricalResults` reports that no usable endpoint exists. The hybrid
 * path is fully implemented so that enabling a real provider history feed is a
 * configuration change rather than a code change.
 */

export interface HistoryResponse {
  source: {
    id: string;
    name: string;
    sourceUrl: string;
    historicalMode: string;
  };
  rows: HistoricalResultRow[];
  total: number;
  merge: {
    appCount: number;
    providerCount: number;
    overlapCount: number;
    conflicts: unknown[];
    providerUnavailableReason: string | null;
    notes: string[];
    effectiveMode: string;
  };
}

function toRow(
  row: Awaited<ReturnType<typeof queryHistoricalResults>>[number],
): HistoricalResultRow {
  return {
    id: row.id,
    matchId: row.matchId,
    sourceId: row.sourceId,
    externalEventId: row.externalEventId,
    source: row.source as ResultSource,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    homeScore: row.homeScore,
    awayScore: row.awayScore,
    leagueId: row.leagueId,
    leagueName: row.leagueName,
    playedAt: row.playedAt ? row.playedAt.toISOString() : null,
    capturedAt: row.capturedAt.toISOString(),
    trackingSessionId: row.trackingSessionId,
    finishReason: row.finishReason as HistoricalResultRow['finishReason'],
    finishConfidence: row.finishConfidence as HistoricalResultRow['finishConfidence'],
  };
}

export async function getHistory(
  source: SourceRow,
  query: HistoricalResultQuery,
  options: { fetchProviderHistory?: boolean; sql?: Sql } = {},
): Promise<HistoryResponse> {
  const sql = options.sql ?? getSql();
  const provider = createSportyBetProvider();
  const descriptor = descriptorFromSource(source);

  const stored = await queryHistoricalResults(
    { ...query, sourceId: source.id, limit: 500 },
    sql,
  );

  const appCollected: HistoryCandidate[] = stored
    .filter((row) => row.source === 'TRACKED_BY_APP')
    .map((row) => ({
      externalEventId: row.externalEventId,
      sportId: null,
      leagueId: row.leagueId,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      homeScore: row.homeScore,
      awayScore: row.awayScore,
      playedAt: row.playedAt,
      source: 'TRACKED_BY_APP',
      matchId: row.matchId,
    }));

  const providerStored: HistoryCandidate[] = stored
    .filter((row) => row.source === 'SPORTYBET_HISTORY')
    .map((row) => ({
      externalEventId: row.externalEventId,
      sportId: null,
      leagueId: row.leagueId,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      homeScore: row.homeScore,
      awayScore: row.awayScore,
      playedAt: row.playedAt,
      source: 'SPORTYBET_HISTORY',
      matchId: row.matchId,
    }));

  const wantsProviderHistory =
    source.historicalMode === 'PROVIDER_HISTORY' || source.historicalMode === 'HYBRID';

  const providerPage =
    options.fetchProviderHistory && wantsProviderHistory
      ? await provider.fetchHistoricalResults(descriptor, {
          since: query.since ?? null,
          timeoutMs: 15_000,
        })
      : null;

  const report = buildHistory({
    mode: source.historicalMode,
    providerHasHistory: descriptor.providerHasHistory,
    appCollected,
    providerStored,
    providerFetch: providerPage,
    sourceType: source.sourceType,
  });

  // Sort the merged set the same way the stored rows were ordered, so paging
  // and "Last 5/10/20" behave identically regardless of which datasets merged.
  const merged = [...report.results].sort((a, b) => {
    const left = a.playedAt ? a.playedAt.getTime() : 0;
    const right = b.playedAt ? b.playedAt.getTime() : 0;
    return right - left;
  });

  const limit = Math.min(query.limit ?? 100, 500);
  const offset = query.offset ?? 0;

  return {
    source: {
      id: source.id,
      name: source.name,
      sourceUrl: source.sourceUrl,
      historicalMode: source.historicalMode,
    },
    rows: merged.slice(offset, offset + limit).map(toRowFromMerged),
    total: merged.length,
    merge: {
      appCount: report.appCount,
      providerCount: report.providerCount,
      overlapCount: report.overlapCount,
      conflicts: report.conflicts,
      providerUnavailableReason: report.providerUnavailableReason,
      notes: report.notes,
      effectiveMode: report.effectiveMode,
    },
  };
}

function toRowFromMerged(row: {
  matchId: string | null;
  sourceId?: string;
  externalEventId: string | null;
  source: ResultSource;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  leagueId: string | null;
  playedAt: Date | null;
}): HistoricalResultRow {
  return {
    id: row.matchId ?? `${row.source}-${row.externalEventId ?? `${row.homeTeam}-${row.awayTeam}`}`,
    matchId: row.matchId,
    sourceId: row.sourceId ?? '',
    externalEventId: row.externalEventId,
    source: row.source,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    homeScore: row.homeScore,
    awayScore: row.awayScore,
    leagueId: row.leagueId,
    leagueName: null,
    playedAt: row.playedAt ? row.playedAt.toISOString() : null,
    capturedAt: (row.playedAt ?? new Date()).toISOString(),
    trackingSessionId: null,
    finishReason: null,
    finishConfidence: null,
  };
}