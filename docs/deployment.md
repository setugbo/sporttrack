# Deployment

Two supported targets:

| Target      | Hosting | Poll scheduling             | Recommended for |
| ----------- | ------- | --------------------------- | --------------- |
| A           | Vercel  | GitHub Actions (every min)  | CI-free hosting |
| B           | cPanel  | Host cron (can be 30s+)     | Lower latency, exact feed window |

Both run the same Next.js standalone server over the same PostgreSQL database
(Neon, Supabase or any Postgres 14+). Nothing about the SportyBet feed requires
a particular deployment model; the differences are only in how polls get
triggered.

## Environment variables

See `.env.example`. The two that matter on both platforms:

- `DATABASE_URL` — required everywhere.
- `CRON_SECRET` — recommended on Vercel so the poll endpoint is private.

Poll cadence is not an environment variable. It is a per-session `poll_interval`,
set when the tracking session is created (default 30 seconds, bounded 10-300).
The poller self-throttles to that interval, so firing the cron more often than
the interval is harmless and firing it less often means fewer live samples.

## Target A — Vercel

1. Push the repository to GitHub.
2. In the Vercel dashboard select **New Project**, import the repo.
3. Framework preset: **Next.js**. Build command: `npm run build`.
4. Add the environment variables `DATABASE_URL` and `CRON_SECRET`.
5. Deploy. The first deploy will not migrate automatically — run once from the
   command line, or trigger one HTTP poll after deploy and the migration runs
   from the CLI in step 6.
6. Apply the schema and register the source:
   ```
   npx vercel env pull
   npm run db:migrate
   npm run db:seed
   ```
   (Use your local `psql` if you prefer; `db:seed` is idempotent.)
7. Open a tracking session once:
   ```
   npx vercel env pull
   npm run poll:once -- --start
   ```
### Scheduling: GitHub Actions (not Vercel Cron)

Vercel **Hobby** plans only allow daily Cron jobs — a `* * * * *` entry in
`vercel.json` is rejected at deploy time with
`Hobby accounts are limited to daily cron jobs`. The repository is public, so
GitHub Actions schedules are free and this is where the real scheduler lives:
`.github/workflows/poll.yml` fires `/api/cron/poll` once per minute with
`Authorization: Bearer $CRON_SECRET`.

Configure it once after the first deploy:

```
gh secret set CRON_SECRET --body "<same value as the Vercel CRON_SECRET>"
gh variable set APP_URL --body "https://<your-production-domain>"
```

The endpoint self-throttles to the session's 30-second interval, so calling it
more often than that is harmless; a throttled call returns immediately. Because
Vercel Cron and Actions both fire at best once a minute, the effective cadence
on this target is **once per minute** — enough for correct completion detection
(two successful absences are just two minutes apart), it only reduces how many
live snapshots are available on the dashboard.

`vercel.json` deliberately contains no `crons` block; adding one on a Hobby
plan fails the deployment. On a Pro plan you can move the schedule to Vercel
Cron and delete the workflow, or keep both (the endpoint is idempotent and
self-throttling).

## Target B — cPanel + Node (standalone)

The repo builds a self-contained server in `.next/standalone` (see
`next.config.ts`). cPanel's "Setup Node.js App" runs exactly that.

1. Deploy the code (git, or zip upload) to a Node app folder.
2. In cPanel > Setup Node.js App:
   - Application root: the project folder.
   - Node version: 20 or newer (22 LTS recommended).
   - Startup file: `server.js` in `.next/standalone` — or point the app at
     `node_modules/next/dist/bin/next` with `start`. The simplest reliable
     setup is:
     ```
     NODE_ENV=production
     STARTUP_COMMAND=node .next/standalone/server.js
     ```
3. Set `DATABASE_URL` and `CRON_SECRET` as application environment variables.
4. Build once on the host or on a build machine and upload the artifacts:
   ```
   npm ci
   npm run db:migrate
   npm run build
   npm run db:seed
   ```
   `db:seed` and `poll:once` run share the app code, so they must run with the
   same `DATABASE_URL` present.
5. Add a cron job in cPanel > Cron Jobs running every minute (or every 30
   seconds), e.g.:
   ```
   curl -fsS https://example.com/api/cron/poll -H "Authorization: Bearer $CRON_SECRET"
   ```
   cPanel permits `* * * * *`; if the host allows sub-minute scheduling set it
   to 30 seconds to match the recommended 30-second session interval.
6. Open a tracking session once:
   ```
   npm run poll:once -- --start
   ```

The standalone build copies `public/` and `.next/static`; there is no `public/`
directory in this app. If you add one later, copy it into `.next/standalone`.

## Operations

### Verification

- `/api/health` — connection state, schema tables, sources, whether each source
  has polled.
- `/api/debug` — the exact upstream request, response excerpt, and recent poll
  results. `DISABLE_DEBUG_SCREEN=1` turns this page off.

### First-hours checklist

1. `POST` your source URL to `/api/sources` (or `npm run db:seed`) and confirm
   one source row exists.
2. Start a tracking session (`npm run poll:once -- --start`).
3. Trigger a poll and check `/api/debug`: expect `bizCode 10000`, many events,
   and no CORS/Auth errors — the server calls upstream itself.
4. Leave it running through a few vFootball slate rollovers (~2-5 minutes each)
   and confirm the **Recent results** table fills and `sampleSize` grows.
5. When `sampleSize` passes ~5, check the statistics section on `/`. The
   dashboard labels a sample smaller than 30 as low-confidence so the numbers
   are not mistaken for meaningful distributions.

### Why history grows slowly

vFootball slate: several matches scheduled in a short window, each ~90 minutes
of simulation, all rolled at once. Every match the tracker observes crossing
88:00 and then disappearing for two successful polls becomes one historical
result. On the recommended cadence you should see a handful of results per
slate. There is no faster route: SportyBet publishes no vFootball results
endpoint (see `docs/sportybet-integration.md` section 8), so history can only
be application-collected.

### Restarting after an outage

A poll outage does **not** fake completions: absent matches keep accruing
absence only on successful polls, and a failed poll is never counted as an
observation. After the upstream recovers, pending matches resolve on the next
successful polls.

### Clock skew

All timestamps are stored in UTC. Do not set `TZ` to anything other than UTC on
the hosting platform; the SQL and the app both assume UTC throughout.