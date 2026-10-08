# Cyber Tambola — Load Testing

Load/soak test suite for verifying the app can reliably support **~100
concurrent players** in one game. Built with **k6**, targeting a
**disposable/staging Supabase project** — never production, unless you
explicitly configure and accept that risk (see Safety below).

## Why k6

The app's entire backend is Supabase: a React/Vite frontend calling
Postgres `SECURITY DEFINER` RPC functions directly over HTTPS
(`POST ${SUPABASE_URL}/rest/v1/rpc/<fn>`), plus Supabase Realtime
(`postgres_changes` over a Phoenix-channel WebSocket) for live sync. There
is no custom API server or edge function layer.

That shape is exactly what k6 is built for:
- First-class HTTP load testing with per-request tagging, thresholds, and
  percentile metrics (p95/p99) out of the box — no plugin needed.
- A real WebSocket client (`k6/websockets`) for exercising Supabase
  Realtime's connection fan-out, which this project's prize-claim and
  called-word sync behavior depends on.
- JS scripting, so the exact RPC payloads/business rules (gates in
  `submit_claim`, `submit_mark`, etc.) can be modeled precisely per
  scenario instead of generic record/replay.

Artillery would also work (it supports both HTTP and WS), but k6's
threshold model (`rate<0.01`, `p(95)<1000`, …) maps directly onto this
project's own pass/fail criteria, and its default summary already reports
every percentile this task asks for.

## Architecture discovered (summary)

| Concern | Implementation |
|---|---|
| Frontend | React 18 + TypeScript + Vite, React Router. All orchestration in `src/state/GameSessionContext.tsx`. |
| Backend/API | **No custom API layer.** Pure Supabase: `@supabase/supabase-js` calling Postgres RPCs. |
| Database | Supabase Postgres. Tables: `games`, `called_terms`, `players`, `tickets`, `marks`, `claims`, `winners`, `active_game_pointer`. |
| Realtime | Supabase Realtime, `postgres_changes` only (no broadcast channels). One channel `game:<id>` covers games/called_terms/players/tickets/marks/claims/winners; a second channel `active-game-pointer` tracks game resets. |
| Auth/identity | No Supabase Auth. Identity = anon API key (shared) + a per-device random UUID (`device_join_token`) persisted in `localStorage`. |
| Game creation | `reset_game_to_new(p_old_game_id, p_host_secret)` RPC — atomically retires old game, creates new one, flips `active_game_pointer`. |
| Player join | `join_game(p_game_code, p_display_name, p_device_join_token, p_active_term_ids)` RPC → `{player_id, ticket_id}`. |
| Ticket generation | Server-side `assign_ticket` RPC (called internally by `join_game`), 3×4/12-cell layout, retried on signature collision. |
| Called-word sync | Host calls `call_next_word(p_game_id, p_host_secret, p_active_term_ids)` (row-locks `games`, serializes concurrent host calls); players receive it via the `game:<id>` realtime channel's `called_terms` subscription. |
| Ticket marking | `submit_mark(p_player_id, p_term_id)` RPC. Duplicate-mark backstop: `UNIQUE(player_id, ticket_id, term_id)` on `marks`. |
| Prize claim | `submit_claim(p_player_id, p_prize_id)` RPC. **Atomic winner resolution**: `insert into winners(...) on conflict (game_id, prize_id) do nothing returning id` — first committer wins, backed by `UNIQUE(game_id, prize_id)` on `winners`. |
| Host updates | Host Dashboard is a read-only observer of the same realtime-synced `claims`/`winners` state; no separate host-push mechanism. |

Full detail with file/line references was gathered during inspection and is
reflected in the scenario scripts' own code comments.

## Directory layout

```
load-tests/
  .env.example          # copy to .env, fill in staging values, never commit .env
  package.json
  lib/
    config.js           # env var loading + a "does this look like prod" safety check
    cyberTerms.js        # mirrors src/data/cyberTerms.ts's 30 active term ids
    rpc.js               # thin HTTP wrappers for join_game/call_next_word/submit_mark/submit_claim/get_active_game
    realtime.js          # minimal Supabase Realtime (Phoenix protocol) client over k6/websockets
    metrics.js           # custom k6 metrics: db_errors, duplicate_prize_winners, realtime_connect_failures, etc.
    summary.js           # shared end-of-run console + JSON report
  scripts/
    bootstrap-game.mjs   # one-time: creates a LOBBY game + points active_game_pointer at it (needs service_role key, staging only)
    cleanup-game.mjs      # one-time: deletes a test game's players/tickets/marks/claims (needs service_role key, staging only)
  scenarios/
    01-join.js            # Scenario 1 — Concurrent Player Join
    02-marking.js          # Scenario 2 — Simultaneous Word Marking
    03-claim-race.js        # Scenario 3 — Prize Claim Race Condition (critical)
    04-realtime-sync.js      # Scenario 4 — Realtime Synchronization
    05-reconnect.js          # Scenario 5 — Reconnect
    06-soak.js                # Scenario 6 — Soak Test (~100 users, 20-30 min)
  results/                    # k6 JSON summaries land here (gitignored)
```

## Prerequisites

1. **A disposable/staging Supabase project** — not production. Apply all
   migrations in `supabase/migrations/*.sql` (0001 through 0010) to it;
   several are marked "MANUAL APPLY REQUIRED" and are not auto-deployed by
   any tooling in this repo.
2. **k6** installed. On Windows:
   ```powershell
   winget install -e --id GrafanaLabs.k6
   ```
   If that prompts for elevation and you'd rather not install system-wide,
   download the portable zip from
   https://github.com/grafana/k6/releases and run `k6.exe` directly from
   wherever you extract it (what was used to validate these scripts in this
   session — no admin rights required).
   Alternative (Docker, no local install at all):
   ```powershell
   docker run --rm -i -v "${PWD}:/scripts" grafana/k6 run /scripts/scenarios/01-join.js
   ```
3. **Node.js** (already required by the app itself) for the two bootstrap/
   cleanup helper scripts under `scripts/`.

## Setup

### 1. Configure environment

```powershell
Copy-Item load-tests\.env.example load-tests\.env
# edit load-tests\.env with your staging project's URL/anon key
```

k6 does **not** auto-load `.env` files. Before running any scenario, load
the values into your shell session:

```powershell
Get-Content load-tests\.env | ForEach-Object {
  if ($_ -match '^\s*([A-Z_]+)=(.*)$') {
    [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])
  }
}
```

(Run this in every new PowerShell session before invoking k6, or pass each
value explicitly with `-e NAME=value` per the examples below.)

### 2. Bootstrap a test game

RLS gives `anon` **no write access** to `games`/`active_game_pointer` by
design (every real write goes through a `SECURITY DEFINER` RPC — see
`supabase/migrations/0002_rls.sql`), and the only RPC that creates a game
(`reset_game_to_new`) requires an *existing* game's `host_secret` — a
chicken-and-egg problem for a brand-new staging project. Two options:

**Option A — scripted (needs a `service_role` key, staging project only,
never shipped anywhere near the app or k6):**
```powershell
$env:SUPABASE_URL = "https://xxxx.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<staging service_role key>"
node load-tests\scripts\bootstrap-game.mjs
```
This prints `GAME_CODE` / `GAME_ID` / `HOST_SECRET` — paste them into
`load-tests\.env`.

**Option B — manual (no service key needed at all):** open the Supabase SQL
editor for your staging project and run:
```sql
insert into games (code, status) values ('LOADTEST', 'LOBBY') returning *;
-- copy the returned id and host_secret, then:
update active_game_pointer set active_game_id = '<the id you just got>' where id = true;
```

Either way, **every k6 scenario script only ever uses the anon key** — the
`service_role` key (if you used Option A) never appears in any `.js` file
or k6 invocation, matching how a real browser client is restricted.

### 3. Clean up after a run (optional, recommended between repeated runs)

```powershell
$env:SUPABASE_URL = "https://xxxx.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<staging service_role key>"
$env:GAME_ID = "<the GAME_ID from bootstrap>"
node load-tests\scripts\cleanup-game.mjs
```
Pass `--winners` to also clear the `winners` table for that game (needed
before re-running Scenario 3, since `submit_claim`'s `PRIZE_CLOSED` gate
will otherwise reject every claim for a prize already won by a prior run).

## Running the scenarios

All commands assume `k6` is on your `PATH`; otherwise substitute the full
path to `k6.exe`. Run from the `load-tests` directory, or adjust paths.

```powershell
# Scenario 1 — Concurrent Player Join (ramps 10 -> 25 -> 50 -> 100)
k6 run scenarios/01-join.js

# Scenario 2 — Simultaneous Word Marking (needs GAME_ID + HOST_SECRET; host calls a few words first)
k6 run scenarios/02-marking.js -e MARK_TEST_PLAYERS=100

# Scenario 3 — Prize Claim Race Condition (THE critical test; 20-50 racers)
k6 run scenarios/03-claim-race.js -e CLAIM_RACE_PLAYERS=30

# Scenario 4 — Realtime Synchronization (100 connected sockets, host reveals words)
k6 run scenarios/04-realtime-sync.js -e REALTIME_PLAYERS=100

# Scenario 5 — Reconnect
k6 run scenarios/05-reconnect.js -e RECONNECT_PLAYERS=50

# Scenario 6 — Soak Test (~100 users, 20-30 minutes; defaults to 25 min)
k6 run scenarios/06-soak.js -e SOAK_PLAYERS=100 -e SOAK_DURATION_MIN=25
```

Each run writes a timestamped JSON summary to `load-tests/results/` and
prints the same metrics to the console (see "Reporting" below).

### Recommended test sequence

Run in this order, smallest/safest first, and don't proceed to the next
step until the previous one is clean:

1. **Smoke check** — Scenario 1 at a *much* lower ramp first, to confirm
   the whole chain (staging project, bootstrap, env vars) actually works
   before generating real load:
   ```powershell
   k6 run scenarios/01-join.js -e SUPABASE_URL=$env:SUPABASE_URL -e SUPABASE_ANON_KEY=$env:SUPABASE_ANON_KEY --stage 10s:3 --stage 10s:0
   ```
   (The `--stage` flags here override the script's own ramp with a tiny
   3-VU smoke profile without editing the file.)
2. **Scenario 1 — full ramp** (10/25/50/100) once the smoke check is clean.
3. **Scenario 2 — marking** at 100 players.
4. **Scenario 3 — claim race** — run this early and often; it's the
   highest-risk correctness scenario, not just a performance one. Re-run
   it a few times (with cleanup between runs) since race conditions don't
   always manifest on the first attempt.
5. **Scenario 5 — reconnect** at 50 players.
6. **Scenario 4 — realtime sync** at 100 connections.
7. **Scenario 6 — soak** last, only after 1-5 are clean, since it's the
   longest-running and most resource-intensive against your staging
   project.

### Pass/fail thresholds

Encoded directly in each scenario's `options.thresholds` (k6 exits non-zero
if any threshold is breached):

| Threshold | Target |
|---|---|
| Request failure rate | < 1% (`http_req_failed rate<0.01`) |
| p95 API response time | < 1000ms where practical |
| p99 API response time | < 2000ms (join/marking) |
| Duplicate prize winners | **exactly 0**, always (`duplicate_prize_winners count==0`) |
| Lost ticket markings | 0 |
| DB/API errors | 0 (excluding expected business-rule 400s, e.g. "not eligible yet") |
| Realtime connect failures | 0 |
| Reconnect failures | 0 |

## Reporting

Every scenario's `handleSummary()` (shared via `lib/summary.js`) prints:

```
Total requests, Successful requests, Failed requests,
Avg / p95 / p99 / Max response time, Requests/sec,
DB/API errors, Realtime connect failures, Duplicate prize winners,
Sync failures, Duplicate player sessions, Lost ticket markings,
Reconnect failures
```

...plus the full k6 text summary (all built-in metrics), and writes the
complete raw metrics object to `load-tests/results/summary-<timestamp>.json`
for later comparison across runs (e.g. tracking whether p95 creeps up
between a 25-minute soak's first and last 5 minutes).

For the soak test specifically, a single end-of-run summary can hide a
slow leak. To see metrics *over time* instead of only at the end, add k6's
built-in time-series output alongside the console summary:
```powershell
k6 run scenarios/06-soak.js --out json=results/soak-timeseries.json
```
then inspect `http_req_duration` samples bucketed by `data.time` in that
file — a rising trend across the run (not just a high end-of-run average)
is the actual signal for connection/memory leaks or DB connection
exhaustion.

## Known limitations (as tested)

- **k6 WebSocket support is broken against Supabase Realtime in this
  environment.** Confirmed with both `k6/websockets` and the deprecated
  `k6/experimental/websockets` on k6 v2.2.0/Windows: the TCP/TLS handshake
  completes (visible in the `ws_connecting` metric), but k6 never fires the
  `open` event, so `phx_join` is never sent and no `postgres_changes`
  events are ever received. Opening many such connections concurrently
  (e.g. 100, one per soak-test VU) also measurably degrades the rest of
  that VU's throughput, consistent with the sockets monopolizing k6's
  shared/global event loop. This blocks Scenario 4 (realtime sync)
  entirely, and Scenario 5/6 have had their WebSocket portions removed
  (their REST-based assertions, which cover what actually matters —
  whether state persists correctly — are unaffected and pass). Try a newer
  k6 release or a non-Windows runner before re-enabling `lib/realtime.js`.
- **Scenario 6's realistic duration is capped by the term bank, not by
  design.** With only 30 active terms and the host calling one every ~20s,
  the bank exhausts (game transitions to `COMPLETED`) around the 10-minute
  mark. A genuine 25-30 minute soak needs either a larger synthetic term
  bank or a slower host pace passed via scenario tuning.
- **Scenario 3 depends on `submit_claim` being the migration-0010 (or
  later) version.** An earlier version of 0010 itself had a bug (fixed in
  this repo's `supabase/migrations/0010_claim_auto_win.sql` — see the
  file's own "BUGFIX" comment) where it inserted into `winners` before the
  corresponding `claims` row existed, violating `winners.claim_id`'s
  foreign key on every single valid claim. If Scenario 3 ever reports
  `db_errors > 0` with no `CONFIRMED` claims appearing, check this first.

## Safety

- **Never run these against production.** `lib/config.js`'s
  `assertSafeTarget()` refuses to run if `SUPABASE_URL` contains `prod`,
  `production`, or `live` (case-insensitive), unless you pass
  `-e ALLOW_NON_STAGING=true`. This is a heuristic safety rail, not a
  guarantee — the real control is pointing `SUPABASE_URL` at a disposable
  project in the first place.
- **No secrets are hardcoded.** `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `GAME_ID`, `HOST_SECRET` are all read from environment variables (see
  `.env.example`); `SUPABASE_SERVICE_ROLE_KEY` is used only by the two
  Node bootstrap/cleanup scripts, never by any k6 script.
- **Start small.** Use the smoke-check command above before any 100-VU
  run. Scenario 3 (claim race) and Scenario 6 (soak) are the most
  resource-intensive — run them last, and only once 1/2/5 are clean.
- **This does not modify production gameplay logic.** No application
  source file was changed to build this suite; it only drives the existing
  RPC surface the same way a real browser client does.
