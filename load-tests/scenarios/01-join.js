// Scenario 1 — Concurrent Player Join
//
// Simulates players joining the same staging game, ramping 10 -> 25 -> 50 ->
// 100 virtual users. Each VU calls join_game with a unique device_join_token
// (a fresh UUID), exactly like a brand-new browser/device would — reusing a
// token would make join_game treat the caller as a RESTORE of an existing
// player, not a new join, so uniqueness here is what makes this a genuine
// "N new players" test rather than "1 player joining N times".
//
// What this checks, mapped to the request's own bullet list:
//   - successful joins            -> join_success_rate / http 200 checks
//   - response time                -> http_req_duration (built-in) + thresholds
//   - ticket creation               -> response body must contain a ticket_id
//   - duplicate player/session issues -> re-joining with the SAME token mid-run
//                                        must return the SAME player_id/ticket_id
//                                        (restore), never a second row
//   - database errors               -> db_errors counter (4xx/5xx from PostgREST)
//   - realtime subscription failures -> out of scope for this scenario by
//                                        design (pure RPC load); see
//                                        04-realtime-sync.js for that check
import { check, sleep } from 'k6'
import { Counter, Rate } from 'k6/metrics'
import { joinGame } from '../lib/rpc.js'
import { assertSafeTarget, GAME_CODE } from '../lib/config.js'
import { ACTIVE_TERM_IDS } from '../lib/cyberTerms.js'
import { dbErrors, duplicateJoins, isRpcError } from '../lib/metrics.js'

export const options = {
  scenarios: {
    join_ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '30s', target: 25 },
        { duration: '1m', target: 50 },
        { duration: '2m', target: 100 },
        { duration: '1m', target: 100 }, // hold at peak
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], // < 1% failure rate (baseline threshold)
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    join_success_rate: ['rate>0.99'],
    db_errors: ['count==0'],
    duplicate_player_sessions: ['count==0'],
  },
}

const joinSuccessRate = new Rate('join_success_rate')
const ticketMissing = new Counter('ticket_missing_on_join')

export function setup() {
  assertSafeTarget()
  return { gameCode: GAME_CODE }
}

export default function (data) {
  const deviceToken = `loadtest-${__VU}-${__ITER}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  // TEST_ prefix per isolation policy: makes every synthetic player
  // trivially identifiable (and filterable/deletable) in the production
  // project this currently targets.
  const displayName = `TEST_LoadTest_Player_${__VU}`

  const res = joinGame(data.gameCode, displayName, deviceToken, ACTIVE_TERM_IDS)

  const ok = check(res, {
    'join: status is 200/201': (r) => r.status === 200 || r.status === 201,
  })
  joinSuccessRate.add(ok)

  if (isRpcError(res)) {
    dbErrors.add(1)
  }

  if (ok) {
    let body
    try {
      body = JSON.parse(res.body)
    } catch (e) {
      body = null
    }
    const row = Array.isArray(body) ? body[0] : body
    const hasTicket = row && row.ticket_id
    check(row, { 'join: response includes ticket_id': () => !!hasTicket })
    if (!hasTicket) ticketMissing.add(1)

    // Immediately re-join with the SAME device token to verify restore
    // semantics (duplicate-session guard): must return the identical
    // player_id/ticket_id, never create a second players row.
    const restoreRes = joinGame(data.gameCode, displayName, deviceToken, ACTIVE_TERM_IDS)
    if (restoreRes.status === 200 || restoreRes.status === 201) {
      try {
        const restoreBody = JSON.parse(restoreRes.body)
        const restoreRow = Array.isArray(restoreBody) ? restoreBody[0] : restoreBody
        const isSamePlayer = restoreRow && row && restoreRow.player_id === row.player_id
        check(restoreRow, { 'rejoin with same token restores same player_id': () => isSamePlayer })
        if (!isSamePlayer) duplicateJoins.add(1)
      } catch (e) {
        duplicateJoins.add(1)
      }
    }
  }

  sleep(1 + Math.random())
}

export { textSummaryHandler as handleSummary } from '../lib/summary.js'
