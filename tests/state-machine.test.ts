import { describe, expect, it } from 'vitest';
import { classifyMatch } from '../src/lib/core/state-machine';
import { DEFAULT_COMPLETION_SETTINGS } from '../src/lib/core/types';
import type { ProviderEvent, TrackedMatch } from '../src/lib/core/types';

const NOW = new Date('2026-01-15T19:45:00.000Z');

function makeMatch(overrides: Partial<TrackedMatch> = {}): TrackedMatch {
  return {
    id: 'm1',
    sourceId: 's1',
    externalEventId: 'sr:match:123',
    eventKey: 'fp:abc',
    homeTeam: 'North London',
    awayTeam: 'Merseyside',
    homeTeamId: 'h1',
    awayTeamId: 'a1',
    homeScore: 1,
    awayScore: 0,
    htHomeScore: null,
    htAwayScore: null,
    status: 'LIVE',
    clock: '60:00',
    clockMinute: 60,
    maxClockMinute: 60,
    leagueId: 'lg1',
    leagueName: 'England National League',
    sportId: 'sr:sport:202120001',
    scheduledAt: new Date('2026-01-15T19:00:00.000Z'),
    startedAt: new Date('2026-01-15T19:30:00.000Z'),
    finishedAt: null,
    firstSeenAt: new Date('2026-01-15T19:00:00.000Z'),
    lastSeenAt: new Date('2026-01-15T19:35:00.000Z'),
    absentPolls: 0,
    finishReason: null,
    finishConfidence: 'NONE',
    seenCount: 40,
    ...overrides,
  };
}

function observation(overrides: Partial<ProviderEvent> = {}): ProviderEvent {
  return {
    externalEventId: 'sr:match:123',
    sportId: 'sr:sport:202120001',
    leagueId: 'lg1',
    leagueName: 'England National League',
    homeTeam: 'North London',
    awayTeam: 'Merseyside',
    homeTeamId: 'h1',
    awayTeamId: 'a1',
    homeScore: 1,
    awayScore: 0,
    htHomeScore: 1,
    htAwayScore: 0,
    rawStatus: '1',
    rawMatchStatus: 'H2',
    clock: '60:00',
    clockMinute: 60,
    scheduledAt: new Date('2026-01-15T19:00:00.000Z'),
    raw: {},
    ...overrides,
  };
}

describe('case 1: event present', () => {
  it('moves a scheduled match to LIVE and records when play began', () => {
    const result = classifyMatch({
      match: makeMatch({ status: 'DISCOVERED', clock: null, clockMinute: null, maxClockMinute: null, startedAt: null, absentPolls: 0 }),
      observation: observation({ homeScore: null, awayScore: null, clock: '1:00', clockMinute: 1 }),
      now: NOW,
    });

    expect(result.status).toBe('LIVE');
    expect(result.startedAt).toBe(NOW);
    expect(result.absentPolls).toBe(0);
    expect(result.seenCount).toBe(41);
    expect(result.writeHistory).toBe(false);
  });

  it('keeps an in-play match live and clears any absence counter', () => {
    const result = classifyMatch({
      match: makeMatch({ absentPolls: 1 }),
      observation: observation(),
      now: NOW,
    });

    expect(result.status).toBe('LIVE');
    expect(result.absentPolls).toBe(0);
    expect(result.writeHistory).toBe(false);
  });

  it('finishes with DEFINITIVE confidence when the provider reports a terminal status', () => {
    const result = classifyMatch({
      match: makeMatch(),
      observation: observation({
        rawStatus: '2',
        rawMatchStatus: 'FT',
        homeScore: 2,
        awayScore: 1,
        clock: '90:00',
        clockMinute: 90,
      }),
      now: NOW,
    });

    expect(result.status).toBe('FINISHED');
    expect(result.finishReason).toBe('TERMINAL_STATUS');
    expect(result.finishConfidence).toBe('DEFINITIVE');
    expect(result.writeHistory).toBe(true);
    expect(result.homeScore).toBe(2);
    expect(result.awayScore).toBe(1);
    expect(result.finishedAt).toBe(NOW);
  });

  it('does not write history on a terminal status without both scores', () => {
    const result = classifyMatch({
      match: makeMatch({ homeScore: null, awayScore: null }),
      observation: observation({
        rawStatus: '2',
        rawMatchStatus: 'FT',
        homeScore: null,
        awayScore: null,
      }),
      now: NOW,
    });

    expect(result.status).toBe('UNKNOWN');
    expect(result.writeHistory).toBe(false);
  });

  it('finishes when the clock passes regulation with a score present', () => {
    const result = classifyMatch({
      match: makeMatch({
        clock: '89:00',
        clockMinute: 89,
        maxClockMinute: 91,
        homeScore: 3,
        awayScore: 3,
      }),
      observation: observation({
        clock: '91:00',
        clockMinute: 91,
        homeScore: 3,
        awayScore: 3,
      }),
      now: NOW,
    });

    expect(result.status).toBe('FINISHED');
    expect(result.finishReason).toBe('REGULATION_CLOCK_REACHED');
    expect(result.finishConfidence).toBe('HIGH');
    expect(result.writeHistory).toBe(true);
  });

  it('never reopens a finished match', () => {
    const result = classifyMatch({
      match: makeMatch({
        status: 'FINISHED',
        finishReason: 'TERMINAL_STATUS',
        finishConfidence: 'DEFINITIVE',
        finishedAt: NOW,
      }),
      observation: observation({ rawStatus: '0', rawMatchStatus: 'Not start' }),
      now: NOW,
    });

    expect(result.status).toBe('FINISHED');
    expect(result.finishReason).toBe('TERMINAL_STATUS');
    expect(result.writeHistory).toBe(false);
  });

  it('marks a provider-reported cancellation as cancelled and non-historical', () => {
    const result = classifyMatch({
      match: makeMatch(),
      observation: observation({ rawStatus: '3', rawMatchStatus: 'POSTPONED' }),
      now: NOW,
    });

    expect(result.status).toBe('CANCELLED');
    expect(result.finishReason).toBe('PROVIDER_CANCELLED');
    expect(result.writeHistory).toBe(false);
  });

  it('ignores a regression to "not start" once the match has been live', () => {
    const result = classifyMatch({
      match: makeMatch({ status: 'LIVE' }),
      observation: observation({ rawStatus: '0', rawMatchStatus: 'Not start' }),
      now: NOW,
    });

    expect(result.status).toBe('LIVE');
  });

  it('tracks the maximum clock, not the latest one', () => {
    const result = classifyMatch({
      match: makeMatch({ maxClockMinute: 89, clockMinute: 89, clock: '89:00' }),
      observation: observation({ clock: '12:00', clockMinute: 12 }),
      now: NOW,
    });

    expect(result.maxClockMinute).toBe(89);
  });
});

describe('case 2: event absent', () => {
  const late = makeMatch({
    status: 'LIVE',
    clock: '89:00',
    clockMinute: 89,
    maxClockMinute: 89,
    homeScore: 2,
    awayScore: 3,
    absentPolls: 0,
  });

  it('does not finish before the absence threshold is reached', () => {
    const result = classifyMatch({ match: late, observation: null, now: NOW });

    expect(result.status).toBe('LIVE');
    expect(result.absentPolls).toBe(1);
    expect(result.writeHistory).toBe(false);
    expect(result.notes.join(' ')).toContain('awaiting confirmation');
  });

  it('finishes with HIGH confidence once a late clock disappears twice', () => {
    const first = classifyMatch({ match: late, observation: null, now: NOW });
    const second = classifyMatch({
      match: { ...late, absentPolls: first.absentPolls },
      observation: null,
      now: NOW,
    });

    expect(second.status).toBe('FINISHED');
    expect(second.finishReason).toBe('DISAPPEARED_AFTER_LATE_CLOCK');
    expect(second.finishConfidence).toBe('HIGH');
    expect(second.writeHistory).toBe(true);
    expect(second.homeScore).toBe(2);
    expect(second.awayScore).toBe(3);
    expect(second.finishedAt).toBe(NOW);
  });

  it('never treats a mid-match disappearance as completion', () => {
    const midMatch = { ...late, clock: '42:00', clockMinute: 42, maxClockMinute: 42 };

    // While absence is still within the window it stays LIVE, never historical.
    const early = classifyMatch({ match: midMatch, observation: null, now: NOW });
    expect(early.status).toBe('LIVE');
    expect(early.writeHistory).toBe(false);
    expect(early.notes.join(' ')).toContain('below the 88');

    // Once absence runs out it closes as UNKNOWN rather than lingering LIVE.
    let match = midMatch;
    for (let i = 0; i < 10; i += 1) {
      match = { ...midMatch, absentPolls: classifyMatch({ match, observation: null, now: NOW }).absentPolls };
    }

    const result = classifyMatch({ match, observation: null, now: NOW });

    expect(result.status).toBe('UNKNOWN');
    expect(result.writeHistory).toBe(false);
    expect(result.finishReason).toBeNull();
  });

  it('does not fabricate a result when the score was never captured', () => {
    const scoreless = { ...late, homeScore: null, awayScore: null };
    const first = classifyMatch({ match: scoreless, observation: null, now: NOW });
    const second = classifyMatch({
      match: { ...scoreless, absentPolls: first.absentPolls },
      observation: null,
      now: NOW,
    });

    expect(second.status).toBe('UNKNOWN');
    expect(second.writeHistory).toBe(false);
  });

  it('marks a never-started match unknown after the rollout window', () => {
    let match = makeMatch({
      status: 'DISCOVERED',
      clock: null,
      clockMinute: null,
      maxClockMinute: null,
      startedAt: null,
      seenCount: 1,
      absentPolls: 0,
    });

    let result;
    for (let i = 0; i < DEFAULT_COMPLETION_SETTINGS.maxAbsentPolls; i += 1) {
      result = classifyMatch({ match, observation: null, now: NOW });
      match = { ...match, absentPolls: result.absentPolls };
    }

    expect(result?.status).toBe('UNKNOWN');
    expect(result?.writeHistory).toBe(false);
  });

  it('leaves an already-terminal match untouched', () => {
    const result = classifyMatch({
      match: makeMatch({
        status: 'FINISHED',
        finishReason: 'TERMINAL_STATUS',
        finishConfidence: 'DEFINITIVE',
      }),
      observation: null,
      now: NOW,
    });

    expect(result.status).toBe('FINISHED');
    expect(result.writeHistory).toBe(false);
  });

  it('respects per-session threshold overrides', () => {
    const result = classifyMatch({
      match: { ...late, absentPolls: 1 },
      observation: null,
      settings: { ...DEFAULT_COMPLETION_SETTINGS, confirmAbsentPolls: 3 },
      now: NOW,
    });

    expect(result.status).toBe('LIVE');
    expect(result.notes.join(' ')).toContain('2/3');
  });

  it('closes a sub-threshold disappearance as UNKNOWN once absence runs out', () => {
    let match = makeMatch({
      status: 'LIVE',
      clock: '40:00',
      clockMinute: 40,
      maxClockMinute: 40,
      homeScore: 1,
      awayScore: 0,
      absentPolls: 0,
    });

    let result;
    for (let i = 0; i < DEFAULT_COMPLETION_SETTINGS.maxAbsentPolls; i += 1) {
      result = classifyMatch({ match, observation: null, now: NOW });
      match = { ...match, absentPolls: result.absentPolls };
    }

    expect(result?.status).toBe('UNKNOWN');
    expect(result?.writeHistory).toBe(false);
    expect(result?.notes.join(' ')).toContain('not historical');
  });

  it('keeps a late-clock match out of history when no score was ever captured', () => {
    const result = classifyMatch({
      match: makeMatch({
        status: 'LIVE',
        homeScore: null,
        awayScore: null,
        maxClockMinute: 89,
        absentPolls: 0,
      }),
      observation: null,
      now: NOW,
    });

    expect(result.status).toBe('LIVE');
    expect(result.writeHistory).toBe(false);

    const second = classifyMatch({
      match: { ...makeMatch({ status: 'LIVE', homeScore: null, awayScore: null, maxClockMinute: 89 }), absentPolls: 1 },
      observation: null,
      now: NOW,
    });

    expect(second.status).toBe('UNKNOWN');
    expect(second.writeHistory).toBe(false);
  });
});

describe('provenance guarantees', () => {
  it('only ever writes history when both scores are known', () => {
    const attempts = [
      classifyMatch({
        match: makeMatch({ homeScore: 1, awayScore: null }),
        observation: null,
        now: NOW,
      }),
      classifyMatch({
        match: makeMatch({ homeScore: null, awayScore: null }),
        observation: null,
        now: NOW,
      }),
    ];

    for (const result of attempts) {
      if (result.writeHistory) {
        expect(result.homeScore).not.toBeNull();
        expect(result.awayScore).not.toBeNull();
      }
    }
  });
});