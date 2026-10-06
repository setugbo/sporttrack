import { describe, expect, it } from 'vitest';
import { buildHistory } from '../src/lib/core/history-engine';
import type { HistoryCandidate } from '../src/lib/core/history-engine';

const appRow = (key: string, home: number, away: number): HistoryCandidate => ({
  externalEventId: key === 'a' ? 'sr:match:1' : null,
  sportId: 'sr:sport:202120001',
  leagueId: 'lg1',
  homeTeam: 'Alpha',
  awayTeam: 'Beta',
  homeScore: home,
  awayScore: away,
  playedAt: new Date('2026-01-15T19:00:00.000Z'),
  source: 'TRACKED_BY_APP',
});

const providerRow = (key: string, home: number, away: number): HistoryCandidate => ({
  externalEventId: key === 'a' ? 'sr:match:1' : 'sr:match:2',
  sportId: 'sr:sport:202120001',
  leagueId: 'lg1',
  homeTeam: 'Alpha',
  awayTeam: 'Beta',
  homeScore: home,
  awayScore: away,
  playedAt: new Date('2026-01-15T19:00:00.000Z'),
  source: 'SPORTYBET_HISTORY',
});

describe('buildHistory', () => {
  it('APP_TRACKED uses only application-collected rows', () => {
    const report = buildHistory({
      mode: 'APP_TRACKED',
      providerHasHistory: false,
      appCollected: [appRow('a', 1, 0)],
      providerStored: [],
      sourceType: 'SPORTYBET',
    });

    expect(report.effectiveMode).toBe('APP_TRACKED');
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.source).toBe('TRACKED_BY_APP');
    expect(report.providerCount).toBe(0);
  });

  it('clamps PROVIDER_HISTORY to APP_TRACKED when the provider has no feed', () => {
    const report = buildHistory({
      mode: 'PROVIDER_HISTORY',
      providerHasHistory: false,
      appCollected: [appRow('a', 1, 0)],
      providerStored: [],
      sourceType: 'SPORTYBET',
    });

    expect(report.effectiveMode).toBe('APP_TRACKED');
    expect(report.providerUnavailableReason).toBeTruthy();
    expect(report.providerUnavailableReason).toContain('historical');
    expect(report.notes.join(' ')).toContain('Clamping to APP_TRACKED');
    expect(report.results).toHaveLength(1);
  });

  it('clamps HYBRID to APP_TRACKED when the provider has no feed', () => {
    const report = buildHistory({
      mode: 'HYBRID',
      providerHasHistory: false,
      appCollected: [appRow('a', 1, 0)],
      providerStored: [],
      providerFetch: { records: [], unavailableReason: 'NO_HISTORY_ENDPOINT: none' },
      sourceType: 'SPORTYBET',
    });

    expect(report.effectiveMode).toBe('APP_TRACKED');
    expect(report.providerUnavailableReason).toContain('NO_HISTORY_ENDPOINT');
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.source).toBe('TRACKED_BY_APP');
  });

  it('merges both datasets when the provider history is genuinely available', () => {
    const report = buildHistory({
      mode: 'HYBRID',
      providerHasHistory: true,
      appCollected: [appRow('a', 1, 0)],
      providerStored: [],
      providerFetch: { records: [], unavailableReason: null },
      sourceType: 'SPORTYBET',
    });

    expect(report.effectiveMode).toBe('HYBRID');
    expect(report.providerUnavailableReason).toBeNull();
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.source).toBe('TRACKED_BY_APP');
  });

  it('produces one row for a match present in both datasets', () => {
    const report = buildHistory({
      mode: 'HYBRID',
      providerHasHistory: true,
      appCollected: [appRow('a', 1, 0)],
      providerStored: [providerRow('a', 1, 0)],
      providerFetch: { records: [], unavailableReason: null },
      sourceType: 'SPORTYBET',
    });

    expect(report.results).toHaveLength(1);
    expect(report.overlapCount).toBe(1);
    expect(report.conflicts).toHaveLength(0);
  });

  it('keeps the application-collected provenance on its own rows in hybrid mode', () => {
    const report = buildHistory({
      mode: 'HYBRID',
      providerHasHistory: true,
      appCollected: [appRow('b', 2, 2)],
      providerStored: [providerRow('a', 1, 0)],
      providerFetch: { records: [], unavailableReason: null },
      sourceType: 'SPORTYBET',
    });

    expect(report.results).toHaveLength(2);
    expect(report.results.filter((r) => r.source === 'TRACKED_BY_APP')).toHaveLength(1);
    expect(report.results.filter((r) => r.source === 'SPORTYBET_HISTORY')).toHaveLength(1);
  });

  it('drops rows with impossible scores', () => {
    const report = buildHistory({
      mode: 'APP_TRACKED',
      providerHasHistory: false,
      appCollected: [appRow('a', 2, 2), appRow('b', -1, 4)],
      providerStored: [],
      sourceType: 'SPORTYBET',
    });

    expect(report.results).toHaveLength(1);
    expect(report.notes.join(' ')).toContain('implausible scores');
  });

  it('assigns a stable dedupe key to every row', () => {
    const report = buildHistory({
      mode: 'APP_TRACKED',
      providerHasHistory: false,
      appCollected: [appRow('a', 1, 0)],
      providerStored: [],
      sourceType: 'SPORTYBET',
    });

    const again = buildHistory({
      mode: 'APP_TRACKED',
      providerHasHistory: false,
      appCollected: [appRow('a', 1, 0)],
      providerStored: [],
      sourceType: 'SPORTYBET',
    });

    expect(report.results[0]?.dedupeKey).toBe(again.results[0]?.dedupeKey);
  });
});