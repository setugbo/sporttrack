/**
 * Server-side URL allowlist.
 *
 * The tracker accepts a SportyBet page URL from the operator and turns it into
 * an API base. That makes this function a security boundary: the resulting
 * `apiBaseUrl` is the only host the server will ever issue an HTTP request to
 * from a user-supplied string. Anything not matched here is rejected outright,
 * so a crafted URL cannot turn the poller into an open proxy or an SSRF vector
 * against internal hosts.
 *
 * Rules:
 *   1. Must parse as an absolute https URL.
 *   2. Host must be an exact allowlisted host (no subdomains, no suffix tricks).
 *   3. Path must match an allowlisted page pattern, which also yields the
 *      provider's `countryCode` (the API path is country-scoped).
 *   4. Credentials, query strings and fragments are rejected.
 */

import type { SourceDescriptor } from './types.ts';

export class UrlNotAllowedError extends Error {
  readonly code = 'URL_NOT_ALLOWED';
  readonly input: string;

  constructor(message: string, input: string) {
    super(message);
    this.name = 'UrlNotAllowedError';
    this.input = input;
  }
}

/** Exact-match hosts. No wildcards and no leading-dot suffix matching. */
const ALLOWED_HOSTS = new Set([
  'www.sportybet.com',
  'sportybet.com',
  'm.sportybet.com',
]);

/** vFootball live-list page shapes observed across SportyBet storefronts. */
const PAGE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  countryCode: string;
  label: string;
}> = [
  {
    pattern: /^\/ng\/m\/sport\/vFootball\/live_list\/?$/i,
    countryCode: 'ng',
    label: 'vFootball (Nigeria, mobile)',
  },
  {
    pattern: /^\/ng\/sport\/vFootball\/live_list\/?$/i,
    countryCode: 'ng',
    label: 'vFootball (Nigeria)',
  },
  {
    pattern: /^\/m\/sport\/vFootball\/live_list\/?$/i,
    countryCode: '',
    label: 'vFootball (mobile)',
  },
  {
    pattern: /^\/sport\/vFootball\/live_list\/?$/i,
    countryCode: '',
    label: 'vFootball',
  },
];

/**
 * SportyBet's live feed endpoint. Discovered from the storefront JS bundle:
 * a fetch wrapper prefixes `/api`, then a per-storefront `__baseUrl__` of
 * `/ng/`, producing `/api/ng/factsCenter/wapEvents`.
 */
const EVENTS_PATH = '/factsCenter/wapEvents';

/** vFootball's factsCenter sport id, confirmed from the live feed response. */
export const VFOOTBALL_SPORT_ID = 'sr:sport:202120001';

function buildApiBaseUrl(host: string, countryCode: string): string {
  return countryCode
    ? `https://${host}/api/${countryCode}`
    : `https://${host}/api`;
}

function assertNoCredentialsOrNoise(parsed: URL, input: string): void {
  if (parsed.username || parsed.password) {
    throw new UrlNotAllowedError(
      'URL must not contain embedded credentials.',
      input,
    );
  }
  if (parsed.search) {
    throw new UrlNotAllowedError('URL must not contain a query string.', input);
  }
  if (parsed.hash) {
    throw new UrlNotAllowedError('URL must not contain a fragment.', input);
  }
}

export function isAllowedSourceUrl(input: string): boolean {
  try {
    resolveSource(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates `input` and derives everything the provider needs from it.
 * Returns a fresh descriptor; never trusts caller-supplied host or path parts.
 */
export function resolveSource(input: string): SourceDescriptor {
  const trimmed = input.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UrlNotAllowedError('Not a valid absolute URL.', input);
  }

  if (parsed.protocol !== 'https:') {
    throw new UrlNotAllowedError('Only https:// URLs are accepted.', input);
  }

  assertNoCredentialsOrNoise(parsed, input);

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new UrlNotAllowedError(
      `Host "${host}" is not an allowlisted SportyBet host.`,
      input,
    );
  }

  const match = PAGE_PATTERNS.find((candidate) =>
    candidate.pattern.test(parsed.pathname),
  );
  if (!match) {
    throw new UrlNotAllowedError(
      'URL path is not a recognised SportyBet vFootball live-list page. Expected something like /ng/m/sport/vFootball/live_list.',
      input,
    );
  }

  const countryCode = match.countryCode;

  return {
    provider: 'sportybet',
    name: `SportyBet ${match.label}`,
    pageUrl: `https://${host}${parsed.pathname.replace(/\/+$/, '')}`,
    apiBaseUrl: buildApiBaseUrl(host, countryCode),
    countryCode,
    // Resolved server-side from a constant, never echoed from user input.
    sportId: VFOOTBALL_SPORT_ID,
    eventsPath: EVENTS_PATH,
    // Confirmed by investigation: SportyBet exposes no usable vFootball
    // historical endpoint, so history must be application-collected.
    providerHasHistory: false,
  };
}

/**
 * Joins a validated descriptor onto its endpoint path. Kept separate so no
 * call site can concatenate a raw user string into a request URL.
 */
export function buildEventsUrl(descriptor: SourceDescriptor): string {
  return `${descriptor.apiBaseUrl}${descriptor.eventsPath}`;
}