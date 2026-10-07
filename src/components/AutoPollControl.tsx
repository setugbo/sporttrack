'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const INTERVAL_MS = 30_000;
const STORAGE_KEY = 'tracker:auto-poll';

/**
 * Keeps the dashboard collecting while it is open.
 *
 * Same-origin POST to /api/poll, which the server accepts without the cron
 * secret, so the upstream call and the secret never leave the server. The
 * tick pauses while the tab is hidden, and a throttled response (someone else
 * polled within the session's interval) is not worth refreshing for.
 */
export function AutoPollControl({ url }: { url: string }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [last, setLast] = useState<string | null>(null);

  // Read the stored preference after mount so server HTML and the hydrated
  // first render agree.
  useEffect(() => {
    setEnabled(window.localStorage.getItem(STORAGE_KEY) !== 'off');
  }, []);

  useEffect(() => {
    if (enabled !== true) return;

    let cancelled = false;
    let busy = false;

    async function tick() {
      if (cancelled || busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const response = await fetch('/api/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        if (!response.ok || cancelled) return;

        const body = (await response.json()) as {
          throttled?: boolean;
          newMatches?: number;
          updatedMatches?: number;
          finishedMatches?: number;
          resultsWritten?: number;
        };
        if (cancelled) return;

        const changed =
          (body.newMatches ?? 0) +
          (body.updatedMatches ?? 0) +
          (body.finishedMatches ?? 0);
        const stamp = new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        setLast(
          body.throttled
            ? `${stamp} · throttled`
            : changed > 0
              ? `${stamp} · updated ${changed} · history +${body.resultsWritten ?? 0}`
              : `${stamp} · no change`,
        );
        if (!body.throttled && changed > 0) router.refresh();
      } catch {
        // Transient failure; the next tick simply retries.
      } finally {
        busy = false;
      }
    }

    // Poll immediately on mount so the view catches up, then keep it warm.
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled, url, router]);

  function toggle() {
    const next = enabled !== true;
    setEnabled(next);
    window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
  }

  return (
    <div className="toolbar" style={{ marginBottom: 0 }}>
      <button type="button" className={enabled ? 'btn-primary' : undefined} onClick={toggle}>
        {enabled === null ? 'Auto-poll…' : enabled ? 'Auto-poll on' : 'Auto-poll off'}
      </button>
      {last ? <span className="faint mono">{last}</span> : null}
    </div>
  );
}
