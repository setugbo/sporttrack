import { z } from 'zod';
import { asRecord, errorMessage, fail, json, readJsonBody } from '@/lib/api/helpers';
import { isAllowedSourceUrl, resolveSource } from '@/lib/core/url-allowlist';
import { getSql } from '@/lib/db/client';
import {
  getSourceByUrl,
  insertSource,
  listSources,
  updateSourceHistoricalMode,
} from '@/lib/db/queries';

/**
 * Source registration. Every submitted URL is re-validated against the
 * server-side allowlist; nothing else in the request can influence where the
 * server will make outbound requests.
 */

export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  url: z.string().trim().min(1, 'A source URL is required.'),
});

const ModeBody = z.object({
  url: z.string().trim().min(1),
  historicalMode: z.enum(['PROVIDER_HISTORY', 'APP_TRACKED', 'HYBRID']),
});

const ALLOWED_MODES = ['PROVIDER_HISTORY', 'APP_TRACKED', 'HYBRID'] as const;

export async function GET() {
  try {
    const rows = await listSources();
    return json({
      sources: rows.map((row) => ({
        id: row.id,
        name: row.name,
        url: row.sourceUrl,
        baseUrl: row.baseUrl,
        status: row.status,
        historicalMode: row.historicalMode,
        lastPollAt: row.lastPollAt,
        lastOkAt: row.lastOkAt,
        lastError: row.lastError,
      })),
    });
  } catch (error) {
    return fail(errorMessage(error), 500);
  }
}

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) return fail(body.message, 415);

  const parsed = CreateBody.safeParse(asRecord(body.data));
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? 'Invalid request body.', 400);
  }

  const { url } = parsed.data;

  if (!isAllowedSourceUrl(url)) {
    return fail(
      'That URL is not an allowlisted SportyBet vFootball live-list page. Expected something like https://www.sportybet.com/ng/m/sport/vFootball/live_list',
      400,
    );
  }

  try {
    const sql = getSql();

    // Idempotent: the same page can be submitted repeatedly without creating
    // duplicate sources, which would double-count every poll.
    const existing = await getSourceByUrl(url, sql);
    if (existing) {
      return json({ source: existing, created: false }, 200);
    }

    const descriptor = resolveSource(url);
    const source = await insertSource(descriptor, sql);
    return json({ source, created: true }, 201);
  } catch (error) {
    return fail(errorMessage(error), 500);
  }
}

/** Switches a source's history pipeline. */
export async function PATCH(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) return fail(body.message, 415);

  const parsed = ModeBody.safeParse(asRecord(body.data));
  if (!parsed.success) {
    return fail(
      `Expected { url: string, historicalMode: one of ${ALLOWED_MODES.join(', ')} }.`,
      400,
    );
  }

  try {
    const sql = getSql();
    const existing = await getSourceByUrl(parsed.data.url, sql);
    if (!existing) {
      return fail('No source is registered for that URL.', 404);
    }
    await updateSourceHistoricalMode(existing.id, parsed.data.historicalMode, sql);
    return json({
      sourceId: existing.id,
      historicalMode: parsed.data.historicalMode,
    });
  } catch (error) {
    return fail(errorMessage(error), 500);
  }
}