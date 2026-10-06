/**
 * Descriptive statistics over collected history.
 *
 * Pure functions over plain result rows so they can be unit-tested without a
 * database and reused by both the API layer and the dashboard.
 *
 * These are descriptive counts of what already happened. There is deliberately
 * no forecasting, no probability estimate and no recommendation output: the
 * project collects data for manual study only.
 */

import type { TeamStatistics } from './types.ts';

/** Minimal shape required to compute statistics. */
export interface ResultLike {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  playedAt?: string | Date | null;
  leagueId?: string | null;
}

function playedAtValue(row: ResultLike): number {
  if (!row.playedAt) return 0;
  const parsed = row.playedAt instanceof Date ? row.playedAt.getTime() : Date.parse(row.playedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortByPlayedAtDesc<T extends ResultLike>(rows: T[]): T[] {
  return [...rows].sort((a, b) => playedAtValue(b) - playedAtValue(a));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function percent(part: number, whole: number): number {
  if (whole === 0) return 0;
  return round1((part / whole) * 100);
}

/**
 * Team statistics across a set of results, counting matches where the team
 * played either at home or away.
 */
export function computeTeamStats(team: string, rows: ResultLike[]): TeamStatistics {
  let played = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let over15 = 0;
  let over25 = 0;
  let btts = 0;
  let cleanSheets = 0;
  let failedToScore = 0;

  for (const row of rows) {
    const isHome = row.homeTeam === team;
    const isAway = row.awayTeam === team;
    if (!isHome && !isAway) continue;

    const scored = isHome ? row.homeScore : row.awayScore;
    const conceded = isHome ? row.awayScore : row.homeScore;
    const total = scored + conceded;

    played += 1;
    goalsFor += scored;
    goalsAgainst += conceded;

    if (scored > conceded) wins += 1;
    else if (scored === conceded) draws += 1;
    else losses += 1;

    if (total > 1.5) over15 += 1;
    if (total > 2.5) over25 += 1;
    if (scored > 0 && conceded > 0) btts += 1;
    if (conceded === 0) cleanSheets += 1;
    if (scored === 0) failedToScore += 1;
  }

  return {
    team,
    played,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    avgGoalsScored: round1(played === 0 ? 0 : goalsFor / played),
    avgGoalsConceded: round1(played === 0 ? 0 : goalsAgainst / played),
    avgTotalGoals: round1(played === 0 ? 0 : (goalsFor + goalsAgainst) / played),
    over15,
    over25,
    btts,
    cleanSheets,
    failedToScore,
    winRate: percent(wins, played),
    drawRate: percent(draws, played),
    lossRate: percent(losses, played),
    over15Rate: percent(over15, played),
    over25Rate: percent(over25, played),
    bttsRate: percent(btts, played),
    cleanSheetRate: percent(cleanSheets, played),
  };
}

export interface HeadToHead {
  homeTeam: string;
  awayTeam: string;
  played: number;
  homeWins: number;
  draws: number;
  awayWins: number;
  homeGoals: number;
  awayGoals: number;
  over25: number;
  btts: number;
  rows: ResultLike[];
}

export function computeHeadToHead(
  homeTeam: string,
  awayTeam: string,
  rows: ResultLike[],
): HeadToHead {
  const relevant = rows.filter(
    (row) => row.homeTeam === homeTeam && row.awayTeam === awayTeam,
  );

  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let homeGoals = 0;
  let awayGoals = 0;
  let over25 = 0;
  let btts = 0;

  for (const row of relevant) {
    homeGoals += row.homeScore;
    awayGoals += row.awayScore;
    if (row.homeScore > row.awayScore) homeWins += 1;
    else if (row.homeScore === row.awayScore) draws += 1;
    else awayWins += 1;
    if (row.homeScore + row.awayScore > 2.5) over25 += 1;
    if (row.homeScore > 0 && row.awayScore > 0) btts += 1;
  }

  return {
    homeTeam,
    awayTeam,
    played: relevant.length,
    homeWins,
    draws,
    awayWins,
    homeGoals,
    awayGoals,
    over25,
    btts,
    rows: sortByPlayedAtDesc(relevant),
  };
}

export interface OverallSummary {
  total: number;
  homeWins: number;
  draws: number;
  awayWins: number;
  avgTotalGoals: number;
  over15: number;
  over25: number;
  over35: number;
  btts: number;
  failedToScore: number;
  homeWinRate: number;
  drawRate: number;
  awayWinRate: number;
  over15Rate: number;
  over25Rate: number;
  bttsRate: number;
  maxHomeScore: number;
  maxAwayScore: number;
  biggestTotal: number;
}

export function computeOverallSummary(rows: ResultLike[]): OverallSummary {
  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;
  let btts = 0;
  let failedToScore = 0;
  let totalGoals = 0;
  let maxHomeScore = 0;
  let maxAwayScore = 0;
  let biggestTotal = 0;

  for (const row of rows) {
    const total = row.homeScore + row.awayScore;
    totalGoals += total;
    if (total > biggestTotal) biggestTotal = total;
    if (row.homeScore > maxHomeScore) maxHomeScore = row.homeScore;
    if (row.awayScore > maxAwayScore) maxAwayScore = row.awayScore;

    if (row.homeScore > row.awayScore) homeWins += 1;
    else if (row.homeScore === row.awayScore) draws += 1;
    else awayWins += 1;

    if (total > 1.5) over15 += 1;
    if (total > 2.5) over25 += 1;
    if (total > 3.5) over35 += 1;
    if (row.homeScore > 0 && row.awayScore > 0) btts += 1;
    if (row.homeScore === 0) failedToScore += 1;
  }

  const total = rows.length;
  return {
    total,
    homeWins,
    draws,
    awayWins,
    avgTotalGoals: round1(total === 0 ? 0 : totalGoals / total),
    over15,
    over25,
    over35,
    btts,
    failedToScore,
    homeWinRate: percent(homeWins, total),
    drawRate: percent(draws, total),
    awayWinRate: percent(awayWins, total),
    over15Rate: percent(over15, total),
    over25Rate: percent(over25, total),
    bttsRate: percent(btts, total),
    maxHomeScore,
    maxAwayScore,
    biggestTotal,
  };
}

export interface DistributionBucket {
  label: string;
  count: number;
  rate: number;
}

/** Total-goals distribution, e.g. "0", "1", "2", "3", "4", "5+". */
export function totalGoalsDistribution(rows: ResultLike[]): DistributionBucket[] {
  const buckets = new Map<string, number>();
  for (const row of rows) {
    const total = row.homeScore + row.awayScore;
    const label = total >= 5 ? '5+' : String(total);
    buckets.set(label, (buckets.get(label) ?? 0) + 1);
  }
  const order = ['0', '1', '2', '3', '4', '5+'];
  const total = rows.length;
  return order
    .filter((label) => buckets.has(label))
    .map((label) => {
      const count = buckets.get(label) ?? 0;
      return { label, count, rate: percent(count, total) };
    });
}

/** League breakdown, busiest leagues first. */
export function computeLeagueSummary(
  rows: ResultLike[],
): Array<{ leagueId: string | null; played: number; avgTotalGoals: number }> {
  const byLeague = new Map<string, { leagueId: string | null; played: number; goals: number }>();

  for (const row of rows) {
    const key = row.leagueId ?? 'unknown';
    const entry = byLeague.get(key) ?? {
      leagueId: row.leagueId ?? null,
      played: 0,
      goals: 0,
    };
    entry.played += 1;
    entry.goals += row.homeScore + row.awayScore;
    byLeague.set(key, entry);
  }

  return [...byLeague.values()]
    .map((entry) => ({
      leagueId: entry.leagueId,
      played: entry.played,
      avgTotalGoals: round1(entry.played === 0 ? 0 : entry.goals / entry.played),
    }))
    .sort((a, b) => b.played - a.played);
}

/**
 * Rolling completion count over time: how many finished matches had been
 * recorded after each of the last `window` results. Lets an operator see how
 * quickly history builds up, which is the practical limit on what any of these
 * figures can be based on.
 */
export function buildHistoryProgression(
  rows: ResultLike[],
  window = 20,
): Array<{ index: number; total: number; homeWins: number; draws: number; awayWins: number }> {
  const ordered = sortByPlayedAtDesc(rows);
  const out: Array<{
    index: number;
    total: number;
    homeWins: number;
    draws: number;
    awayWins: number;
  }> = [];

  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;

  for (let i = 0; i < ordered.length; i += 1) {
    const row = ordered[i] as ResultLike;
    if (row.homeScore > row.awayScore) homeWins += 1;
    else if (row.homeScore === row.awayScore) draws += 1;
    else awayWins += 1;

    const start = Math.max(0, i - window + 1);
    let sliceHomeWins = 0;
    let sliceDraws = 0;
    let sliceAwayWins = 0;
    for (let j = start; j <= i; j += 1) {
      const inner = ordered[j] as ResultLike;
      if (inner.homeScore > inner.awayScore) sliceHomeWins += 1;
      else if (inner.homeScore === inner.awayScore) sliceDraws += 1;
      else sliceAwayWins += 1;
    }

    out.push({
      index: i + 1,
      total: i + 1,
      homeWins: sliceHomeWins,
      draws: sliceDraws,
      awayWins: sliceAwayWins,
    });
  }

  return out;
}

/** Teams ranked by matches played, for the leaderboard. */
export function rankTeams(rows: ResultLike[]): TeamStatistics[] {
  const teamNames = new Set<string>();
  for (const row of rows) {
    teamNames.add(row.homeTeam);
    teamNames.add(row.awayTeam);
  }
  return [...teamNames]
    .map((team) => computeTeamStats(team, rows))
    .sort((a, b) => b.played - a.played || b.goalsFor - a.goalsFor);
}