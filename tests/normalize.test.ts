import { describe, expect, it } from 'vitest';
import {
  mapProviderStatus,
  normalizeClock,
  normalizeProviderEvent,
} from '../src/lib/core/provider';

describe('normalizeClock', () => {
  it('converts a whole-second count into minutes and a display string', () => {
    expect(normalizeClock(5400, null)).toEqual({ clock: '90:00', clockMinute: 90 });
    expect(normalizeClock(89 * 60, null)).toEqual({ clock: '89:00', clockMinute: 89 });
    expect(normalizeClock(0, null)).toEqual({ clock: '0:00', clockMinute: 0 });
  });

  it('floors partial minutes', () => {
    expect(normalizeClock(89 * 60 + 59, null)).toEqual({ clock: '89:00', clockMinute: 89 });
  });

  it('parses colon-delimited clock strings when no second count is given', () => {
    expect(normalizeClock(null, '45:00')).toEqual({ clock: '45:00', clockMinute: 45 });
    expect(normalizeClock(null, '45+3')).toEqual({ clock: '45+3', clockMinute: 45 });
    expect(normalizeClock(null, '12')).toEqual({ clock: '12', clockMinute: 12 });
  });

  it('accepts a colon clock delivered in playedSeconds, as SportyBet sends it', () => {
    expect(normalizeClock('73:00', null)).toEqual({ clock: '73:00', clockMinute: 73 });
    expect(normalizeClock('45+2', null)).toEqual({ clock: '45+2', clockMinute: 45 });
  });

  it('prefers the second count over the display string', () => {
    expect(normalizeClock(3600, '12:00')).toEqual({ clock: '60:00', clockMinute: 60 });
  });

  it('returns nulls for unparseable input', () => {
    expect(normalizeClock(null, null)).toEqual({ clock: null, clockMinute: null });
    expect(normalizeClock('soon', 'half time')).toEqual({
      clock: null,
      clockMinute: null,
    });
    expect(normalizeClock(-30, null)).toEqual({ clock: null, clockMinute: null });
  });
});

describe('mapProviderStatus', () => {
  it('maps the two statuses SportyBet actually publishes', () => {
    expect(mapProviderStatus('0', 'Not start')).toBe('DISCOVERED');
    expect(mapProviderStatus('1', 'H2')).toBe('LIVE');
  });

  it('recognises terminal statuses the provider may add later', () => {
    expect(mapProviderStatus('2', 'FT')).toBe('FINISHED');
    expect(mapProviderStatus('2', 'Finished')).toBe('FINISHED');
    expect(mapProviderStatus(null, 'AET')).toBe('FINISHED');
    expect(mapProviderStatus(null, 'PEN')).toBe('FINISHED');
  });

  it('recognises cancellations', () => {
    expect(mapProviderStatus(null, 'POSTPONED')).toBe('CANCELLED');
    expect(mapProviderStatus(null, 'Abandoned')).toBe('CANCELLED');
  });

  it('falls back to the numeric code when the label is absent', () => {
    expect(mapProviderStatus('1', null)).toBe('LIVE');
    expect(mapProviderStatus('0', null)).toBe('DISCOVERED');
  });

  it('treats unknown labels as scheduled rather than inventing a live state', () => {
    expect(mapProviderStatus(null, 'Mystery')).toBe('DISCOVERED');
    expect(mapProviderStatus(null, null)).toBe('DISCOVERED');
  });

  it('never maps an in-play label to a terminal state', () => {
    expect(mapProviderStatus('1', 'H1')).toBe('LIVE');
    expect(mapProviderStatus('1', 'H2')).toBe('LIVE');
  });
});

describe('normalizeProviderEvent', () => {
  it('normalises a typical SportyBet vFootball event', () => {
    const event = normalizeProviderEvent(
      {
        eventId: 'sr:match:200026100521522',
        sportId: 'sr:sport:202120001',
        homeTeam: 'North London',
        awayTeam: 'Merseyside',
        homeTeamId: 't1',
        awayTeamId: 't2',
        homeScore: 2,
        awayScore: 1,
        status: '1',
        matchStatus: 'H2',
        playedSeconds: 5400,
        estimateStartTime: '2026-01-15T19:00:00.000Z',
        category: {
          tournamentId: 'lg1',
          tournamentName: 'England National League',
        },
      },
      'sr:sport:202120001',
    );

    expect(event).not.toBeNull();
    expect(event?.externalEventId).toBe('sr:match:200026100521522');
    expect(event?.homeTeam).toBe('North London');
    expect(event?.awayTeam).toBe('Merseyside');
    expect(event?.homeScore).toBe(2);
    expect(event?.awayScore).toBe(1);
    expect(event?.clock).toBe('90:00');
    expect(event?.clockMinute).toBe(90);
    expect(event?.scheduledAt).toEqual(new Date('2026-01-15T19:00:00.000Z'));
    expect(event?.leagueName).toBe('England National League');
    expect(event?.sportId).toBe('sr:sport:202120001');
  });

  it('keeps the raw payload for the debug view', () => {
    const event = normalizeProviderEvent(
      { eventId: 'a', homeTeam: 'A', awayTeam: 'B', status: '1' },
      null,
    );
    expect(event?.raw).toEqual({ eventId: 'a', homeTeam: 'A', awayTeam: 'B', status: '1' });
  });

  it('falls back to the source sport id when the event omits it', () => {
    const event = normalizeProviderEvent(
      { eventId: 'a', homeTeam: 'A', awayTeam: 'B', status: '1' },
      'sr:sport:202120001',
    );
    expect(event?.sportId).toBe('sr:sport:202120001');
  });

  it('reads leagues from a nested sports array', () => {
    const event = normalizeProviderEvent(
      {
        eventId: 'a',
        homeTeam: 'A',
        awayTeam: 'B',
        sports: [
          {
            category: { tournamentId: 'lg9', tournamentName: 'Iberia Division' },
          },
        ],
      },
      null,
    );
    expect(event?.leagueId).toBe('lg9');
    expect(event?.leagueName).toBe('Iberia Division');
  });

  it('reads leagues from an array container', () => {
    const event = normalizeProviderEvent(
      {
        eventId: 'a',
        homeTeam: 'A',
        awayTeam: 'B',
        category: [{ tournamentId: 'lg7', tournamentName: 'Ligue Vert' }],
      },
      null,
    );
    expect(event?.leagueName).toBe('Ligue Vert');
  });

  it('discards events without two distinct named teams', () => {
    expect(
      normalizeProviderEvent({ eventId: 'a', homeTeam: '', awayTeam: 'B' }, null),
    ).toBeNull();
    expect(
      normalizeProviderEvent({ eventId: 'a', homeTeam: 'Same', awayTeam: 'Same' }, null),
    ).toBeNull();
    expect(normalizeProviderEvent({ eventId: 'a' }, null)).toBeNull();
  });

  it('does not invent scores when they are absent', () => {
    const event = normalizeProviderEvent(
      { eventId: 'a', homeTeam: 'A', awayTeam: 'B', status: '0' },
      null,
    );
    expect(event?.homeScore).toBeNull();
    expect(event?.awayScore).toBeNull();
  });

  it('coerces numeric identifiers to strings', () => {
    const event = normalizeProviderEvent(
      { eventId: 12345, homeTeam: 'A', awayTeam: 'B', homeScore: '2', awayScore: '1' },
      null,
    );
    expect(event?.externalEventId).toBe('12345');
    expect(event?.homeScore).toBe(2);
    expect(event?.awayScore).toBe(1);
  });

  it('reads setScore/gameScore, the fields SportyBet actually sends', () => {
    const event = normalizeProviderEvent(
      {
        eventId: 'sr:match:1',
        homeTeam: 'MCF',
        awayTeam: 'VCF',
        status: '1',
        matchStatus: 'H2',
        setScore: '3:1',
        gameScore: ['2:0', '1:1'],
        playedSeconds: '73:00',
      },
      'sr:sport:202120001',
    );

    expect(event?.homeScore).toBe(3);
    expect(event?.awayScore).toBe(1);
    expect(event?.htHomeScore).toBe(2);
    expect(event?.htAwayScore).toBe(0);
    expect(event?.clock).toBe('73:00');
    expect(event?.clockMinute).toBe(73);
  });

  it('treats an all-zero setScore as a real scoreline, not absent', () => {
    const event = normalizeProviderEvent(
      {
        eventId: 'sr:match:2',
        homeTeam: 'GET',
        awayTeam: 'ALA',
        status: '1',
        matchStatus: 'H2',
        setScore: '0:0',
        gameScore: ['0:0', '0:0'],
        playedSeconds: '73:00',
      },
      null,
    );
    expect(event?.homeScore).toBe(0);
    expect(event?.awayScore).toBe(0);
  });

  it('parses epoch-millisecond scheduled times', () => {
    const event = normalizeProviderEvent(
      {
        eventId: 'sr:match:3',
        homeTeam: 'A',
        awayTeam: 'B',
        status: '0',
        estimateStartTime: 1791288120000,
      },
      null,
    );
    expect(event?.scheduledAt).toEqual(new Date(1791288120000));
  });

  it('parses epoch times sent as strings too', () => {
    const event = normalizeProviderEvent(
      {
        eventId: 'sr:match:4',
        homeTeam: 'A',
        awayTeam: 'B',
        status: '0',
        estimateStartTime: '1791288120000',
      },
      null,
    );
    expect(event?.scheduledAt).toEqual(new Date(1791288120000));
  });

  it('drops an unparseable scheduled time instead of storing an Invalid Date', () => {
    const event = normalizeProviderEvent(
      {
        eventId: 'sr:match:5',
        homeTeam: 'A',
        awayTeam: 'B',
        status: '0',
        estimateStartTime: 'soon',
      },
      null,
    );
    expect(event?.scheduledAt).toBeNull();
  });
});