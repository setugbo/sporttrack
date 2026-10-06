/**
 * Duplicate prevention and hybrid history merging.
 *
 * Two independent problems are solved here:
 *
 * 1. Poll-level duplicate prevention. A match already in the database must
 *    never be inserted twice, even though the provider feed shows the same
 *    event on every poll. The provider's `eventId` is the authoritative key; a
 *    content fingerprint is the fallback when it is absent.
 *
 * 2. Historical-result merging. Because SportyBet exposes no vFootball
 *    historical endpoint, history is application-collected (Mode B). If a
 *    provider history feed is ever added, the two datasets must union without
 *    duplicating the same real-world match, and an application-collected row
 *    must never be relabelled as provider history.
 *
 * Hashing is implemented in plain TypeScript rather than `node:crypto` so this
 * module stays platform-neutral and can be imported from any bundle.
 */

/** FNV-1a, 32-bit. Two passes with different offsets give a 64-bit digest. */
function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // hash * 16777619, kept in uint32 range without BigInt.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function stableHash(input: string): string {
  const a = fnv1a(input, 0x811c9dc5).toString(16).padStart(8, '0');
  const b = fnv1a(input, 0x9e3779b9).toString(16).padStart(8, '0');
  return `${a}${b}`;
}

/**
 * Collapses cosmetic differences so "Manchester City", "manchester  city" and
 * "Manchester-City" fingerprint identically.
 */
export function normalizeTeamName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface FingerprintInput {
  sourceType: string;
  sportId: string | null;
  leagueId: string | null;
  homeTeam: string;
  awayTeam: string;
  /** Scheduled kickoff; only the minute is used so seconds cannot break it. */
  scheduledAt: Date | null;
}

export function buildMatchFingerprint(input: FingerprintInput): string {
  const scheduledMinute =
    input.scheduledAt === null
      ? 'na'
      : String(Math.floor(input.scheduledAt.getTime() / 60000));
  const canonical = [
    input.sourceType,
    input.sportId ?? 'na',
    input.leagueId ?? 'na',
    normalizeTeamName(input.homeTeam),
    normalizeTeamName(input.awayTeam),
    scheduledMinute,
  ].join('|');
  return stableHash(canonical);
}

/**
 * The key used to find an existing tracked match when the provider omitted an
 * event id.
 */
export function computeEventKey(input: FingerprintInput): string {
  return `fp:${buildMatchFingerprint(input)}`;
}

/**
 * The key stored on `historical_results`. The provider-event-id form is
 * preferred because it is stable across every field that could be re-spelled;
 * the fingerprint form is the safety net.
 */
export function computeHistoryDedupeKey(input: {
  sourceType: string;
  sportId: string | null;
  externalEventId: string | null;
  fingerprint: FingerprintInput;
}): string {
  if (input.externalEventId) {
    const sport = input.sportId ?? 'na';
    return `${input.sourceType}:${sport}:${input.externalEventId}`;
  }
  return `fp:${buildMatchFingerprint(input.fingerprint)}`;
}

/** Any row that carries a `dedupe_key`, i.e. a `historical_results` row. */
export interface DedupeIdentified {
  dedupeKey: string;
  source: 'SPORTYBET_HISTORY' | 'TRACKED_BY_APP';
}

export interface MergeConflict {
  dedupeKey: string;
  keptSource: DedupeIdentified['source'];
  appScore: string | null;
  providerScore: string | null;
}

export interface MergeOutcome<T> {
  merged: T[];
  appCount: number;
  providerCount: number;
  /** Number of keys present in both datasets. */
  overlapCount: number;
  conflicts: MergeConflict[];
}

function scorePair(
  row: { homeScore: number; awayScore: number },
): string {
  return `${row.homeScore}-${row.awayScore}`;
}

/**
 * Unions application-collected history with provider-supplied history.
 *
 * Provenance is respected: a key present in both datasets is stored exactly
 * once. When the two disagree on the scoreline the provider's figure wins,
 * because it is the authoritative record, but the conflict is reported so the
 * operator can inspect it rather than discovering a silent overwrite.
 */
export function mergeHistoricalRecords<
  T extends DedupeIdentified & { homeScore: number; awayScore: number },
>(appRows: T[], providerRows: T[]): MergeOutcome<T> {
  const byKey = new Map<string, T>();
  const conflicts: MergeConflict[] = [];

  for (const row of appRows) {
    byKey.set(row.dedupeKey, row);
  }

  for (const row of providerRows) {
    const existing = byKey.get(row.dedupeKey);
    if (!existing) {
      byKey.set(row.dedupeKey, row);
      continue;
    }

    const appScore = scorePair(existing);
    const providerScore = scorePair(row);
    if (appScore !== providerScore) {
      conflicts.push({
        dedupeKey: row.dedupeKey,
        keptSource: row.source,
        appScore,
        providerScore,
      });
    }
    // Provider history is authoritative on disagreement.
    byKey.set(row.dedupeKey, row);
  }

  const merged = [...byKey.values()].sort((a, b) => {
    const left = a.dedupeKey;
    const right = b.dedupeKey;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  return {
    merged,
    appCount: appRows.length,
    providerCount: providerRows.length,
    overlapCount: appRows.filter((row) =>
      providerRows.some((p) => p.dedupeKey === row.dedupeKey),
    ).length,
    conflicts,
  };
}