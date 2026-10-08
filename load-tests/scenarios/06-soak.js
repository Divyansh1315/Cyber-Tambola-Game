// Scenario 6 — Soak Test
//
// ~100 virtual players stay "active" for SOAK_DURATION_MIN minutes (default
// 25, inside the requested 20-30 range), each periodically: reading ticket
// state, marking newly called words, and occasionally submitting a prize
// claim. A separate low-rate host iteration keeps calling new words
// throughout so there's always fresh content to react to. This is a
// steady-state profile, not a ramp — the goal is to surface slow leaks
// (memory growth, DB connection exhaustion, creeping response times,
// realtime disconnects) that only show up after sustained load, not an
// instantaneous spike.
//
// What this checks, sampled continuously over the run (see README for how
// to read the time-series, since k6's own summary is end-of-run only):
//   - memory growth / connection leaks / DB connection exhaustion ->
//       indirectly, via a rising trend in http_req_duration and/or a rising
//       error rate over the run's own timeline (watch for threshold
//       breaches appearing only in the later minutes of --out json output)
//   - increasing response times -> http_req_duration trend across the run
//   - realtime disconnects      -> realtime_connect_failures /
//                                   reconnect_failures counters
//   - errors over time          -> db_errors counter, inspected per-minute
//                                   from the JSON output (see README)
// KNOWN LIMITATION: this scenario originally also opened one persistent
// Supabase Realtime WebSocket per VU via lib/realtime.js, to simulate each
// soak player staying realtime-connected for the whole run. That has been
// removed — in testing, opening ~100 concurrent WebSocket connections via
// k6's websockets module (which, per 05-reconnect.js's own header comment,
// never fires its `open` event against this server in this environment)
// starved the rest of the test of throughput: iteration counts collapsed
// to roughly 1 per 20+ seconds across all 100 VUs combined, instead of the
// expected near-continuous rate, strongly suggesting the ~100 permanently-
// "connecting" sockets were monopolizing k6's shared/global event loop.
// Removing the WebSocket entirely restored normal throughput. This is a
// k6/environment limitation, not an application defect — see
// 05-reconnect.js's header comment for the same root cause. Re-add once
// that blocker is resolved and re-verified in isolation first.
import { check, sleep } from 'k6'
import { joinGame, submitMark, submitClaim, restGet, callNextWord } from '../lib/rpc.js'
import { assertSafeTarget, GAME_CODE, GAME_ID, HOST_SECRET, SOAK_DURATION_MIN } from '../lib/config.js'
import { ACTIVE_TERM_IDS, PRIZE_IDS } from '../lib/cyberTerms.js'
import { dbErrors, isRpcError } from '../lib/metrics.js'

const SOAK_PLAYERS = Number(__ENV.SOAK_PLAYERS || 100)
const DURATION = `${SOAK_DURATION_MIN}m`

export const options = {
  scenarios: {
    soak_players: {
      executor: 'constant-vus',
      vus: SOAK_PLAYERS,
      duration: DURATION,
    },
    soak_host: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '20s', // one new word roughly every 20s, like a real host pace
      duration: DURATION,
      preAllocatedVUs: 1,
      maxVUs: 1,
      exec: 'hostLoop',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
    db_errors: ['count==0'],
  },
}

export function setup() {
  assertSafeTarget()
  if (!GAME_ID || !HOST_SECRET) {
    throw new Error('GAME_ID and HOST_SECRET env vars are required for scenario 06.')
  }
  return { gameId: GAME_ID }
}

export function hostLoop() {
  callNextWord(GAME_ID, HOST_SECRET, ACTIVE_TERM_IDS)
}

// Module-level cache keyed by VU id. k6 initializes each VU with its own
// instance of this module's state and re-invokes default() once per
// iteration within the SAME VU, so a plain module-scope object persists
// correctly across a given VU's iterations (unlike attempting to use a
// global/window object, which k6's JS runtime does not share across VUs
// anyway — this is the standard k6 pattern for per-VU setup-once state).
const soakIdentityByVu = {}

export default function (data) {
  // Each VU joins once (on its first iteration) and reuses that identity
  // for every later iteration, modeling one player staying in the game for
  // the whole soak window rather than rejoining every tick.
  let identity = soakIdentityByVu[__VU]

  if (!identity) {
    const deviceToken = `loadtest-soak-${__VU}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const joinRes = joinGame(GAME_CODE, `TEST_Soak_Player_${__VU}`, deviceToken, ACTIVE_TERM_IDS)
    if (joinRes.status !== 200 && joinRes.status !== 201) {
      dbErrors.add(1)
      sleep(5)
      return
    }
    const row = JSON.parse(joinRes.body)[0] || JSON.parse(joinRes.body)
    identity = { playerId: row.player_id, ticketId: row.ticket_id }
    soakIdentityByVu[__VU] = identity
  }

  // Realistic periodic action mix per iteration.
  const roll = Math.random()
  if (roll < 0.5) {
    // Read ticket state (most common action — players glance at their card).
    const res = restGet('tickets', `id=eq.${identity.ticketId}&select=*`)
    check(res, { 'soak: ticket read ok': (r) => r.status === 200 })
    if (isRpcError(res)) dbErrors.add(1)
  } else if (roll < 0.85) {
    // Mark a called word that's on the ticket, if any remain unmarked.
    const ticketRes = restGet('tickets', `id=eq.${identity.ticketId}&select=cells`)
    const ticket = ticketRes.status === 200 ? JSON.parse(ticketRes.body)[0] : null
    const calledRes = restGet('called_terms', `game_id=eq.${data.gameId}&select=term_id`)
    const calledIds = calledRes.status === 200 ? JSON.parse(calledRes.body).map((r) => r.term_id) : []
    const candidate = ticket ? ticket.cells.map((c) => c.termId).find((t) => calledIds.includes(t)) : null
    if (candidate) {
      const markRes = submitMark(identity.playerId, candidate)
      if (isRpcError(markRes)) dbErrors.add(1)
    }
  } else {
    // Occasional prize claim attempt (expected to mostly be NOT_ELIGIBLE /
    // already-claimed business rejections late in a long soak — that's
    // fine, it still exercises the endpoint under sustained load).
    const prizeId = PRIZE_IDS[Math.floor(Math.random() * PRIZE_IDS.length)]
    const claimRes = submitClaim(identity.playerId, prizeId)
    if (isRpcError(claimRes)) dbErrors.add(1)
  }

  sleep(3 + Math.random() * 4) // realistic human pacing between actions
}

export { textSummaryHandler as handleSummary } from '../lib/summary.js'
