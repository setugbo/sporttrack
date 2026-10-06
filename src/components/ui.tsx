import type { MatchStatus, ResultSource } from '@/lib/core/types';

/** Small presentational helpers shared by the dashboard and debug views. */

export function StatusBadge({ status }: { status: MatchStatus }) {
  const map: Record<MatchStatus, { label: string; className: string }> = {
    LIVE: { label: 'Live', className: 'live' },
    FINISHED: { label: 'Finished', className: 'finished' },
    DISCOVERED: { label: 'Not started', className: 'upcoming' },
    UNKNOWN: { label: 'Unknown', className: 'unknown' },
    CANCELLED: { label: 'Cancelled', className: 'cancelled' },
  };
  const entry = map[status] ?? { label: status, className: 'neutral' };
  return (
    <span className={`badge ${entry.className}`}>
      {status === 'LIVE' ? <span className="dot live-pulse" /> : null}
      {entry.label}
    </span>
  );
}

export function SourceBadge({ source }: { source: ResultSource }) {
  return (
    <span className={`badge ${source === 'TRACKED_BY_APP' ? 'app' : 'provider'}`}>
      {source === 'TRACKED_BY_APP' ? 'Collected by app' : 'SportyBet history'}
    </span>
  );
}

export function Score({
  home,
  away,
}: {
  home: number | null;
  away: number | null;
}) {
  if (home === null || away === null) {
    return <span className="faint">&ndash;</span>;
  }
  return (
    <span className="score">
      {home} &ndash; {away}
    </span>
  );
}

export function formatTime(value: Date | string | null): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 19).replace('T', ' ') + 'Z';
}

export function relativeTime(value: Date | string | null): string {
  if (!value) return 'never';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'never';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function OutcomeBar({
  homeWins,
  draws,
  awayWins,
}: {
  homeWins: number;
  draws: number;
  awayWins: number;
}) {
  const total = homeWins + draws + awayWins;
  if (total === 0) return null;
  const pct = (value: number) => `${(value / total) * 100}%`;
  return (
    <div>
      <div className="bar">
        <span className="home" style={{ width: pct(homeWins) }} />
        <span className="draw" style={{ width: pct(draws) }} />
        <span className="away" style={{ width: pct(awayWins) }} />
      </div>
      <div className="bar-legend">
        <span>
          <span className="dot" style={{ background: 'var(--accent)' }} />
          Home {homeWins}
        </span>
        <span>
          <span className="dot" style={{ background: 'var(--text-faint)' }} />
          Draw {draws}
        </span>
        <span>
          <span className="dot" style={{ background: '#8b5cf6' }} />
          Away {awayWins}
        </span>
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Empty({ message }: { message: string }) {
  return <div className="empty">{message}</div>;
}