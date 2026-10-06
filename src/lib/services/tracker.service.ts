import 'server-only';

import { createSportyBetProvider } from '../core/provider.ts';
import { resolveSource } from '../core/url-allowlist.ts';
import type { SourceDescriptor } from '../core/types.ts';
import { getSql, type Sql } from '../db/client.ts';
import {
  descriptorFromSource,
  getActiveSession,
  getSource,
  getSourceByUrl,
  listSources,
  type SourceRow,
  type TrackingSessionRow,
} from '../db/queries.ts';
import { runPoll, type PollOutcome } from './poll.service.ts';

/**
 * Entry point used by the cron endpoint, the manual poll endpoint and the CLI.
 * Resolves the source and its open session, then delegates to the poller.
 */

export function upstreamTimeoutMs(): number {
  const raw = Number.parseInt(process.env.UPSTREAM_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

export async function pollSource(
  source: SourceRow,
  options: { force?: boolean; now?: Date; sql?: Sql } = {},
): Promise<{ source: SourceRow; session: TrackingSessionRow | null; outcome: PollOutcome }> {
  const sql = options.sql ?? getSql();
  const session = await getActiveSession(source.id, sql);
  const provider = createSportyBetProvider();

  const outcome = await runPoll(
    provider,
    {
      source,
      session,
      descriptor: descriptorFromSource(source),
      timeoutMs: upstreamTimeoutMs(),
      now: options.now,
    },
    sql,
  );

  return { source, session, outcome };
}

/**
 * Resolves an operator-supplied URL to a stored source. The URL is re-validated
 * through the allowlist on every use, so a row that was tampered with directly
 * in the database still cannot redirect the server's outbound requests.
 */
export async function resolveStoredSourceByUrl(
  url: string,
  sql: Sql = getSql(),
): Promise<{ source: SourceRow; descriptor: SourceDescriptor }> {
  const descriptor = resolveSource(url);
  const stored = await getSourceByUrl(descriptor.pageUrl, sql);
  if (!stored) {
    throw new Error(
      `No source is registered for ${descriptor.pageUrl}. Seed one with \`npm run db:seed\` or POST to /api/sources.`,
    );
  }
  // Prefer the freshly derived endpoint config over the stored copy so a code
  // change to the allowlist takes effect without a database migration.
  return { source: stored, descriptor };
}

export async function pollAllSources(
  options: { sql?: Sql } = {},
): Promise<Array<{ source: SourceRow; outcome: PollOutcome }>> {
  const sql = options.sql ?? getSql();
  const sources = await listSources(sql);
  const results: Array<{ source: SourceRow; outcome: PollOutcome }> = [];

  for (const source of sources) {
    if (source.status === 'PAUSED') continue;
    const { outcome } = await pollSource(source, { sql });
    results.push({ source, outcome });
  }

  return results;
}

/** Loads a source by id or 404-style error. */
export async function requireSource(id: string, sql: Sql = getSql()): Promise<SourceRow> {
  const source = await getSource(id, sql);
  if (!source) {
    throw new Error(`No source with id ${id}.`);
  }
  return source;
}