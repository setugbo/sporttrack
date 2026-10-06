/**
 * Single polling run.
 *
 *   npm run poll:once             poll every registered source once
 *   npm run poll:once -- --start  also open a tracking session (first run)
 *
 * The poller self-throttles to the session interval, so running this more
 * often than that reports `skipped` rather than hammering upstream.
 *
 * Invoked with `--conditions=react-server` so the application's `server-only`
 * marker resolves to its empty module outside of Next's bundler.
 */
import './load-env.mjs';

import { runMigrations } from '../src/lib/db/client.ts';
import {
  countHistoricalResults,
  createSession,
  getActiveSession,
  getSourceByUrl,
  insertSource,
  listSources,
} from '../src/lib/db/queries.ts';
import {
  UrlNotAllowedError,
  resolveSource,
} from '../src/lib/core/url-allowlist.ts';
import { pollAllSources } from '../src/lib/services/tracker.service.ts';

const DEFAULT_URL =
  process.env.DEFAULT_SOURCE_URL?.trim() ||
  'https://www.sportybet.com/ng/m/sport/vFootball/live_list';

function wantsSessionStart(): boolean {
  return process.argv.includes('--start');
}

function defaultPollInterval(): number {
  const raw = Number.parseInt(process.env.DEFAULT_POLL_INTERVAL ?? '30', 10);
  return Number.isFinite(raw) && raw >= 10 && raw <= 300 ? raw : 30;
}

const DEFAULT_SETTINGS = {
  regulationMinutes: 90,
  highConfidenceClockMinutes: 88,
  confirmAbsentPolls: 2,
  maxAbsentPolls: 6,
};

/**
 * Registers the default source when it is allowlisted and not yet present, so
 * a fresh checkout reaches a working state from a single command.
 */
async function ensureDefaultSource(): Promise<void> {
  try {
    const descriptor = resolveSource(DEFAULT_URL);
    const existing = await getSourceByUrl(descriptor.pageUrl);
    if (existing) return;
    const source = await insertSource(descriptor);
    console.log(`Registered source ${source.name} (${source.sourceUrl})`);
  } catch (error) {
    if (error instanceof UrlNotAllowedError) {
      console.log(`Default URL not allowlisted, skipped: ${error.message}`);
      return;
    }
    console.log(
      `Could not register default source: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function startSessions(sources: Awaited<ReturnType<typeof listSources>>) {
  for (const source of sources) {
    const existing = await getActiveSession(source.id);
    if (existing) {
      console.log(
        `Session already open for ${source.name}: "${existing.name}" (${existing.status})`,
      );
      continue;
    }
    const session = await createSession({
      sourceId: source.id,
      name: `Started ${new Date().toISOString().slice(0, 16)}Z`,
      sourceUrl: source.sourceUrl,
      trackAll: true,
      pollInterval: defaultPollInterval(),
      settings: DEFAULT_SETTINGS,
    });
    console.log(
      `Started session "${session.name}" for ${source.name} (every ${session.pollInterval}s)`,
    );
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.');
    process.exitCode = 1;
    return;
  }

  const applied = await runMigrations();
  if (applied.length > 0) {
    console.log(`Applied ${applied.length} migration(s).`);
  }

  await ensureDefaultSource();
  const sources = await listSources();

  if (sources.length === 0) {
    console.error('No source registered. Run:  npm run db:seed');
    process.exitCode = 1;
    return;
  }

  if (wantsSessionStart()) {
    await startSessions(sources);
  }

  const results = await pollAllSources();

  for (const { source, outcome } of results) {
    console.log(`${source.name} — ${outcome.upstreamUrl}`);

    if (outcome.throttled) {
      console.log('  skipped: last poll was within the configured interval');
      continue;
    }

    if (outcome.httpStatus === null && outcome.bizCode === null && outcome.eventsSeen === 0) {
      console.log('  upstream request failed — see /api/debug or the poll_runs table');
      process.exitCode = 1;
      continue;
    }

    console.log(`  events seen:       ${outcome.eventsSeen}`);
    console.log(`  new matches:       ${outcome.newMatches}`);
    console.log(`  updated:           ${outcome.updatedMatches}`);
    console.log(`  finished this run: ${outcome.finishedMatches}`);
    console.log(`  unknown:           ${outcome.unknownMatches}`);
    console.log(`  history written:   +${outcome.resultsWritten}`);
  }

  // Without this the operator cannot tell whether the completion detector has
  // actually produced anything yet.
  console.log('');
  console.log(`Historical results recorded so far: ${await countHistoricalResults({})}`);
}

main().catch((error) => {
  console.error(`Poll failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});