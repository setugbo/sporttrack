import Link from 'next/link';
import { AutoPollControl } from '@/components/AutoPollControl';
import { PollNowButton } from '@/components/PollNowButton';
import {
  Empty,
  OutcomeBar,
  Score,
  SourceBadge,
  Stat,
  StatusBadge,
  formatTime,
  relativeTime,
} from '@/components/ui';
import { checkDatabase } from '@/lib/db/client';
import { listActiveMatches, listSources } from '@/lib/db/queries';
import { getAnalysis } from '@/lib/services/analysis.service';
import { getHistory } from '@/lib/services/history.service';

export const dynamic = 'force-dynamic';

/**
 * Operational dashboard: connection state, live slate, collected history and
 * retrospective statistics. Every figure shown is a count of matches already
 * observed; nothing here forecasts an outcome.
 */
export default async function DashboardPage() {
  const database = await checkDatabase();

  if (!database.ok) {
    return (
      <>
        <h1>Setup required</h1>
        <p className="subtitle">The tracker cannot reach its database yet.</p>
        <div className="notice danger">
          <strong>Database not ready.</strong>
          <br />
          {database.error ?? `Expected 7 tables but found ${database.migrations.length}.`}
          <br />
          <br />
          1. Set <code>DATABASE_URL</code> in <code>.env.local</code>.
          <br />
          2. Run <code>npm run db:migrate</code>.
          <br />
          3. Run <code>npm run db:seed</code> to register the source URL.
          <br />
          4. Start a tracking session: <code>npm run poll:once -- --start</code>.
        </div>
      </>
    );
  }

  const sources = await listSources();

  const source = sources[0];

  if (!source) {
    return (
      <>
        <h1>No source registered</h1>
        <p className="subtitle">Register the SportyBet vFootball page to begin tracking.</p>
        <div className="notice">
          Register the source, then start a tracking session:
          <br />
          <br />
          <code>npm run db:seed</code>
          <br />
          <code>npm run poll:once -- --start</code>
          <br />
          <br />
          History is built only from matches the tracker observes completing, so
          allow it to run for a while before treating any statistic as meaningful.
        </div>
      </>
    );
  }

  let analysis;
  let history;
  let live: Awaited<ReturnType<typeof listActiveMatches>> = [];

  try {
    [analysis, history] = await Promise.all([
      getAnalysis(source),
      getHistory(source, { limit: 50 }, { fetchProviderHistory: false }),
    ]);
    live = await listActiveMatches(source.id, 200);
  } catch (error) {
    return (
      <>
        <h1>Dashboard error</h1>
        <p className="subtitle">Something went wrong reading the tracker data.</p>
        <div className="notice danger">
          {error instanceof Error ? error.message : String(error)}
        </div>
      </>
    );
  }

  const liveNow = live.filter((m) => m.status === 'LIVE');
  const upcoming = live.filter((m) => m.status === 'DISCOVERED');

  return (
    <>
      <h1>Virtual Football Dashboard</h1>
      <p className="subtitle">
        Live slate and self-collected historical results. Statistics are
        descriptive counts of completed matches only.
      </p>

      {/* --- connection -------------------------------------------------- */}
      <section className="section">
        <div className="card">
          <div className="toolbar" style={{ justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 600 }}>{source.name}</div>
              <div className="mono faint">{source.sourceUrl}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <PollNowButton url={source.sourceUrl} />
              <AutoPollControl url={source.sourceUrl} />
            </div>
          </div>
          <div className="grid cols-4" style={{ marginTop: 4 }}>
            <Stat
              label="Source state"
              value={
                <span
                  className={`badge ${
                    source.status === 'ACTIVE' ? 'ok' : source.status === 'ERROR' ? 'err' : 'neutral'
                  }`}
                  style={{ fontSize: 13 }}
                >
                  {source.status}
                </span>
              }
            />
            <Stat label="Last successful poll" value={relativeTime(source.lastOkAt)} />
            <Stat
              label="History mode"
              value={
                <span className="badge app" style={{ fontSize: 13 }}>
                  {source.historicalMode}
                </span>
              }
              hint={analysis.lowConfidence ? 'Provider history unavailable' : 'Merged datasets'}
            />
            <Stat
              label="Poll interval"
              value="30s"
              hint="Recommended for this feed"
            />
          </div>
          {source.lastError ? (
            <div className="notice danger" style={{ marginTop: 12, marginBottom: 0 }}>
              Last poll failed: <span className="mono">{source.lastError}</span>
            </div>
          ) : null}
        </div>
      </section>

      {/* --- live slate --------------------------------------------------- */}
      <section className="section">
        <h2>Live &amp; upcoming</h2>
        <div className="grid cols-2">
          <div className="card flush">
            <h3 style={{ padding: '14px 16px 0', margin: 0 }}>Live now ({liveNow.length})</h3>
            <div className="table-wrap scroll-y">
              <MatchTable rows={liveNow} showClock />
            </div>
          </div>
          <div className="card flush">
            <h3 style={{ padding: '14px 16px 0', margin: 0 }}>
              Upcoming / not started ({upcoming.length})
            </h3>
            <div className="table-wrap scroll-y">
              <MatchTable rows={upcoming} showClock />
            </div>
          </div>
        </div>
      </section>

      {/* --- stats -------------------------------------------------------- */}
      <section className="section">
        <h2>Collected results</h2>

        {analysis.lowConfidence ? (
          <div className="notice">
            <strong>Small sample.</strong> {analysis.lowConfidenceReason}
          </div>
        ) : null}

        <div className="grid cols-4" style={{ marginBottom: 16 }}>
          <Stat
            label="Matches recorded"
            value={analysis.sampleSize}
            hint={analysis.sampleSize === 1 ? 'completed match' : 'completed matches'}
          />
          <Stat
            label="Average total goals"
            value={analysis.overall.avgTotalGoals}
            hint="goals per match"
          />
          <Stat
            label="Over 2.5"
            value={`${analysis.overall.over25Rate}%`}
            hint={`${analysis.overall.over25} of ${analysis.sampleSize}`}
          />
          <Stat
            label="Both teams scored"
            value={`${analysis.overall.bttsRate}%`}
            hint={`${analysis.overall.btts} of ${analysis.sampleSize}`}
          />
        </div>

        <div className="grid cols-2">
          <div className="card">
            <h3>Outcomes</h3>
            <OutcomeBar
              homeWins={analysis.overall.homeWins}
              draws={analysis.overall.draws}
              awayWins={analysis.overall.awayWins}
            />
            <div style={{ marginTop: 14 }} className="kv">
              <dt>Home wins</dt>
              <dd>
                {analysis.overall.homeWins} ({analysis.overall.homeWinRate}%)
              </dd>
              <dt>Draws</dt>
              <dd>
                {analysis.overall.draws} ({analysis.overall.drawRate}%)
              </dd>
              <dt>Away wins</dt>
              <dd>
                {analysis.overall.awayWins} ({analysis.overall.awayWinRate}%)
              </dd>
              <dt>Failed to score</dt>
              <dd>{analysis.overall.failedToScore}</dd>
              <dt>Highest score</dt>
              <dd>
                {analysis.overall.maxHomeScore}&ndash;{analysis.overall.maxAwayScore}
              </dd>
            </div>
          </div>

          <div className="card">
            <h3>Total goals distribution</h3>
            {analysis.goalsDistribution.length === 0 ? (
              <Empty message="No completed matches yet." />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Goals</th>
                    <th className="num">Matches</th>
                    <th className="num">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.goalsDistribution.map((bucket) => (
                    <tr key={bucket.label}>
                      <td>{bucket.label}</td>
                      <td className="num">{bucket.count}</td>
                      <td className="num dim">{bucket.rate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>

      {/* --- team table --------------------------------------------------- */}
      {analysis.topTeams.length > 0 ? (
        <section className="section">
          <h2>Team statistics</h2>
          <div className="card flush">
            <div className="table-wrap scroll-y">
              <table>
                <thead>
                  <tr>
                    <th>Team</th>
                    <th className="num">P</th>
                    <th className="num">W</th>
                    <th className="num">D</th>
                    <th className="num">L</th>
                    <th className="num">GF</th>
                    <th className="num">GA</th>
                    <th className="num">Avg GF</th>
                    <th className="num">Win %</th>
                    <th className="num">O2.5 %</th>
                    <th className="num">BTTS %</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.topTeams.map((team) => (
                    <tr key={team.team}>
                      <td>{team.team}</td>
                      <td className="num">{team.played}</td>
                      <td className="num">{team.wins}</td>
                      <td className="num">{team.draws}</td>
                      <td className="num">{team.losses}</td>
                      <td className="num">{team.goalsFor}</td>
                      <td className="num">{team.goalsAgainst}</td>
                      <td className="num dim">{team.avgGoalsScored}</td>
                      <td className="num dim">{team.winRate}%</td>
                      <td className="num dim">{team.over25Rate}%</td>
                      <td className="num dim">{team.bttsRate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {/* --- recent results ------------------------------------------------ */}
      <section className="section">
        <h2>Recent results</h2>
        <div className="card flush">
          <div className="table-wrap">
            {history.rows.length === 0 ? (
              <Empty message="No completed matches recorded yet. Results appear here once the tracker observes a match finish." />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Home</th>
                    <th className="num">Score</th>
                    <th>Away</th>
                    <th>League</th>
                    <th>Recorded</th>
                    <th>Provenance</th>
                  </tr>
                </thead>
                <tbody>
                  {history.rows.slice(0, 50).map((row) => (
                    <tr key={row.id}>
                      <td>{row.homeTeam}</td>
                      <td className="num">
                        <Score home={row.homeScore} away={row.awayScore} />
                      </td>
                      <td>{row.awayTeam}</td>
                      <td className="dim">{row.leagueName ?? row.leagueId ?? '—'}</td>
                      <td className="mono faint">{formatTime(row.playedAt ?? row.capturedAt)}</td>
                      <td>
                        <SourceBadge source={row.source} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>

      <div className="footer-note">
        This tool records and displays results that already occurred, for manual
        study only. It contains no predictions, probabilities or recommendations.
        Results marked &ldquo;Unknown&rdquo; are deliberately excluded from history
        because the feed gave no reliable completion signal. See{' '}
        <Link href="/debug">raw data</Link> or{' '}
        <code>docs/sportybet-integration.md</code> for how completion is detected.
      </div>
    </>
  );
}

function MatchTable({
  rows,
  showClock,
}: {
  rows: Awaited<ReturnType<typeof listActiveMatches>>;
  showClock: boolean;
}) {
  if (rows.length === 0) {
    return <Empty message="Nothing here right now." />;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Match</th>
          <th className="num">Score</th>
          {showClock ? <th className="num">Clock</th> : null}
          <th>League</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((match) => (
          <tr key={match.id}>
            <td>
              <StatusBadge status={match.status} />
              <div style={{ marginTop: 4 }}>
                {match.homeTeam} v {match.awayTeam}
              </div>
            </td>
            <td className="num">
              <Score home={match.homeScore} away={match.awayScore} />
            </td>
            {showClock ? (
              <td className="num mono dim">{match.clock ?? '—'}</td>
            ) : null}
            <td className="dim faint">{match.leagueName ?? match.leagueId ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}