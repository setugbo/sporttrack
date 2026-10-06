-- ===========================================================================
-- Virtual Football Match Tracker - schema
-- PostgreSQL 14+ (designed for Neon).
--
-- Conventions
--   * All ids are uuid generated with gen_random_uuid() (pgcrypto/pg13+ builtin).
--   * All timestamps are timestamptz, stored in UTC.
--   * Every table that a provider can populate carries an explicit `source` /
--     `source_id` so provenance is never ambiguous.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------

CREATE TYPE source_type AS ENUM ('SPORTYBET');

-- Source operational state.
--   ACTIVE  - usable
--   PAUSED  - temporarily disabled by the operator
--   ERROR   - last poll failed; `last_error` explains why
CREATE TYPE source_status AS ENUM ('ACTIVE', 'PAUSED', 'ERROR');

-- Which historical pipeline is currently feeding this source.
--   PROVIDER_HISTORY - only SportyBet-supplied history is used
--   APP_TRACKED      - only application-collected history is used
--   HYBRID           - both, merged and de-duplicated
CREATE TYPE historical_mode AS ENUM ('PROVIDER_HISTORY', 'APP_TRACKED', 'HYBRID');

CREATE TYPE session_status AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED');

-- Match lifecycle state machine.
--   DISCOVERED -> seen in the feed, not yet started
--   LIVE       -> provider reports the match in play
--   FINISHED   -> completed with sufficient evidence; written to history
--   CANCELLED  -> provider reported it as cancelled/postponed
--   UNKNOWN    -> outcome could not be established; deliberately NOT in history
CREATE TYPE match_status AS ENUM (
  'DISCOVERED',
  'LIVE',
  'FINISHED',
  'CANCELLED',
  'UNKNOWN'
);

-- Provenance of a historical result row. Application-collected results are
-- never labelled as provider history.
CREATE TYPE result_source AS ENUM ('SPORTYBET_HISTORY', 'TRACKED_BY_APP');

-- How strongly the evidence supports a FINISHED determination.
-- Ordered weakest -> strongest for readability; see core/state-machine.ts.
CREATE TYPE finish_confidence AS ENUM ('DEFINITIVE', 'HIGH', 'MEDIUM', 'LOW', 'NONE');

-- ---------------------------------------------------------------------------
-- sources
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sources (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  -- The operator-facing SportyBet page this source tracks.
  source_url        text NOT NULL,
  -- Where the provider's JSON API lives (derived from source_url, never copied
  -- verbatim from user input). See core/url-allowlist.ts.
  base_url          text NOT NULL,
  source_type       source_type NOT NULL DEFAULT 'SPORTYBET',
  status            source_status NOT NULL DEFAULT 'ACTIVE',
  historical_mode   historical_mode NOT NULL DEFAULT 'APP_TRACKED',
  -- Proven-specific identifiers resolved at seed time (e.g. sport id).
  country_code      text NOT NULL DEFAULT 'ng',
  sport_id          text,
  -- Last connectivity result, for the dashboard connection card.
  last_checked_at   timestamptz,
  last_ok_at        timestamptz,
  last_error        text,
  last_error_at     timestamptz,
  -- Advisory-lock key + upstream throttle bookkeeping.
  last_poll_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sources_name_not_blank CHECK (length(btrim(name)) > 0)
);

COMMENT ON TABLE sources IS
  'A trackable upstream feed. One row per approved SportyBet vFootball URL.';

-- ---------------------------------------------------------------------------
-- tracking_sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tracking_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  name              text NOT NULL,
  status            session_status NOT NULL DEFAULT 'ACTIVE',
  source_url        text NOT NULL,
  -- When true, every event discovered on the feed is tracked automatically,
  -- not just a hand-picked list.
  track_all         boolean NOT NULL DEFAULT false,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  last_poll_at      timestamptz,
  -- Seconds between upstream polls for this session.
  poll_interval     integer NOT NULL DEFAULT 30,
  -- Completion-detection thresholds, overridable per session. See
  -- core/state-machine.ts and docs/sportybet-integration.md section 6.3.
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tracking_sessions_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT tracking_sessions_poll_interval_range
    CHECK (poll_interval BETWEEN 10 AND 300)
);

COMMENT ON COLUMN tracking_sessions.settings IS
  'Optional overrides: regulationMinutes, highConfidenceClockMinutes, confirmAbsentPolls, maxAbsentPolls.';

-- Only one session may be ACTIVE or PAUSED per source. Guarantees the dashboard
-- never has to reason about two competing trackers writing the same matches.
CREATE UNIQUE INDEX IF NOT EXISTS tracking_sessions_one_open_per_source
  ON tracking_sessions (source_id)
  WHERE status IN ('ACTIVE', 'PAUSED');

-- ---------------------------------------------------------------------------
-- matches
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS matches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  -- Provider's stable event id ("sr:match:200026100521522"). Primary dedupe key.
  external_event_id text,
  -- Fallback fingerprint used only when external_event_id is absent.
  event_key         text NOT NULL,

  sport_id          text,
  league_id         text,
  league_name       text,

  home_team         text NOT NULL,
  away_team         text NOT NULL,
  home_team_id      text,
  away_team_id      text,

  home_score        integer,
  away_score        integer,
  ht_home_score     integer,
  ht_away_score     integer,

  status            match_status NOT NULL DEFAULT 'DISCOVERED',
  -- Raw match clock, e.g. "88:00", and its minute component.
  clock             text,
  clock_minute      integer,
  -- Highest whole minute ever observed. The final score is the score at this
  -- clock, so completion detection must key off the maximum, not the last
  -- value, which a provider glitch could roll backwards.
  max_clock_minute  integer,

  scheduled_at      timestamptz,
  started_at        timestamptz,
  finished_at       timestamptz,

  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  -- Number of consecutive *successful* polls in which this event was absent.
  absent_polls      integer NOT NULL DEFAULT 0,

  -- Why it was classified FINISHED, and how strong that evidence was.
  finish_reason     text,
  finish_confidence finish_confidence NOT NULL DEFAULT 'NONE',

  -- Number of polls in which this event was present (diagnostics only).
  seen_count        integer NOT NULL DEFAULT 0,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT matches_external_event_id_unique UNIQUE (source_id, external_event_id),
  CONSTRAINT matches_home_away_differ CHECK (home_team <> away_team),
  CONSTRAINT matches_scores_non_negative
    CHECK ((home_score IS NULL OR home_score >= 0) AND (away_score IS NULL OR away_score >= 0))
);

COMMENT ON COLUMN matches.absent_polls IS
  'Consecutive successful polls with no sighting. Only a successful poll may increment this; a failed poll never advances completion detection.';

-- Duplicate-prevention indexes (spec section 11).
CREATE INDEX IF NOT EXISTS matches_external_event_id_idx ON matches (external_event_id);
CREATE INDEX IF NOT EXISTS matches_event_key_idx          ON matches (source_id, event_key);
CREATE INDEX IF NOT EXISTS matches_status_idx             ON matches (status);
CREATE INDEX IF NOT EXISTS matches_home_team_idx          ON matches (home_team);
CREATE INDEX IF NOT EXISTS matches_away_team_idx          ON matches (away_team);
CREATE INDEX IF NOT EXISTS matches_scheduled_at_idx       ON matches (scheduled_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS matches_last_seen_at_idx       ON matches (last_seen_at DESC);

-- Drives the live/upcoming table: newest-first active matches for a source.
CREATE INDEX IF NOT EXISTS matches_active_feed_idx
  ON matches (source_id, scheduled_at DESC)
  WHERE status IN ('DISCOVERED', 'LIVE');

-- ---------------------------------------------------------------------------
-- match_snapshots
--
-- Deliberately de-duplicated: identical states at the same match minute are
-- collapsed, so a 30s poll does not write a snapshot per poll. A typical
-- vFootball match stores ~20 rows, not one per poll.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS match_snapshots (
  id                bigserial PRIMARY KEY,
  match_id          uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  home_score        integer NOT NULL,
  away_score        integer NOT NULL,
  clock             text,
  clock_minute      integer,
  status            match_status NOT NULL,
  captured_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT match_snapshots_dedupe_key UNIQUE (match_id, clock_minute, home_score, away_score)
);

CREATE INDEX IF NOT EXISTS match_snapshots_match_captured_idx
  ON match_snapshots (match_id, captured_at DESC);

COMMENT ON TABLE match_snapshots IS
  'Score progression per match, retained for state-detection debugging and manual study.';

-- ---------------------------------------------------------------------------
-- historical_results
--
-- The application-owned history. `dedupe_key` is UNIQUE and is what makes the
-- hybrid merge safe: the same real-world match can arrive from provider history
-- and from tracking without ever being stored twice.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS historical_results (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Null when a result came from provider history for an event the app never
  -- tracked live.
  match_id            uuid REFERENCES matches(id) ON DELETE SET NULL,
  source_id           uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_event_id   text,
  dedupe_key          text NOT NULL,
  source              result_source NOT NULL,

  home_team           text NOT NULL,
  away_team           text NOT NULL,
  home_team_id        text,
  away_team_id        text,
  home_score          integer NOT NULL,
  away_score          integer NOT NULL,

  league_id           text,
  league_name         text,

  -- When the match was played; the ordering key for Last 5/10/20.
  played_at           timestamptz,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  tracking_session_id uuid REFERENCES tracking_sessions(id) ON DELETE SET NULL,

  finish_reason       text,
  finish_confidence   finish_confidence,

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT historical_results_dedupe_key_unique UNIQUE (dedupe_key),
  CONSTRAINT historical_results_scores_non_negative
    CHECK (home_score >= 0 AND away_score >= 0),
  CONSTRAINT historical_results_home_away_differ CHECK (home_team <> away_team)
);

COMMENT ON COLUMN historical_results.dedupe_key IS
  'Provider event id when available ("sportybet:<sport_id>:<event_id>"), otherwise a fingerprint over source + sport + league + teams + scheduled minute.';

-- "Last N" and team-history query indexes.
CREATE INDEX IF NOT EXISTS historical_results_played_at_idx
  ON historical_results (played_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS historical_results_home_team_played_idx
  ON historical_results (home_team, played_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS historical_results_away_team_played_idx
  ON historical_results (away_team, played_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS historical_results_source_idx        ON historical_results (source);
CREATE INDEX IF NOT EXISTS historical_results_session_idx       ON historical_results (tracking_session_id);
CREATE INDEX IF NOT EXISTS historical_results_league_played_idx ON historical_results (league_id, played_at DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- tracking_targets
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tracking_targets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_session_id uuid NOT NULL REFERENCES tracking_sessions(id) ON DELETE CASCADE,
  match_id            uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'ACTIVE',
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tracking_targets_unique UNIQUE (tracking_session_id, match_id)
);

COMMENT ON TABLE tracking_targets IS
  'Hand-picked matches in a session. Ignored when the session has track_all = true. The unique constraint is what stops duplicate tracking sessions/targets for the same event.';

CREATE INDEX IF NOT EXISTS tracking_targets_session_idx ON tracking_targets (tracking_session_id);

-- ---------------------------------------------------------------------------
-- poll_runs  (powers the admin / raw-data debug screen)
--
-- Deliberately stores no request or response headers and no credentials, and
-- truncates the captured body excerpt.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS poll_runs (
  id                bigserial PRIMARY KEY,
  source_id         uuid REFERENCES sources(id) ON DELETE CASCADE,
  -- The page the operator submitted (allowlisted) and the endpoint actually
  -- called (derived server-side).
  requested_url     text,
  upstream_url      text,
  upstream_method   text,
  http_status       integer,
  biz_code          integer,
  ok                boolean NOT NULL DEFAULT false,
  error             text,
  duration_ms       integer,
  matches_found     integer NOT NULL DEFAULT 0,
  live_count        integer NOT NULL DEFAULT 0,
  completed_count   integer NOT NULL DEFAULT 0,
  unknown_count     integer NOT NULL DEFAULT 0,
  new_matches       integer NOT NULL DEFAULT 0,
  -- Trimmed, redacted response excerpt for inspection.
  raw_excerpt       text,
  response_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS poll_runs_source_created_idx ON poll_runs (source_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sources_set_updated_at ON sources;
CREATE TRIGGER sources_set_updated_at BEFORE UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS tracking_sessions_set_updated_at ON tracking_sessions;
CREATE TRIGGER tracking_sessions_set_updated_at BEFORE UPDATE ON tracking_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS matches_set_updated_at ON matches;
CREATE TRIGGER matches_set_updated_at BEFORE UPDATE ON matches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();