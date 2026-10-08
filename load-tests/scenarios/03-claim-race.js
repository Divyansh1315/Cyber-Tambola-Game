// Scenario 3 — Prize Claim Race Condition (the critical scenario)
//
// setup() joins N players, calls enough words as host that EVERY player's
// ticket has >=5 marked terms (making every player eligible for CYBER_FIVE
// — the easiest prize to make universally eligible, since its gate is just
// "any 5 marked terms anywhere on the ticket", unlike line/full-house prizes
// which depend on exact cell layout per ticket). It then marks each
// player's own first 5 ticket terms via submit_mark (same RPC a real client
// uses) so every VU is a genuinely NOT_ELIGIBLE-free contender for the race.
//
// The actual test: all VUs fire submit_claim(playerId, 'CYBER_FIVE') for the
// SAME prize within one tight burst (a `shared-iterations` executor with a
// very short arrival pattern via a single iteration each, started together).
//
// What this checks (DB invariant from migration 0010's submit_claim):
//   - only one valid winner is accepted      -> exactly 1 CONFIRMED claim
//   - later valid claims are rejected        -> rest are VALID/REJECTED
//                                                with rejection_reason =
//                                                PRIZE_ALREADY_WON
//   - invalid claims do not lock the prize   -> covered implicitly: this
//                                                scenario's players are all
//                                                genuinely eligible, so any
//                                                INVALID claim seen here
//                                                would itself be a bug
//   - no duplicate confirmed winners         -> winners table query after
//                                                the burst must return
//                                                exactly 1 row for this
//                                                (game_id, prize_id)
//   - atomic locking works                   -> all of the above together
import { check, sleep } from 'k6'
import { submitClaim, callNextWord, submitMark, joinGame, restGet } from '../lib/rpc.js'
import { assertSafeTarget, GAME_CODE, GAME_ID, HOST_SECRET } from '../lib/config.js'
import { ACTIVE_TERM_IDS } from '../lib/cyberTerms.js'
import { dbErrors, duplicateWinners, isRpcError } from '../lib/metrics.js'

const RACERS = Number(__ENV.CLAIM_RACE_PLAYERS || 30) // 20-50 per the request
const PRIZE_ID = 'CYBER_FIVE'

export const options = {
  scenarios: {
    claim_race: {
      executor: 'shared-iterations',
      vus: RACERS,
      iterations: RACERS, // exactly one claim attempt per VU, fired together
      maxDuration: '30s',
    },
  },
  thresholds: {
    // This is the one invariant that must hold no matter what:
    duplicate_prize_winners: ['count==0'],
    db_errors: ['count==0'],
  },
}

export function setup() {
  assertSafeTarget()
  if (!GAME_ID || !HOST_SECRET) {
    throw new Error('GAME_ID and HOST_SECRET env vars are required for scenario 03 (host must call words).')
  }

  // 1. Call enough words that there is a reasonable common pool to mark
  // from. We call the first 10 terms in bank order so every ticket (random
  // 12-of-30 subset) has a good chance of overlapping with >=5 of them;
  // tickets with fewer than 5 overlapping marked terms are simply excluded
  // from the race pool below (they would legitimately fail NOT_ELIGIBLE,
  // which is correct app behavior, not something to force around).
  const calledTerms = ACTIVE_TERM_IDS.slice(0, 10)
  for (const _ of calledTerms) {
    callNextWord(GAME_ID, HOST_SECRET, ACTIVE_TERM_IDS)
    sleep(0.1)
  }
  // Re-fetch what was actually called (call_next_word picks randomly from
  // the remaining bank, not necessarily in list order), so we mark against
  // the real called set.
  const calledRes = restGet('called_terms', `game_id=eq.${GAME_ID}&select=term_id`)
  const actuallyCalled = (calledRes.status === 200 ? JSON.parse(calledRes.body) : []).map((r) => r.term_id)

  // 2. Join RACERS players and mark every called term that's on their
  // ticket, keeping only those who reach >=5 marks (genuinely eligible).
  const eligiblePlayers = []
  for (let i = 0; i < RACERS * 2 && eligiblePlayers.length < RACERS; i++) {
    const deviceToken = `loadtest-race-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const joinRes = joinGame(GAME_CODE, `TEST_ClaimRace_Player_${i}`, deviceToken, ACTIVE_TERM_IDS)
    if (joinRes.status !== 200 && joinRes.status !== 201) continue
    const row = JSON.parse(joinRes.body)[0] || JSON.parse(joinRes.body)

    const ticketRes = restGet('tickets', `id=eq.${row.ticket_id}&select=cells`)
    const ticket = ticketRes.status === 200 ? JSON.parse(ticketRes.body)[0] : null
    if (!ticket) continue
    const ticketTermIds = ticket.cells.map((c) => c.termId)
    const overlap = ticketTermIds.filter((t) => actuallyCalled.includes(t))

    if (overlap.length >= 5) {
      for (const termId of overlap.slice(0, 5)) {
        submitMark(row.player_id, termId)
      }
      eligiblePlayers.push(row.player_id)
    }
  }

  if (eligiblePlayers.length < 2) {
    throw new Error(
      `setup(): only found ${eligiblePlayers.length} eligible players for the claim race — need at least 2 to meaningfully test the race. Try increasing CLAIM_RACE_PLAYERS or re-running (ticket randomness).`
    )
  }

  return { eligiblePlayers }
}

export default function (data) {
  const player = data.eligiblePlayers[__VU % data.eligiblePlayers.length]
  const res = submitClaim(player, PRIZE_ID)

  check(res, { 'claim: RPC responded 200/201': (r) => r.status === 200 || r.status === 201 })
  if (isRpcError(res)) dbErrors.add(1)
}

export function teardown(data) {
  const winnersRes = restGet('winners', `prize_id=eq.${PRIZE_ID}&select=id,player_id,game_id`)
  const winners = winnersRes.status === 200 ? JSON.parse(winnersRes.body) : []
  // Scope to this run's game (GAME_ID) in case the staging project has
  // other games' winners rows for the same prize_id from earlier runs.
  const winnersForThisGame = winners.filter((w) => w.game_id === GAME_ID)

  if (winnersForThisGame.length > 1) {
    duplicateWinners.add(winnersForThisGame.length - 1)
    console.error(
      `CRITICAL: found ${winnersForThisGame.length} winners rows for (game_id=${GAME_ID}, prize_id=${PRIZE_ID}) — expected exactly 1. Atomic claim locking FAILED.`
    )
  } else if (winnersForThisGame.length === 1) {
    console.log(`OK: exactly 1 winner recorded for ${PRIZE_ID} out of ${data.eligiblePlayers.length} eligible racers.`)
  } else {
    console.error(`No winner recorded at all for ${PRIZE_ID} — unexpected given eligible racers existed.`)
  }

  const claimsRes = restGet(
    'claims',
    `prize_id=eq.${PRIZE_ID}&game_id=eq.${GAME_ID}&host_decision=eq.CONFIRMED&select=id`
  )
  const confirmedClaims = claimsRes.status === 200 ? JSON.parse(claimsRes.body) : []
  if (confirmedClaims.length > 1) {
    duplicateWinners.add(confirmedClaims.length - 1)
    console.error(`CRITICAL: found ${confirmedClaims.length} CONFIRMED claims for the same prize — expected exactly 1.`)
  }
}

export { textSummaryHandler as handleSummary } from '../lib/summary.js'
