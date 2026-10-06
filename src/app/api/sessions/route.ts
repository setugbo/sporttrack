import { z } from 'zod';
import { asRecord, errorMessage, fail, json, readJsonBody, stringParam } from '@/lib/api/helpers';
import { isAllowedSourceUrl, resolveSource } from '@/lib/core/url-allowlist';
import { DEFAULT_COMPLETION_SETTINGS } from '@/lib/core/types';
import { getSql } from '@/lib/db/client';
import {
  createSession,
  endSession,
  getSourceByUrl,
  listSessions,
} from '@/lib/db/queries';

/**
 * Tracking-session lifecycle.
 *
 * One open session per source is enforced by a partial unique index, which is
 * what prevents duplicate tracking sessions for the same events and therefore
 * duplicate history rows.
 */

export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  url: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  trackAll: z.boolean().optional(),
  pollInterval: z.number().int().min(10).max(300).optional(),
  settings: z
    .object({
      regulationMinutes: z.number().int().min(1).max(200).optional(),
      highConfidenceClockMinutes: z.number().int().min(1).max(200).optional(),
      confirmAbsentPolls: z.number().int().min(1).max(20).optional(),
      maxAbsentPolls: z.number().int().min(1).max(50).optional(),
    })
    .optional(),
});

function defaultPollInterval(): number {
  const raw = Number.parseInt(process.env.DEFAULT_POLL_INTERVAL ?? '30', 10);
  return Number.isFinite(raw) && raw >= 10 && raw <= 300 ? raw : 30;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const url = stringParam(params, 'url');

  try {
    const sql = getSql();

    if (url) {
      const descriptor = resolveSource(url);
      const source = await getSourceByUrl(descriptor.pageUrl, sql);
      if (!source) return fail('No source registered for that URL.', 404);
      return json({ sourceId: source.id, sessions: await listSessions(source.id, sql) });
    }

    return json({ sessions: await listSessions(undefined, sql) });
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

  const { url, name, trackAll, pollInterval, settings } = parsed.data;

  if (!isAllowedSourceUrl(url)) {
    return fail('That URL is not an allowlisted SportyBet vFootball page.', 400);
  }

  try {
    const sql = getSql();
    const descriptor = resolveSource(url);
    const source = await getSourceByUrl(descriptor.pageUrl, sql);
    if (!source) {
      return fail('No source registered for that URL. POST to /api/sources first.', 404);
    }

    const session = await createSession({
      sourceId: source.id,
      name: name ?? `Tracking ${new Date().toISOString().slice(0, 16)}`,
      sourceUrl: descriptor.pageUrl,
      // Default to following everything: with vFootball's fixed slate that is
      // what makes history accumulate, and it is bounded by the feed size.
      trackAll: trackAll ?? true,
      pollInterval: pollInterval ?? defaultPollInterval(),
      settings: settings ?? DEFAULT_COMPLETION_SETTINGS,
    });

    return json({ session }, 201);
  } catch (error) {
    return fail(errorMessage(error), 409);
  }
}

export async function PATCH(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) return fail(body.message, 415);

  const record = asRecord(body.data);
  const action = record.action;

  if (action !== 'end') {
    return fail('Expected { action: "end", sessionId } for now.', 400);
  }

  const sessionId = record.sessionId;
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    return fail('sessionId is required.', 400);
  }

  try {
    const sql = getSql();
    const session = await endSession(sessionId.trim(), sql);
    if (!session) return fail('No open session with that id.', 404);
    return json({ session });
  } catch (error) {
    return fail(errorMessage(error), 500);
  }
}