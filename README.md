# Virtual Football Match Tracker

A lightweight tracker for **SportyBet Nigeria Virtual Football** that collects
live scores from the public vFootball live feed, records matches the tracker
observes completing, and builds its own historical results database for manual
study.

**Explicitly out of scope:** no betting engine, no wagering automation, no
predictions, no recommendations. This project collects *what already happened*
and describes it. Use the data for your own study; do not build automated bets
on top of it.

---

## Why this exists

SportyBet's vFootball page does not expose a results/history endpoint. The live
feed stops reporting a match at 89:00 and removes it from the feed shortly
after. If you do not capture the score while the match is live, the final
result is permanently lost. This tracker polls the feed continuously, detects
completion from the match's disappearance, and stores the last observed score
as the result — labelled clearly as **collected by the app**, never as
SportyBet history.

Everything about the feed behaviour (endpoints, fields, status transitions,
absence windows, probes for history endpoints) is documented in
[`docs/sportybet-integration.md`](docs/sportybet-integration.md).

## Highlights

- **Server-side polling only.** SportyBet sends no CORS headers; the browser
  cannot and must not call the feed. All upstream requests are made by the
  server (API routes, cron, or the CLI).
- **URL allowlist.** The only URL the server will ever request is derived
  server-side from a SportyBet page URL that passes an exact allowlist
  (https, exact host, exact page path). See `src/lib/core/url-allowlist.ts`.
- **Conservative completion detection.** A match counts as finished only when
  the evidence supports it: a provider terminal status, the regulation clock
  reached with a score, or a late-clock disappearance confirmed over multiple
  *successful* polls. Anything else is `UNKNOWN` and is deliberately **not**
  written to history. Failed polls never advance absence counting.
- **History provenance.** Every historical row is tagged `TRACKED_BY_APP` or
  `SPORTYBET_HISTORY`. Today all rows are `TRACKED_BY_APP`; if a real provider
  history feed is ever added, the two datasets merge on a stable dedupe key and
  provider rows stay labelled as provider rows.
- **Descriptive statistics only.** Dashboard figures are counts and rates of
  completed matches already in the database, with a low-sample warning below 30
  results.

## Architecture at a glance

```
src/lib/core/            pure domain logic (no Next, no DB):
  url-allowlist.ts         source URL -> validated API base
  provider.ts              SportyBet-specific normalisation + fetch
  state-machine.ts         the only place that decides FINISHED / UNKNOWN
  dedupe.ts                fingerprinting + hybrid-history dedupe
  history-engine.ts        applies the source's historical_mode
  analysis.ts              descriptive statistics
src/lib/db/              postgres.js access + queries (camelCased rows)
src/lib/services/        polling/ingest, tracker orchestration, history, analysis
src/app/api/*            HTTP surface (sources, sessions, matches, history,
                         analysis, poll, cron/poll, debug, health)
src/components/          small presentational UI (plain CSS in globals.css)
db/migrations/           001_init.sql (idempotent runner)
scripts/                 migrate, seed-source, poll-once (share app code via
                         Node's native TypeScript stripping)
tests/                   unit tests for the core logic (vitest)
```

Core rule: nothing in `src/lib/core/*` talks to the network or the database.
Providers, state transitions and statistics are all unit-testable in
isolation.

## Getting started (local)

Requirements: Node 20+ (22/24 recommended), a PostgreSQL 14+ instance
(Neon/Supabase free tier or local).

```
npm ci
cp .env.example .env.local        # fill in DATABASE_URL
npm run db:migrate
npm run db:seed                   # registers the vFootball URL
npm run poll:once -- --start      # opens a tracking session, first poll
npm run dev
```

Then open `http://localhost:3000`.

## Frequent workflows

| Task | Command |
| ---- | ------- |
| Register the default source | `npm run db:seed` |
| Apply pending migrations | `npm run db:migrate` |
| Open a tracking session + first poll | `npm run poll:once -- --start` |
| One poll of every source | `npm run poll:once` |
| Manual poll from the dashboard | **Poll now** button |
| Inspect upstream request/response | `/api/debug` (or the Raw data page) |
| Check health | `/api/health` |
| Tests | `npm test` |
| Typecheck / lint / build | `npm run typecheck`, `npm run lint`, `npm run build` |

## Configuration

See `.env.example`. Notable keys:

- `DATABASE_URL` — required.
- `CRON_SECRET` — shared secret required by `/api/cron/poll` (the scheduler
  sends it as `Authorization: Bearer`). Empty disables the check, which matters
  on cPanel cron.
- `DEFAULT_POLL_INTERVAL` — default session cadence in seconds (10-300, default 30).
- `DEFAULT_SOURCE_URL` — the URL `db:seed` / `poll:once` register.
- `DISABLE_DEBUG_SCREEN` — set `1` to remove the raw-data view.

## Deployment

Vercel and cPanel Node apps are both supported. On Vercel the per-minute
schedule runs from GitHub Actions (`.github/workflows/poll.yml`) because Vercel
Hobby plans only allow daily Cron jobs; details, first-time setup and a
first-hours checklist are in [`docs/deployment.md`](docs/deployment.md).

The scheduler fires at most once a minute. The recommended 30 second interval
is only reachable on hosts that allow sub-minute scheduling (cPanel or your own
server). Completion detection is correct at either cadence; only live-sample
granularity differs.

## Data model

See `db/migrations/001_init.sql` for the full schema. Core tables:

- `sources` — one row per allowlisted SportyBet page, plus operational state.
- `tracking_sessions` — one open session per source (enforced by a partial
  unique index) so duplicate tracks cannot double-count results.
- `matches` — the current lifecycle state of every seen event.
- `match_snapshots` — de-duplicated score progression per match.
- `historical_results` — the collected history, tagged with provenance.
- `poll_runs` — every poll's HTTP/envelope outcome plus redacted raw excerpt.

## Acceptable-use notes

- This tool works against SportyBet's **public, unauthenticated** live feed
  used by its own web storefront. It sends no credentials, sets no gambling
  cookies, and its only outbound requests are to `*.sportybet.com` API hosts
  derived from the allowlist.
- Respect SportyBet's terms of service. Poll at a modest cadence (do not set a
  session below 10 seconds; the schema rejects it) and do not use the data to
  operate automated wagering.
- vFootball scores are *simulated*; they have no relationship to real matches.
  Statistics derived from them describe the simulator, not football.

## License

`UNLICENSED` — private project.