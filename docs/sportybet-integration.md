# SportyBet Nigeria vFootball — Integration Investigation

**Investigated on:** 2026-10-05 (Nigeria locale, `request-country: ng`)
**Page investigated:** <https://www.sportybet.com/ng/m/sport/vFootball/live_list>
**Conclusion in one line:** the page renders **no match data in HTML**; all match data comes from a single **unauthenticated JSON POST endpoint** that exposes live + scheduled events only — **there is no settled/finished state and no historical-results endpoint**, so this application must run in **application-tracking mode (Mode B)** with a **hybrid engine that will use provider history automatically if it ever appears**.

---

## 1. How the page obtains its data

### 1.1 HTML contains no match data

`GET https://www.sportybet.com/ng/m/sport/vFootball/live_list` → `200`, `Content-Type: text/html;charset=UTF-8`, ~114 KB.

What *is* in the HTML:

| Item | Value |
| --- | --- |
| `window.seoEntity` | `null` (SEO pre-render is disabled for this route) |
| `var __domain__` | `'www.sportybet.com'` |
| `var __baseUrl__` | `'/ng/'` |
| `var operId` | `'2'` |
| `var reqCountryShortCode` | `'ng'` |
| `<script type="application/ld+json">` | organisation schema only — **no `SportsEvent` entries** |
| Data tables | none |

No `__NEXT_DATA__`, no `__NUXT__`, no Apollo cache, no `window.__INITIAL_STATE__`, and **no `api`/`gateway` URLs in the HTML at all**. The only inline data is navigation/entrance configuration (e.g. `{"id":"sporty-live-virtual-football","name":"vFootball","launch_url":"/sport/vFootball?betslipMode=real"}`), which is *navigation*, not match data.

**Conclusion: the page is a client-rendered SPA.**

### 1.2 JavaScript bundles

The page loads 12 webpack chunks from `//s.sporty.net/global/main/`. The relevant one is
`modules/main/mobile/index/index.<hash>.js` (the WAP app shell). Inside it, `window.fetch` is
monkey-patched (`window.fetch = xe; window.fetch2 = xe; window.originFetch = Se`) by a request wrapper.

That wrapper contains the base-URL construction:

```js
var __domain__ = 'www.sportybet.com'          // from HTML
var __baseUrl__ = '/ng/'                       // from HTML
ke = "/api".concat(__baseUrl__)                // -> "/api/ng/"
...
P = "//".concat(window.__domain__).concat(ke)  // -> "//www.sportybet.com/api/ng"
```

so an in-page call to `fetch("/factsCenter/wapEvents", …)` is rewritten to
`POST https://www.sportybet.com/api/ng/factsCenter/wapEvents`.

Extracting every string literal shaped like an API path from the bundles yielded the `factsCenter`
family used by the sports list/live pages:

```
/factsCenter/wapEvents                        <-- the vFootball live_list feed
/factsCenter/configurableLiveOrPrematchEvents
/factsCenter/oddsFilteredEvents
/factsCenter/wapConfigurableIndexLiveEvents
/factsCenter/wapChosenEvents
/factsCenter/event
/factsCenter/v2/event
/factsCenter/sportList
/realSportsGame/*
/promotion/v1/loyalty/mission/applicable/virtual
/bet_history/match_tracker
```

### 1.3 Finding the vFootball sport id

`GET /api/ng/factsCenter/sportList` (no body, no auth) returns every sport with its id and live
event count. The vFootball entry is:

```json
{ "id": "sr:sport:202120001", "name": "vFootball", "eventSize": 492 }
```

So `sr:sport:202120001` is the vFootball sport id, and `sportList` doubles as a discovery/health probe.

---

## 2. The data source

### 2.1 Request

```
POST https://www.sportybet.com/api/ng/factsCenter/wapEvents
Content-Type: application/json
Accept: application/json
Referer: https://www.sportybet.com/ng/m/sport/vFootball/live_list
User-Agent: <ordinary desktop browser UA>

[{"sportId":"sr:sport:202120001","withTwoUpMarket":true,"withOneUpMarket":true}]
```

* **Method:** `POST`
* **Authentication:** **none.** No cookies, no bearer token, no API key, no signature, no
  `x-app-key`. `OperId` is sent by the browser bundle but the endpoint returns `200` without it.
* **`Content-Type` must be `application/json`.** Sending
  `application/x-www-form-urlencoded` (the wrapper's default for GET) returns **HTTP 500**.
* **Body must be a JSON *array*** (one object per requested sport). A bare object returns **HTTP 403**.
* Only `sportId` is meaningful. `withTwoUpMarket` / `withOneUpMarket` are replicated from the bundle for
  fidelity. Unknown extra keys (`filterOrigin`, `isLive`, `status`, `settled`, `pageSize`, …) are
  **silently ignored** — verified by probe, all returned byte-identical event sets.

### 2.2 Response envelope

```jsonc
{
  "bizCode": 10000,          // 10000 == success; any other value == error
  "message": "0#0",
  "data": [                  // one entry per league
    {
      "id": "sv:league:1",
      "name": "Virtual",
      "categoryName": "England",
      "categoryId": "sv:category:202120001",
      "events": [ /* … */ ]
    },
    { "id": "sv:league:2", "name": "Virtual", "categoryName": null, "events": [] }
    // 5 league slots; only slot 1 is populated in practice
  ]
}
```

Observed volumes: **85–114 events** per response (10 live + ~72–100 scheduled), **1.3 MB** per response
because every event embeds a full `markets` array. Typical cadence: **9–10 concurrent live matches**, new
slates every **38 minutes**, `eventSize` in `sportList` up to ~492.

### 2.3 Event object (fields this app uses)

```jsonc
{
  "eventId": "sr:match:200026100521522",   // STABLE EVENT ID — primary dedupe key
  "gameId": "40403",
  "productStatus": "0#0",
  "estimateStartTime": 1791224520000,       // epoch ms, slate's scheduled start
  "status": 1,                              // 0 = scheduled, 1 = in play
  "matchStatus": "H2",                      // "H2" = second half
  "setScore": "3:0",                        // "home:away" — running score
  "gameScore": ["0:0", "3:0"],              // [1st half, 2nd half]
  "playedSeconds": "88:00",                 // match clock as "mm:ss"
  "homeTeamId": "191128112403tmp000000001", // stable team id
  "homeTeamName": "ARS",
  "awayTeamName": "AST",
  "awayTeamId": "191128112403tmp000000002",
  "sport": {
    "id": "sr:sport:202120001",
    "name": "vFootball",
    "category": { "id": "sv:category:202120001", "name": "England", "tournament": { "id": "sv:league:1", "name": "Virtual" } }
  },
  "bookingStatus": "Booked",
  "matchTrackerNotAllowed": false,
  "banned": false,
  "markets": [ /* 1X2, O/U, … with odds + live isWinning flags — 1.3 MB total, NOT used by this app */ ]
}
```

Notes:

* `gameScore` is `[firstHalf, secondHalf]` and **sums to `setScore`**. Verified across all sampled events.
* Scheduled events (`status: 0`) carry **empty** `setScore` and **absent** `playedSeconds`.
* Team "names" are 3-letter abbreviations. The vFootball universe observed was 20 clubs:
  `ARS, AST, BHA, BOU, BRE, CHE, COV, CRY, EVE, FUL, HUL, IPS, LEE, LIV, MCI, MUN, NEW, NFO, SUN, TOT`.
* `sport.category.name` was `England` for all 110 sampled events — vFootball slates are country-themed,
  so **league grouping must use `leagueId`/`categoryId`, not the team names**.

---

## 3. Status semantics — the critical finding

Polling `wapEvents` every 8–10 s for ~20 minutes across three complete slate rollovers produced only
these state combinations:

| `status` | `matchStatus` | `playedSeconds` | Count | Meaning |
| --- | --- | --- | --- | --- |
| `0` | `"Not start"` | `""` | 72–100 | Scheduled |
| `1` | `"H2"` | `"45:00"` … `"89:00"` | 9–10 | In play, second half |

**There is no third state.** Across ~120 successful polls:

* `playedSeconds` **never exceeded `89:00`** — no `90:00`, no `45:00+stoppage`, no `FT`.
* When a slate reached `89:00`, the whole batch of live events **vanished from the response** on the next
  poll and was replaced by a *different* batch of event ids.
* `bookingStatus` stayed `"Booked"` and `productStatus` stayed `"0#0"` throughout — neither carries
  settlement information.
* Disappearance is **immediate and simultaneous** across the batch (e.g. batch at `89:00` at 20:06:44,
  gone by 20:07:08 — ~24 s later).
* `market.outcomes[].isWinning` is present but is **live pricing state, not settlement** (e.g.
  `Over 0.5 → isWinning: 1, availableScore: "0:0"` while the match was still 0-0 in progress).

Observed clock cadence: the match clock advances roughly **1 minute per 20–25 s of wall-clock time**.

### 3.1 Probes for settled / historical data — all negative

| Probe | Result |
| --- | --- |
| `POST /api/ng/factsCenter/wapEvents` with `filterOrigin=virtuals`, `status:"all"`, `isLive:false`, `settled:true`, `eventStatus:[2,3,4]`, `pageSize:1000` | `200`, **identical** live+scheduled event set every time — filters ignored |
| `GET /api/ng/factsCenter/sportList` | `200` — only counts, no results |
| `GET /api/ng/factsCenter/event/sr:match:<id>` | `404` |
| `POST /api/ng/factsCenter/oddsFilteredEvents` | `403` |
| `POST /api/ng/factsCenter/v2/event` | `403` |
| `POST /api/ng/factsCenter/wapConfigurableIndexLiveEvents` | `403` |
| `POST /api/ng/event/metrics` | `404` |
| `GET /api/ng/games/lobby/v1/games/metadata` | `500` |
| `POST /api/ng/factsCenter/wapEvents` with `tournamentId` | `403` |
| String-literal sweep of all 12 bundles for `result` / `history` / `settle` / `summary` | only account-scoped routes: `/my_accounts/open_bets/bet_history`, `/orders/order/v2/jackpotlist?isSettled=`, `/bet_history/match_tracker` — **all require a logged-in user** |
| Sweep for a `sv:`-prefixed results route | none |

### 3.2 CORS

`OPTIONS` preflight from a foreign origin → **403**. A cross-origin `POST` returns `200` but the response
carries **no `Access-Control-*` headers at all**.

**Therefore: a purely browser-side implementation is impossible.** All upstream access must happen
server-side. (Relevant to the cPanel deployment question — see `docs/deployment.md`.)

---

## 4. Historical result availability

> **SportyBet exposes no usable public historical results for vFootball.**

There is no endpoint, no query parameter, and no field in the live feed that yields a settled final score
for a match that has already ended. `/bet_history/match_tracker` and `/my_accounts/open_bets/bet_history`
exist in the bundles but are account-scoped bet histories (a user's own placed bets), not event results, and
require an authenticated session. This app does not authenticate, does not bypass access controls, and does
not use them.

### 4.1 Mode selection

| Mode | Availability | Application behaviour |
| --- | --- | --- |
| **A — SportyBet history** | ❌ not available | Provider's `fetchHistoricalResults()` returns `[]` and reports `reason: "NO_HISTORY_ENDPOINT"`. Source is flagged `historical_mode = APP_TRACKED`. |
| **B — Application tracking** | ✅ active | Every poll upserts matches; finished matches are written to `historical_results` with `source = TRACKED_BY_APP`. |
| **C — Hybrid** | implemented, dormant | `mergeHistoricalResults()` unions provider history (if ever non-empty) with tracked results and de-duplicates on `dedupe_key`. Promoted automatically when the provider starts returning rows. |

---

## 5. Limitations

1. **No completion signal.** Completion is inferred. A finished event is one that has left the feed.
2. **Final score ≠ last observed score in general.** The last sample is `89:00`, and the match ends
   shortly after. A goal in that gap would be missed.
3. **Sampling gap is the dominant error source.** The window between the `89:00` sample and removal from
   the feed is ~24 s. A poll interval of 60 s can skip the `89:00` sample entirely, degrading the
   completion signal. **The app's recommended default interval is 30 s** (10–300 s supported).
4. **The feed is a rolling window** of ~11 slates (~7 h). Matches also leave the window by ageing out,
   not by finishing. Absence alone is therefore never sufficient evidence.
5. **Undocumented, unstable endpoint.** `wapEvents`, `sr:sport:202120001` and the field names are
   internal. They can change without notice and are not covered by any published contract.
6. **1.3 MB per poll.** The server drops the `markets` array before persisting anything.
7. **Anti-bot / WAF.** Behind CloudFront; the bundle itself contains WAF-challenge handling
   (`x-amzn-waf-action`). The app sends a single well-formed request at a configurable interval,
   caches within the interval, and never retries aggressively.
8. **Local-time semantics of `estimateStartTime`.** Returned as epoch ms, so it is timezone-safe; only
   rendering is affected.

---

## 6. Fallback strategy

### 6.1 URL allowlist (the app is not an open proxy)

`validateSportyBetUrl()` accepts **only** HTTPS URLs whose host is in an explicit allowlist and whose path
matches a registered vFootball route pattern. A submitted URL is never forwarded verbatim; the provider
**derives** the upstream endpoint from it. Anything unrecognised is rejected with a specific reason.

Registered route: `sportybet.com/ng/m/sport/vFootball/live_list`
(+ `/sport/vFootball`, `/sport/vFootball/live_list/:tournamentId`, `?filterOrigin=virtuals`).

### 6.2 Provider abstraction

Everything SportyBet-specific lives behind `MatchProvider`:

```ts
interface MatchProvider {
  key: string;                                   // 'sportybet'
  resolve(url: string): Promise<SourceDescriptor>;// allowlist + descriptor derivation
  fetchEvents(descriptor, opts): Promise<ProviderSnapshot>;
  fetchHistoricalResults(descriptor, opts): Promise<ProviderHistoryPage>;
}
```

`SportyBetProvider` is the only implementation. If the endpoint, sport id or field names change, only this
file changes.

### 6.3 Completion detection ladder

Applied **strongest signal first**; a match is only written to history with enough evidence.

| # | Signal | Confidence | Result |
| --- | --- | --- | --- |
| 1 | Terminal `matchStatus` (`FT`, `Finished`, `Ended`, `EndedRegular`, `AET`, `AfterPen`) or terminal `status` code (`2`,`3`) | `DEFINITIVE` | `FINISHED` + result written |
| 2 | Observed `clockMinute >= 90` (`regulationMinutes`) | `DEFINITIVE` | `FINISHED` + result written |
| 3 | Absent for `confirmAbsentPolls` (default 2) consecutive **successful** polls, was observed live, last `clockMinute >= 88` (`highConfidenceClockMinutes`) | `HIGH` | `FINISHED` + result written |
| 4 | Absent for `confirmAbsentPolls` consecutive successful polls, last `clockMinute < 88` | `LOW` | **`UNKNOWN`, no result written** |
| 5 | Never observed live, absent for `maxAbsentPolls` (default 6) | `LOW` | `UNKNOWN` (scheduled event dropped/replaced) |

Rules that are enforced unconditionally:

* Absence is only evaluated on **successful** polls — a failed or empty-response poll never advances the
  absence counter.
* A match is never marked `FINISHED` on absence alone; signal 3 always requires prior live evidence
  **and** a late clock.
* Anything short of `DEFINITIVE`/`HIGH` becomes `UNKNOWN` and is **excluded from history**, so a wrong
  final score can never enter the historical dataset. `UNKNOWN` rows stay visible on the dashboard's
  review table for manual inspection.
* Thresholds (`regulationMinutes`, `highConfidenceClockMinutes`, `confirmAbsentPolls`, `maxAbsentPolls`)
  are per-session settings with these defaults, so the strategy is configurable per the spec.

### 6.4 Duplicate prevention

* **Primary:** `external_event_id` — `UNIQUE (source_id, external_event_id)`. The feed supplies a stable
  `sr:match:<id>` for every event, so this is authoritative.
* **Fallback:** `event_key = sha256(source_id | sport_id | league_id | normalised home team | normalised
  away team | scheduled_at rounded to the minute)` — team names are only one of six components and are
  normalised (trim, collapse whitespace, uppercase), never used alone.
* **History de-duplication:** `historical_results.dedupe_key` is `UNIQUE`. It is
  `sportybet:<sport_id>:<external_event_id>` when an external id exists, else the event fingerprint.
  Hybrid merges therefore cannot insert the same match twice regardless of provenance.
* Snapshots are de-duplicated by `UNIQUE (match_id, clock_minute, home_score, away_score)` so repeated
  identical polls do not inflate the snapshot table.

---

## 7. Field mapping

| Provider field | Application field | Notes |
| --- | --- | --- |
| `eventId` | `external_event_id` | dedupe key |
| `sport.id` | `sport_id` | `sr:sport:202120001` |
| `sport.category.tournament.id` | `league_id` | `sv:league:1` |
| `sport.category.name` / `league.name` | `league_name` | e.g. `England` / `Virtual` |
| `homeTeamName` / `awayTeamName` | `home_team` / `away_team` | upper-cased 3-letter codes |
| `homeTeamId` / `awayTeamId` | `home_team_id` / `away_team_id` | stable per club |
| `setScore` (`"3:0"`) | `home_score` / `away_score` | authoritative running score |
| `gameScore[0]` | `ht_home_score` / `ht_away_score` | half-time split |
| `status` + `matchStatus` | `status` | `DISCOVERED` / `LIVE` / `FINISHED` / `CANCELLED` / `UNKNOWN` |
| `playedSeconds` (`"88:00"`) | `clock`, `clock_minute` | completion signal |
| `estimateStartTime` | `scheduled_at` | epoch ms → `timestamptz` |
| `bookingStatus` | *(stored raw in poll log)* | carries no settlement info |

---

## 8. Rate limiting and etiquette

* Single upstream request per poll per source; results cached for `poll_interval`.
* Concurrent polls for the same source are collapsed with a Postgres advisory lock, so a burst of browser
  refreshes cannot fan out into a burst of upstream requests.
* No concurrency increase, no parallelism across leagues, no credential use, no auth bypass, no CAPTCHA or
  WAF circumvention, no scraping of any page beyond the single JSON endpoint.
* A conventional desktop `User-Agent` is sent so the request is identifiable, and `Referer` reflects the
  page being tracked.

`robots.txt` was not relied upon for this endpoint; the JSON feed is what the operator's own front end
consumes for the URL the user supplied, no access control is circumvented, and the app stays within a
single user's tracking cadence.

---

## 9. Endpoint summary (for quick reference)

| Purpose | Method | URL | Body |
| --- | --- | --- | --- |
| vFootball live + scheduled feed | `POST` | `https://www.sportybet.com/api/ng/factsCenter/wapEvents` | `[{"sportId":"sr:sport:202120001","withTwoUpMarket":true,"withOneUpMarket":true}]` |
| Sport discovery / connectivity probe | `GET` | `https://www.sportybet.com/api/ng/factsCenter/sportList` | — |
| Historical results | — | **none exists** | — |