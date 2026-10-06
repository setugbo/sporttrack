import { PollNowButton } from '@/components/PollNowButton';
import { Empty, formatTime, relativeTime } from '@/components/ui';
import { buildEventsUrl, resolveSource } from '@/lib/core/url-allowlist';
import { checkDatabase } from '@/lib/db/client';
import { listPollRuns, listSources } from '@/lib/db/queries';
import { upstreamTimeoutMs } from '@/lib/services/tracker.service';

export const dynamic = 'force-dynamic';

/**
 * Raw-data view: exactly what is requested upstream, what came back, and how
 * each poll was interpreted.
 *
 * This exists so the collection process can be audited without trusting the
 * dashboard's aggregates. No credentials are involved or displayed.
 */
export default async function DebugPage() {
  if (process.env.DISABLE_DEBUG_SCREEN === '1') {
    return (
      <>
        <h1>Debug screen disabled</h1>
        <p className="subtitle">
          <code>DISABLE_DEBUG_SCREEN=1</code> is set for this deployment.
        </p>
      </>
    );
  }

  const database = await checkDatabase();
  if (!database.ok) {
    return (
      <>
        <h1>Raw data</h1>
        <div className="notice danger">
          Database unavailable: {database.error ?? 'schema not migrated'}
        </div>
      </>
    );
  }

  const sources = await listSources();
  const source = sources[0];

  if (!source) {
    return (
      <>
        <h1>Raw data</h1>
        <div className="notice">No source registered. Run <code>npm run db:seed</code> first.</div>
      </>
    );
  }

  // Derived server-side, never from the query string.
  const descriptor = resolveSource(source.sourceUrl);
  const upstreamUrl = buildEventsUrl(descriptor);
  const polls = await listPollRuns(source.id, 10);

  return (
    <>
      <h1>Raw data</h1>
      <p className="subtitle">
        The exact upstream request and the raw responses behind the dashboard
        figures.
      </p>

      <section className="section">
        <h2>Upstream request</h2>
        <div className="card">
          <div className="toolbar" style={{ justifyContent: 'space-between' }}>
            <span className="mono">{source.name}</span>
            <PollNowButton url={source.sourceUrl} label="Fetch now" />
          </div>
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>Page URL</dt>
            <dd>{descriptor.pageUrl}</dd>
            <dt>Endpoint</dt>
            <dd>{upstreamUrl}</dd>
            <dt>Method</dt>
            <dd>POST</dd>
            <dt>Content-Type</dt>
            <dd>application/json</dd>
            <dt>Authentication</dt>
            <dd>none required (OperId is sent by the web app but not enforced)</dd>
            <dt>Timeout</dt>
            <dd>{upstreamTimeoutMs()} ms</dd>
            <dt>Sport id</dt>
            <dd>{descriptor.sportId ?? '—'}</dd>
            <dt>Provider history</dt>
            <dd>{descriptor.providerHasHistory ? 'available' : 'not available'}</dd>
          </dl>

          <h3 style={{ marginTop: 16 }}>Request body</h3>
          <pre className="raw">
            {JSON.stringify(
              [
                {
                  sportId: descriptor.sportId,
                  withTwoUpMarket: true,
                  withOneUpMarket: true,
                },
              ],
              null,
              2,
            )}
          </pre>
          <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
            The array wrapper is required. A bare JSON object or a form-encoded
            body is rejected by the endpoint.
          </p>
        </div>
      </section>

      <section className="section">
        <h2>Recent polls</h2>
        <div className="card flush">
          {polls.length === 0 ? (
            <Empty message="No polls recorded yet." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Result</th>
                    <th className="num">HTTP</th>
                    <th className="num">Code</th>
                    <th className="num">ms</th>
                    <th className="num">Found</th>
                    <th className="num">New</th>
                    <th className="num">Live</th>
                    <th className="num">Finished</th>
                    <th className="num">Unknown</th>
                  </tr>
                </thead>
                <tbody>
                  {polls.map((poll) => {
                    const ok = poll.ok === true;
                    return (
                      <tr key={String(poll.id)}>
                        <td className="mono faint" title={formatTime(poll.createdAt as Date)}>
                          {relativeTime(poll.createdAt as Date)}
                        </td>
                        <td>
                          <span className={`badge ${ok ? 'ok' : 'err'}`}>
                            {ok ? 'OK' : 'FAILED'}
                          </span>
                        </td>
                        <td className="num">{String(poll.httpStatus ?? '—')}</td>
                        <td className="num">{String(poll.bizCode ?? '—')}</td>
                        <td className="num dim">{String(poll.durationMs ?? '—')}</td>
                        <td className="num">{String(poll.matchesFound ?? 0)}</td>
                        <td className="num">{String(poll.newMatches ?? 0)}</td>
                        <td className="num">{String(poll.liveCount ?? 0)}</td>
                        <td className="num">{String(poll.completedCount ?? 0)}</td>
                        <td className="num">{String(poll.unknownCount ?? 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="section">
        <h2>Last response excerpt</h2>
        {polls.length === 0 || !polls[0]?.rawExcerpt ? (
          <div className="card">
            <Empty message="No response captured yet." />
          </div>
        ) : (
          <pre className="raw">{String(polls[0].rawExcerpt)}</pre>
        )}
        {polls[0]?.error ? (
          <div className="notice danger" style={{ marginTop: 12 }}>
            <strong>Last error:</strong> <span className="mono">{String(polls[0].error)}</span>
          </div>
        ) : null}
      </section>
    </>
  );
}