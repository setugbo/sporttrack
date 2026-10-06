import { describe, expect, it } from 'vitest';
import {
  computeHeadToHead,
  computeLeagueSummary,
  computeOverallSummary,
  computeTeamStats,
  rankTeams,
  totalGoalsDistribution,
} from '../src/lib/core/analysis';

type Row = {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
};

function result(home: string, away: string, homeScore: number, awayScore: number): Row {
  return { homeTeam: home, awayTeam: away, homeScore, awayScore };
}

describe('computeTeamStats', () => {
  const rows = [
    result('Alpha', 'Beta', 2, 1),
    result('Gamma', 'Alpha', 0, 3),
    result('Alpha', 'Delta', 1, 1),
    result('Epsilon', 'Alpha', 4, 0),
    result('Alpha', 'Zeta', 0, 2),
  ];

  it('counts matches played either home or away', () => {
    expect(computeTeamStats('Alpha', rows).played).toBe(5);
    expect(computeTeamStats('Beta', rows).played).toBe(1);
    expect(computeTeamStats('Nobody', rows).played).toBe(0);
  });

  it('splits results correctly', () => {
    const stats = computeTeamStats('Alpha', rows);
    expect(stats.wins).toBe(2);
    expect(stats.draws).toBe(1);
    expect(stats.losses).toBe(2);
    expect(stats.goalsFor).toBe(6);
    expect(stats.goalsAgainst).toBe(8);
  });

  it('rates are percentages of matches played', () => {
    const stats = computeTeamStats('Alpha', rows);
    expect(stats.winRate).toBe(40);
    expect(stats.drawRate).toBe(20);
    expect(stats.lossRate).toBe(40);
    expect(stats.winRate + stats.drawRate + stats.lossRate).toBeCloseTo(100, 1);
  });

  it('reports all figures as zero for a team with no matches', () => {
    const stats = computeTeamStats('Nobody', rows);
    expect(stats).toMatchObject({ played: 0, wins: 0, goalsFor: 0, avgGoalsScored: 0, winRate: 0 });
  });

  it('classifies totals, BTTS, clean sheets and failures to score', () => {
    // Beta lost 2-1 at home: total 3, both scored, no clean sheet kept.
    const beta = computeTeamStats('Beta', rows);
    expect(beta.over25).toBe(1);
    expect(beta.btts).toBe(1);
    expect(beta.cleanSheets).toBe(0);
    expect(beta.failedToScore).toBe(0);

    // Gamma lost 0-3 at home: failed to score, no clean sheet, high-scoring.
    const gamma = computeTeamStats('Gamma', rows);
    expect(gamma.failedToScore).toBe(1);
    expect(gamma.cleanSheets).toBe(0);
    expect(gamma.over25).toBe(1);
    expect(gamma.btts).toBe(0);

    // Zeta won 2-0 away, keeping a clean sheet rather than failing to score.
    const zeta = computeTeamStats('Zeta', rows);
    expect(zeta.failedToScore).toBe(0);
    expect(zeta.cleanSheets).toBe(1);
    expect(zeta.losses).toBe(0);
  });

  it('computes averages to one decimal place', () => {
    const stats = computeTeamStats('Alpha', rows);
    expect(stats.avgGoalsScored).toBe(1.2);
    expect(stats.avgGoalsConceded).toBe(1.6);
    expect(stats.avgTotalGoals).toBe(2.8);
  });
});

describe('computeHeadToHead', () => {
  const rows = [
    result('Alpha', 'Beta', 2, 1),
    result('Alpha', 'Beta', 1, 1),
    result('Alpha', 'Beta', 0, 3),
  ];

  it('only counts fixtures in the requested order', () => {
    const h2h = computeHeadToHead('Alpha', 'Beta', rows);
    expect(h2h.played).toBe(3);
    expect(h2h.homeWins).toBe(1);
    expect(h2h.draws).toBe(1);
    expect(h2h.awayWins).toBe(1);
    expect(h2h.homeGoals).toBe(3);
    expect(h2h.awayGoals).toBe(5);
    expect(h2h.over25).toBe(2);
    expect(h2h.btts).toBe(2);
  });

  it('returns zero counts when the fixtures have not happened', () => {
    const h2h = computeHeadToHead('Beta', 'Alpha', rows);
    expect(h2h.played).toBe(0);
    expect(h2h.homeWins).toBe(0);
    expect(h2h.rows).toHaveLength(0);
  });
});

describe('computeOverallSummary', () => {
  const rows = [
    result('A', 'B', 2, 0),
    result('C', 'D', 1, 2),
    result('E', 'F', 1, 1),
    result('G', 'H', 3, 1),
  ];

  it('summarises outcomes and goal totals', () => {
    const summary = computeOverallSummary(rows);
    expect(summary.total).toBe(4);
    expect(summary.homeWins).toBe(2);
    expect(summary.draws).toBe(1);
    expect(summary.awayWins).toBe(1);
    expect(summary.avgTotalGoals).toBe(2.8);
    expect(summary.over15).toBe(4);
    expect(summary.over25).toBe(2);
    expect(summary.btts).toBe(3);
    expect(summary.failedToScore).toBe(0);
    expect(summary.maxHomeScore).toBe(3);
    expect(summary.maxAwayScore).toBe(2);
    expect(summary.biggestTotal).toBe(4);
  });

  it('counts teams that never scored', () => {
    const summary = computeOverallSummary([result('A', 'B', 0, 3)]);
    expect(summary.failedToScore).toBe(1);
    expect(summary.awayWins).toBe(1);
    expect(summary.over15).toBe(1);
  });

  it('is all zero for an empty history', () => {
    const summary = computeOverallSummary([]);
    expect(summary).toMatchObject({ total: 0, homeWins: 0, avgTotalGoals: 0, over25Rate: 0 });
  });

  it('does not divide by zero', () => {
    expect(computeOverallSummary([]).homeWinRate).toBe(0);
  });
});

describe('totalGoalsDistribution', () => {
  it('buckets totals and groups five or more', () => {
    const rows = [
      result('A', 'B', 0, 0),
      result('C', 'D', 0, 1),
      result('E', 'F', 1, 1),
      result('G', 'H', 2, 1),
      result('I', 'J', 2, 2),
      result('K', 'L', 4, 2),
      result('M', 'N', 5, 1),
    ];

    const buckets = totalGoalsDistribution(rows);
    expect(buckets.map((b) => b.label)).toEqual(['0', '1', '2', '3', '4', '5+']);
    expect(buckets[0]?.count).toBe(1);
    expect(buckets[0]?.rate).toBe(14.3);
    expect(buckets.find((b) => b.label === '5+')?.count).toBe(2);
  });

  it('omits buckets with no matches', () => {
    const buckets = totalGoalsDistribution([result('A', 'B', 1, 0)]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ label: '1', count: 1, rate: 100 });
  });

  it('returns nothing for an empty history', () => {
    expect(totalGoalsDistribution([])).toEqual([]);
  });
});

describe('computeLeagueSummary', () => {
  it('groups by league and ranks by match count', () => {
    const rows = [
      { ...result('A', 'B', 1, 0), leagueId: 'lg1' },
      { ...result('C', 'D', 1, 0), leagueId: 'lg1' },
      { ...result('E', 'F', 1, 1), leagueId: 'lg2' },
    ];

    const summary = computeLeagueSummary(rows);
    expect(summary[0]).toMatchObject({ leagueId: 'lg1', played: 2, avgTotalGoals: 1 });
    expect(summary).toHaveLength(2);
  });

  it('buckets rows without a league together', () => {
    const summary = computeLeagueSummary([result('A', 'B', 1, 1)]);
    expect(summary[0]).toMatchObject({ leagueId: null, played: 1 });
  });
});

describe('rankTeams', () => {
  it('orders teams by matches played, then goals scored', () => {
    const rows = [
      result('A', 'B', 1, 0),
      result('A', 'C', 1, 0),
      result('B', 'C', 1, 0),
    ];

    const ranked = rankTeams(rows);
    expect(ranked[0]?.team).toBe('A');
    expect(ranked[0]?.played).toBe(2);
    expect(ranked).toHaveLength(3);
  });
});