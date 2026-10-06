import { describe, expect, it } from 'vitest';
import {
  buildMatchFingerprint,
  computeEventKey,
  computeHistoryDedupeKey,
  mergeHistoricalRecords,
  normalizeTeamName,
  stableHash,
} from '../src/lib/core/dedupe';

const base = {
  sourceType: 'SPORTYBET',
  sportId: 'sr:sport:202120001',
  leagueId: 'lg1',
  homeTeam: 'North London',
  awayTeam: 'Merseyside',
  scheduledAt: new Date('2026-01-15T19:00:00.000Z'),
};

describe('normalizeTeamName', () => {
  it.each([
    ['North London', 'north london'],
    ['manchester  city', 'manchester city'],
    ['North-London!', 'north london'],
    ['  AFC  Boro  ', 'afc boro'],
    ['Café United', 'cafe united'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeTeamName(input)).toBe(expected);
  });

  it('collapses cosmetic differences so re-spellings match', () => {
    expect(normalizeTeamName('Manchester-City')).toBe(
      normalizeTeamName('manchester  city'),
    );
  });
});

describe('stableHash', () => {
  it('is deterministic', () => {
    expect(stableHash('a|b|c')).toBe(stableHash('a|b|c'));
  });

  it('produces an 8+8 hex digest', () => {
    expect(stableHash('anything')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when any component changes', () => {
    expect(stableHash('a|b|c')).not.toBe(stableHash('a|b|d'));
  });
});

describe('buildMatchFingerprint / computeEventKey', () => {
  it('is stable across polls for the same match', () => {
    const first = buildMatchFingerprint(base);
    const second = buildMatchFingerprint({ ...base, homeTeam: 'North London' });
    expect(second).toBe(first);
  });

  it('ignores whitespace and punctuation differences', () => {
    expect(
      buildMatchFingerprint({ ...base, awayTeam: 'Merseyside   ' }),
    ).toBe(buildMatchFingerprint(base));
  });

  it('distinguishes different fixtures', () => {
    expect(
      buildMatchFingerprint({ ...base, awayTeam: 'North London' }),
    ).not.toBe(buildMatchFingerprint(base));
  });

  it('distinguishes fixtures in different sports, leagues or countries', () => {
    expect(buildMatchFingerprint({ ...base, sportId: 'other' })).not.toBe(
      buildMatchFingerprint(base),
    );
    expect(buildMatchFingerprint({ ...base, leagueId: 'lg2' })).not.toBe(
      buildMatchFingerprint(base),
    );
    expect(buildMatchFingerprint({ ...base, sourceType: 'OTHER' })).not.toBe(
      buildMatchFingerprint(base),
    );
  });

  it('keys on the scheduled minute so a second-level shift cannot split a match', () => {
    const a = buildMatchFingerprint({ ...base, scheduledAt: new Date('2026-01-15T19:00:00.000Z') });
    const b = buildMatchFingerprint({ ...base, scheduledAt: new Date('2026-01-15T19:00:45.000Z') });
    expect(b).toBe(a);
  });

  it('separates fixtures kicked off a minute apart', () => {
    const a = buildMatchFingerprint({ ...base, scheduledAt: new Date('2026-01-15T19:00:00.000Z') });
    const b = buildMatchFingerprint({ ...base, scheduledAt: new Date('2026-01-15T19:01:00.000Z') });
    expect(b).not.toBe(a);
  });

  it('treats a missing scheduled time as its own stable component', () => {
    expect(buildMatchFingerprint({ ...base, scheduledAt: null })).toBe(
      buildMatchFingerprint({ ...base, scheduledAt: null }),
    );
    expect(buildMatchFingerprint({ ...base, scheduledAt: null })).not.toBe(
      buildMatchFingerprint(base),
    );
  });

  it('prefixes the key so it can never collide with a provider event id', () => {
    expect(computeEventKey(base)).toMatch(/^fp:/);
  });
});

describe('computeHistoryDedupeKey', () => {
  it('prefers the provider event id when present', () => {
    const key = computeHistoryDedupeKey({
      sourceType: 'SPORTYBET',
      sportId: 'sr:sport:202120001',
      externalEventId: 'sr:match:200026100521522',
      fingerprint: base,
    });

    expect(key).toBe('SPORTYBET:sr:sport:202120001:sr:match:200026100521522');
  });

  it('falls back to the fingerprint when the event id is missing', () => {
    const key = computeHistoryDedupeKey({
      sourceType: 'SPORTYBET',
      sportId: 'sr:sport:202120001',
      externalEventId: null,
      fingerprint: base,
    });

    expect(key).toMatch(/^fp:/);
    expect(key).toBe(computeHistoryDedupeKey({
      sourceType: 'SPORTYBET',
      sportId: 'sr:sport:202120001',
      externalEventId: '',
      fingerprint: base,
    }));
  });

  it('gives the same key for the same real-world match', () => {
    const args = { sourceType: 'SPORTYBET', sportId: null, externalEventId: null, fingerprint: base };
    expect(computeHistoryDedupeKey(args)).toBe(computeHistoryDedupeKey(args));
  });
});

describe('mergeHistoricalRecords', () => {
  type HistRow = {
    dedupeKey: string;
    source: 'SPORTYBET_HISTORY' | 'TRACKED_BY_APP';
    homeScore: number;
    awayScore: number;
  };
  const app = (key: string, home: number, away: number): HistRow => ({
    dedupeKey: key,
    source: 'TRACKED_BY_APP',
    homeScore: home,
    awayScore: away,
  });
  const provider = (key: string, home: number, away: number): HistRow => ({
    dedupeKey: key,
    source: 'SPORTYBET_HISTORY',
    homeScore: home,
    awayScore: away,
  });

  it('unions non-overlapping records without losing provenance', () => {
    const outcome = mergeHistoricalRecords(
      [app('a', 1, 0)],
      [provider('b', 2, 1)],
    );

    expect(outcome.merged).toHaveLength(2);
    expect(outcome.overlapCount).toBe(0);
    expect(outcome.merged.find((r) => r.dedupeKey === 'a')?.source).toBe('TRACKED_BY_APP');
    expect(outcome.merged.find((r) => r.dedupeKey === 'b')?.source).toBe('SPORTYBET_HISTORY');
  });

  it('stores an overlapping match once', () => {
    const outcome = mergeHistoricalRecords([app('a', 1, 0)], [provider('a', 1, 0)]);

    expect(outcome.merged).toHaveLength(1);
    expect(outcome.overlapCount).toBe(1);
    expect(outcome.conflicts).toHaveLength(0);
  });

  it('keeps provider history authoritative on disagreement and reports it', () => {
    const outcome = mergeHistoricalRecords([app('a', 1, 0)], [provider('a', 2, 1)]);

    expect(outcome.merged).toHaveLength(1);
    expect(outcome.merged[0]?.homeScore).toBe(2);
    expect(outcome.merged[0]?.source).toBe('SPORTYBET_HISTORY');
    expect(outcome.conflicts).toEqual([
      { dedupeKey: 'a', keptSource: 'SPORTYBET_HISTORY', appScore: '1-0', providerScore: '2-1' },
    ]);
  });

  it('never relabels an application-collected row as provider history', () => {
    const outcome = mergeHistoricalRecords(
      [app('a', 1, 0), app('b', 2, 2)],
      [provider('b', 2, 2)],
    );

    expect(outcome.merged.find((r) => r.dedupeKey === 'a')?.source).toBe('TRACKED_BY_APP');
    expect(outcome.merged.find((r) => r.dedupeKey === 'b')?.source).toBe('SPORTYBET_HISTORY');
    expect(outcome.merged.filter((r) => r.source === 'TRACKED_BY_APP')).toHaveLength(1);
  });

  it('is idempotent when merging the same data twice', () => {
    const once = mergeHistoricalRecords([app('a', 1, 0)], [provider('a', 1, 0)]);
    const twice = mergeHistoricalRecords(once.merged, []);

    expect(twice.merged).toHaveLength(1);
  });

  it('handles empty inputs', () => {
    const outcome = mergeHistoricalRecords([], []);
    expect(outcome.merged).toHaveLength(0);
    expect(outcome.overlapCount).toBe(0);
    expect(outcome.conflicts).toHaveLength(0);
  });
});