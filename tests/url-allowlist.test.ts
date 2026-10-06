import { describe, expect, it } from 'vitest';
import {
  VFOOTBALL_SPORT_ID,
  buildEventsUrl,
  isAllowedSourceUrl,
  resolveSource,
  UrlNotAllowedError,
} from '../src/lib/core/url-allowlist';

const VALID = 'https://www.sportybet.com/ng/m/sport/vFootball/live_list';

describe('resolveSource', () => {
  it('accepts the confirmed live-list URL and derives the endpoint', () => {
    const descriptor = resolveSource(VALID);

    expect(descriptor.provider).toBe('sportybet');
    expect(descriptor.pageUrl).toBe(VALID);
    expect(descriptor.apiBaseUrl).toBe('https://www.sportybet.com/api/ng');
    expect(descriptor.countryCode).toBe('ng');
    expect(descriptor.sportId).toBe(VFOOTBALL_SPORT_ID);
    expect(buildEventsUrl(descriptor)).toBe(
      'https://www.sportybet.com/api/ng/factsCenter/wapEvents',
    );
    expect(descriptor.providerHasHistory).toBe(false);
  });

  it('tolerates surrounding whitespace and a trailing slash', () => {
    const descriptor = resolveSource(`  ${VALID}/  `);
    expect(descriptor.apiBaseUrl).toBe('https://www.sportybet.com/api/ng');
  });

  it('accepts the other known vFootball page shapes', () => {
    expect(() =>
      resolveSource('https://sportybet.com/sport/vFootball/live_list'),
    ).not.toThrow();
    expect(() =>
      resolveSource('https://m.sportybet.com/m/sport/vFootball/live_list'),
    ).not.toThrow();
  });

  it.each([
    ['garbage', 'not a URL'],
    ['/ng/m/sport/vFootball/live_list', 'relative URL'],
    ['http://www.sportybet.com/ng/m/sport/vFootball/live_list', 'not https'],
    ['https://www.sportybet.com.evil.com/ng/m/sport/vFootball/live_list', 'suffix attack'],
    ['https://evil.sportybet.com/ng/m/sport/vFootball/live_list', 'subdomain'],
    ['https://www.sportybet.com/', 'wrong path'],
    ['https://www.sportybet.com/ng/m/sport/football/live_list', 'not vFootball'],
    ['https://www.sportybet.com/ng/m/sport/vFootball/live_list?x=1', 'query string'],
    ['https://www.sportybet.com/ng/m/sport/vFootball/live_list#top', 'fragment'],
    ['https://user:pass@www.sportybet.com/ng/m/sport/vFootball/live_list', 'credentials'],
    ['https://127.0.0.1/ng/m/sport/vFootball/live_list', 'internal host'],
  ])('rejects %s (%s)', (input) => {
    expect(() => resolveSource(input)).toThrow(UrlNotAllowedError);
    expect(isAllowedSourceUrl(input)).toBe(false);
  });

  it('never derives an endpoint outside the allowlisted host', () => {
    const descriptor = resolveSource(VALID);
    const url = new URL(buildEventsUrl(descriptor));
    expect(url.host).toBe('www.sportybet.com');
    expect(url.protocol).toBe('https:');
  });

  it('exposes isAllowedSourceUrl as a boolean convenience', () => {
    expect(isAllowedSourceUrl(VALID)).toBe(true);
    expect(isAllowedSourceUrl('https://attacker.example/fetch')).toBe(false);
  });
});