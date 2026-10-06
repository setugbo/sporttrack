'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Triggers a server-side poll and refreshes the view.
 *
 * The browser cannot call SportyBet directly (no CORS headers upstream), so
 * this only requests our own server, which is also the only safe place for the
 * upstream call.
 */
export function PollNowButton({
  url,
  label = 'Poll now',
}: {
  url?: string;
  label?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setResult(null);
    setError(null);
    try {
      const response = await fetch('/api/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(url ? { url } : {}),
      });
      const body = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        setError(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
        return;
      }

      const summary = body as {
        eventsSeen?: number;
        newMatches?: number;
        finishedMatches?: number;
        resultsWritten?: number;
        throttled?: boolean;
      };
      setResult(
        summary.throttled === true
          ? 'Skipped: last poll was too recent.'
          : `Seen ${summary.eventsSeen ?? 0} · new ${summary.newMatches ?? 0} · finished ${summary.finishedMatches ?? 0} · history +${summary.resultsWritten ?? 0}`,
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="toolbar" style={{ marginBottom: 0 }}>
      <button type="button" className="btn-primary" onClick={run} disabled={pending}>
        {pending ? 'Polling…' : label}
      </button>
      {result ? <span className="faint mono">{result}</span> : null}
      {error ? <span className="mono" style={{ color: 'var(--bad)' }}>{error}</span> : null}
    </div>
  );
}