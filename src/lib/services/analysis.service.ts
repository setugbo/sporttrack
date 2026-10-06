import 'server-only';

import {
  buildHistoryProgression,
  computeHeadToHead,
  computeLeagueSummary,
  computeOverallSummary,
  computeTeamStats,
  rankTeams,
  sortByPlayedAtDesc,
  totalGoalsDistribution,
  type ResultLike,
} from '../core/analysis.ts';
import { getSql, type Sql } from '../db/client.ts';
import { queryHistoricalResults, type SourceRow } from '../db/queries.ts';
import { getHistory } from './history.service.ts';

/**
 * Statistics endpoint backing. Pure aggregation over the merged history set.
 * Descriptive only: nothing here projects future outcomes.
 */

const DEFAULT_WINDOW = 20;

export interface AnalysisResponse {
  sourceId: string;
  sampleSize: number;
  /** True when the dataset is too small for the figures to mean much. */
  lowConfidence: boolean;
  lowConfidenceReason: string | null;
  recent: {
    last5: ResultLike[];
    last10: ResultLike[];
    last20: ResultLike[];
  };
  overall: ReturnType<typeof computeOverallSummary>;
  teams: ReturnType<typeof computeTeamStats>[];
  topTeams: ReturnType<typeof computeTeamStats>[];
  leagues: ReturnType<typeof computeLeagueSummary>;
  goalsDistribution: ReturnType<typeof totalGoalsDistribution>;
  progression: ReturnType<typeof buildHistoryProgression>;
  headToHead: ReturnType<typeof computeHeadToHead> | null;
}

/** Below this many completed matches the derived rates are not meaningful. */
const LOW_CONFIDENCE_THRESHOLD = 30;

export async function getAnalysis(
  source: SourceRow,
  options: { homeTeam?: string; awayTeam?: string; sql?: Sql } = {},
): Promise<AnalysisResponse> {
  const sql = options.sql ?? getSql();
  const history = await getHistory(
    source,
    { limit: 500 },
    { fetchProviderHistory: false, sql },
  );

  const rows: ResultLike[] = history.rows.map((row) => ({
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    homeScore: row.homeScore,
    awayScore: row.awayScore,
    playedAt: row.playedAt,
    leagueId: row.leagueId,
  }));

  const ordered = sortByPlayedAtDesc(rows);
  const sampleSize = ordered.length;

  const homeTeam = options.homeTeam ?? ordered[0]?.homeTeam ?? null;
  const awayTeam =
    options.awayTeam ?? ordered.find((r) => r.homeTeam === homeTeam)?.awayTeam ?? null;

  return {
    sourceId: source.id,
    sampleSize,
    lowConfidence: sampleSize < LOW_CONFIDENCE_THRESHOLD,
    lowConfidenceReason:
      sampleSize < LOW_CONFIDENCE_THRESHOLD
        ? `Only ${sampleSize} completed match(es) recorded; ${LOW_CONFIDENCE_THRESHOLD} is the minimum for the rates below to carry much weight. Historical results build up only as the tracker observes completions.`
        : null,
    recent: {
      last5: ordered.slice(0, 5),
      last10: ordered.slice(0, 10),
      last20: ordered.slice(0, DEFAULT_WINDOW),
    },
    overall: computeOverallSummary(rows),
    teams: rankTeams(rows),
    topTeams: rankTeams(rows).slice(0, 20),
    leagues: computeLeagueSummary(rows),
    goalsDistribution: totalGoalsDistribution(rows),
    progression: buildHistoryProgression(rows, DEFAULT_WINDOW),
    headToHead:
      homeTeam && awayTeam ? computeHeadToHead(homeTeam, awayTeam, rows) : null,
  };
}

export async function getAllResults(
  sourceId: string,
  query: Parameters<typeof queryHistoricalResults>[0],
  sql: Sql = getSql(),
) {
  return queryHistoricalResults(query, sql);
}