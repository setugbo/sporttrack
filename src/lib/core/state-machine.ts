/**
 * Completion-detection state machine.
 *
 * This is the only module that decides when a match counts as finished, and it
 * is deliberately conservative. The governing constraint, established by
 * investigation (docs/sportybet-integration.md sections 4-6), is that
 * SportyBet's vFootball live feed:
 *
 *   - never reports a terminal status (no "FT", no "90:00"),
 *   - caps `playedSeconds` at 89:00, and
 *   - removes a completed event from the feed ~24 seconds later.
 *
 * So the tracker must infer completion from the match *leaving the feed*, and
 * may only do so once enough evidence has accumulated. When that evidence is
 * missing the correct answer is UNKNOWN, and an UNKNOWN match must never enter
 * historical results. Writing a guessed final score into history would be worse
 * than writing nothing, because every downstream statistic would inherit it.
 *
 * Pure module: no database, no clock, no network. `now` is injected.
 */

import { mapProviderStatus } from './provider.ts';
import {
  DEFAULT_COMPLETION_SETTINGS,
  type CompletionSettings,
  type FinishConfidence,
  type FinishReason,
  type MatchStatus,
  type ProviderEvent,
  type TrackedMatch,
} from './types.ts';

export interface ClassificationInput {
  match: TrackedMatch;
  /** The event as seen this poll, or `null` when it was absent. */
  observation: ProviderEvent | null;
  settings?: CompletionSettings;
  now: Date;
}

export interface ClassificationResult {
  status: MatchStatus;
  finishReason: FinishReason | null;
  finishConfidence: FinishConfidence;
  absentPolls: number;
  seenCount: number;
  clock: string | null;
  clockMinute: number | null;
  maxClockMinute: number | null;
  homeScore: number | null;
  awayScore: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Persist this progression as a `match_snapshots` row. */
  writeSnapshot: boolean;
  /** Insert a `historical_results` row. Never true without both scores. */
  writeHistory: boolean;
  /** Ordered trace of the reasoning, surfaced on the debug screen. */
  notes: string[];
}

function hasBothScores(home: number | null, away: number | null): boolean {
  return typeof home === 'number' && typeof away === 'number';
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Terminal statuses must never regress, regardless of what the feed reports. */
function isTerminal(status: MatchStatus): boolean {
  return status === 'FINISHED' || status === 'CANCELLED';
}

export function classifyMatch(input: ClassificationInput): ClassificationResult {
  const settings = input.settings ?? DEFAULT_COMPLETION_SETTINGS;
  const { match, observation, now } = input;
  const notes: string[] = [];

  const base = {
    absentPolls: match.absentPolls,
    seenCount: match.seenCount,
    clock: match.clock,
    clockMinute: match.clockMinute,
    maxClockMinute: match.maxClockMinute,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    htHomeScore: match.htHomeScore,
    htAwayScore: match.htAwayScore,
    startedAt: match.startedAt,
    finishedAt: match.finishedAt,
    writeSnapshot: false,
    writeHistory: false,
  } satisfies Omit<
    ClassificationResult,
    | 'status'
    | 'finishReason'
    | 'finishConfidence'
    | 'notes'
    | 'htHomeScore'
    | 'htAwayScore'
  > & { htHomeScore: number | null; htAwayScore: number | null };

  // -------------------------------------------------------------------------
  // Case 1: event present in the feed this poll.
  // -------------------------------------------------------------------------
  if (observation) {
    notes.push('Event present in feed.');

    // A sighting always clears the absence counter and counts towards evidence.
    const present = {
      ...base,
      absentPolls: 0,
      seenCount: match.seenCount + 1,
      homeScore: observation.homeScore ?? base.homeScore,
      awayScore: observation.awayScore ?? base.awayScore,
      htHomeScore: observation.htHomeScore ?? base.htHomeScore,
      htAwayScore: observation.htAwayScore ?? base.htAwayScore,
      clock: observation.clock ?? base.clock,
      clockMinute: observation.clockMinute ?? base.clockMinute,
      maxClockMinute: maxNullable(base.maxClockMinute, observation.clockMinute),
      startedAt:
        base.startedAt ??
        (observation.clockMinute !== null && observation.clockMinute > 0
          ? now
          : null),
    };

    const providerStatus = mapProviderStatus(
      observation.rawStatus,
      observation.rawMatchStatus,
    );
    notes.push(`Provider status "${observation.rawStatus ?? ''}/${observation.rawMatchStatus ?? ''}" -> ${providerStatus}.`);

    // Terminal states are sticky: a completed match must not be reopened
    // because a later poll misreported it.
    if (isTerminal(match.status)) {
      notes.push('Match already terminal; ignoring provider regression.');
      return {
        ...present,
        status: match.status,
        finishReason: match.finishReason,
        finishConfidence: match.finishConfidence,
        notes,
      };
    }

    if (providerStatus === 'CANCELLED') {
      notes.push('Provider reported cancellation/postponement. Not historical.');
      return {
        ...present,
        status: 'CANCELLED',
        finishReason: 'PROVIDER_CANCELLED',
        finishConfidence: 'DEFINITIVE',
        writeSnapshot: true,
        notes,
      };
    }

    if (providerStatus === 'FINISHED') {
      notes.push('Provider reported a terminal status. Definitive completion.');
      if (!hasBothScores(present.homeScore, present.awayScore)) {
        notes.push(
          'Terminal status without both scores; cannot write history. Marked UNKNOWN instead.',
        );
        return {
          ...present,
          status: 'UNKNOWN',
          finishReason: null,
          finishConfidence: 'NONE',
          writeSnapshot: true,
          notes,
        };
      }
      return {
        ...present,
        status: 'FINISHED',
        finishReason: 'TERMINAL_STATUS',
        finishConfidence: 'DEFINITIVE',
        finishedAt: now,
        writeSnapshot: true,
        writeHistory: true,
        notes,
      };
    }

    // Clock reached full time while still listed. SportyBet caps at 89:00, so
    // this is a forward-compatible path rather than the normal route, but it
    // is authoritative enough to finish when a score is available.
    const maxMinute = present.maxClockMinute;
    if (
      maxMinute !== null &&
      maxMinute >= settings.regulationMinutes &&
      hasBothScores(present.homeScore, present.awayScore)
    ) {
      notes.push(
        `Clock reached ${maxMinute}' (regulation ${settings.regulationMinutes}').`,
      );
      return {
        ...present,
        status: 'FINISHED',
        finishReason: 'REGULATION_CLOCK_REACHED',
        finishConfidence: 'HIGH',
        finishedAt: now,
        writeSnapshot: true,
        writeHistory: true,
        notes,
      };
    }

    if (providerStatus === 'LIVE') {
      if (match.status !== 'LIVE') {
        notes.push(`Transition ${match.status} -> LIVE.`);
      }
      return {
        ...present,
        status: 'LIVE',
        finishReason: null,
        finishConfidence: 'NONE',
        writeSnapshot: hasBothScores(present.homeScore, present.awayScore),
        notes,
      };
    }

    // DISCOVERED. If the match was previously observed live, a regression to
    // "not start" is treated as a provider glitch and the match stays LIVE.
    if (match.status === 'LIVE') {
      notes.push('Provider regressed to "not start" after being live; keeping LIVE.');
      return {
        ...present,
        status: 'LIVE',
        finishReason: null,
        finishConfidence: 'NONE',
        writeSnapshot: false,
        notes,
      };
    }

    notes.push('Scheduled (not started).');
    return {
      ...present,
      status: 'DISCOVERED',
      finishReason: null,
      finishConfidence: 'NONE',
      writeSnapshot: false,
      notes,
    };
  }

  // -------------------------------------------------------------------------
  // Case 2: event absent from the feed this poll.
  // -------------------------------------------------------------------------
  notes.push('Event absent from feed.');
  const absentPolls = match.absentPolls + 1;

  // Terminal states stay terminal and stop accruing absence.
  if (isTerminal(match.status)) {
    return {
      ...base,
      absentPolls,
      status: match.status,
      finishReason: match.finishReason,
      finishConfidence: match.finishConfidence,
      notes,
    };
  }

  const bestClock = match.maxClockMinute ?? match.clockMinute;
  const everObservedLive = match.status === 'LIVE' || match.startedAt !== null;

  // The feed is a rolling window, so a scheduled match can simply age out.
  // Only after several successful absences is it safe to conclude the event was
  // dropped without ever being played.
  if (!everObservedLive) {
    if (absentPolls >= settings.maxAbsentPolls) {
      notes.push(
        `Never observed live and absent for ${absentPolls} successful polls; outcome UNKNOWN.`,
      );
      return {
        ...base,
        absentPolls,
        status: 'UNKNOWN',
        finishReason: null,
        finishConfidence: 'NONE',
        notes,
      };
    }
    notes.push(
      `Never observed live; retaining DISCOVERED (absence ${absentPolls}/${settings.maxAbsentPolls}).`,
    );
    return {
      ...base,
      absentPolls,
      status: 'DISCOVERED',
      finishReason: null,
      finishConfidence: 'NONE',
      notes,
    };
  }

  // Was live. Absence becomes evidence of completion only once the clock had
  // reached the late-game threshold, the absence is confirmed across multiple
  // successful polls, and a final score is actually available.
  const lateEnough =
    bestClock !== null && bestClock >= settings.highConfidenceClockMinutes;

  if (lateEnough && absentPolls >= settings.confirmAbsentPolls) {
    if (!hasBothScores(match.homeScore, match.awayScore)) {
      notes.push(
        `Disappeared after ${bestClock}' but no complete score was captured; outcome UNKNOWN, not historical.`,
      );
      return {
        ...base,
        absentPolls,
        status: 'UNKNOWN',
        finishReason: null,
        finishConfidence: 'NONE',
        notes,
      };
    }
    notes.push(
      `Disappeared at ${bestClock}' after ${absentPolls} successful absences; completed match recorded from last observed score.`,
    );
    return {
      ...base,
      absentPolls,
      status: 'FINISHED',
      finishReason: 'DISAPPEARED_AFTER_LATE_CLOCK',
      finishConfidence: 'HIGH',
      finishedAt: now,
      writeHistory: true,
      notes,
    };
  }

  if (!lateEnough) {
    // The feed is a rolling window and a match that leaves it before the
    // late-game threshold can never produce confirmed evidence either way.
    // Closing it as UNKNOWN keeps it out of history and stops it lingering as
    // a live row on the dashboard.
    if (absentPolls >= settings.maxAbsentPolls) {
      notes.push(
        `Absent for ${absentPolls} successful polls without reaching ${settings.highConfidenceClockMinutes}'; outcome UNKNOWN, not historical.`,
      );
      return {
        ...base,
        absentPolls,
        status: 'UNKNOWN',
        finishReason: null,
        finishConfidence: 'NONE',
        notes,
      };
    }
    notes.push(
      `Disappeared at ${bestClock ?? 0}', below the ${settings.highConfidenceClockMinutes}' threshold; treating as mid-match drop. Retaining LIVE.`,
    );
    return {
      ...base,
      absentPolls,
      status: 'LIVE',
      finishReason: null,
      finishConfidence: 'NONE',
      notes,
    };
  }

  notes.push(
    `Late-clock disappearance awaiting confirmation (${absentPolls}/${settings.confirmAbsentPolls}).`,
  );
  return {
    ...base,
    absentPolls,
    status: 'LIVE',
    finishReason: null,
    finishConfidence: 'NONE',
    notes,
  };
}