import { NextResponse } from 'next/server';

/** Shared helpers for JSON responses, cron auth and request validation. */

export function json<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data as unknown as Record<string, unknown>, { status });
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/**
 * Vercel Cron authenticates with `Authorization: Bearer $CRON_SECRET`.
 * If no secret is configured the endpoint stays open, which is convenient for
 * cPanel cron but should not be relied on for a public Vercel deployment.
 */
export function isAuthorisedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = request.headers.get('authorization');
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return match[1] === secret;
}

/**
 * True for a browser request issued from this application's own origin.
 *
 * The dashboard's "Poll now" button cannot carry the cron secret, so it is
 * authorised by origin instead: browsers always attach `Origin` to a POST, and
 * an attacker's page would attach *its* origin, which never matches. With both
 * `Origin` and `Sec-Fetch-Site` absent the caller is a non-browser client,
 * which must use `Authorization: Bearer $CRON_SECRET`.
 */
export function isSameOriginBrowser(request: Request): boolean {
  const host = request.headers.get('host');
  if (!host) return false;

  const origin = request.headers.get('origin');
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/** Coerces a search param to a bounded integer. */
export function intParam(
  params: URLSearchParams,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function stringParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key);
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Reads and validates a JSON body, returning a discriminated result. */
export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return {
      ok: false,
      message: 'Request body must be application/json.',
    };
  }
  try {
    return { ok: true, data: await request.json() };
  } catch {
    return { ok: false, message: 'Request body is not valid JSON.' };
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}