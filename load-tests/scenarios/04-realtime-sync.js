// Scenario 4 — Realtime Synchronization
//
// ⚠ KNOWN BLOCKER (as of k6 v2.2.0 on Windows, tested against this
// project): the `open` event never fires for a WebSocket connected to
// Supabase Realtime's Phoenix-protocol endpoint, with EITHER k6/websockets
// or the deprecated k6/experimental/websockets. The TCP/TLS handshake
// genuinely completes (ws_connecting metric reports <1s, and the
// connection stays alive for the full sleep duration before a clean
// code-1000 close), but k6 never dispatches the open callback, so
// phx_join is never sent and no postgres_changes events are ever received.
// This was confirmed with a minimal repro script (open a socket, log
// readyState immediately after construction — correctly 0/CONNECTING —
// then wait; only a close event, never open, is ever observed) and is a
// k6/environment limitation, not an application defect — this scenario's
// logic is otherwise believed correct and should work once run against a
// k6 version/environment where this is fixed (try a newer k6 release, or
// running from a Linux/mac runner instead of Windows, before re-attempting).
// DO NOT treat a "realtime_connect_failures" result from a run of this
// script as a verdict on the application's realtime behavior until this
// blocker is resolved and re-verified.
//
// Opens ~100 concurrent Supabase Realtime WebSocket connections, each
// subscribed to game:<gameId> exactly like subscribeToGame() in
// src/state/realtimeClient.ts (postgres_changes on games + called_terms).
// While all are connected, a separate setup-time host loop calls several
// words. Each VU records the time between connecting and receiving each
// called_terms INSERT event, which approximates host-to-player fan-out
// latency (not host-call-timestamp-to-receipt, since k6 VUs run as
// independent iterations — see README's caveats on this scenario's
// precision).
//
// What this checks:
//   - all connected players receive updates -> events_received counter vs
//                                                expected count
//   - no major delay                         -> realtime_message_gap_ms trend
//   - called-word history stays synchronized -> each VU's locally
//                                                accumulated called_terms
//                                                list length matches what a
//                                                REST read of called_terms
//                                                shows at the end
//   - disconnected users can reconnect       -> see 05-reconnect.js, which
//                                                focuses on this specifically;
//                                                this scenario keeps every
//                                                connection open throughout
import { check, sleep } from 'k6'
import { Counter } from 'k6/metrics'
import { connectToGameChannel } from '../lib/realtime.js'
import { callNextWord, restGet } from '../lib/rpc.js'
import { assertSafeTarget, GAME_ID, HOST_SECRET } from '../lib/config.js'
import { ACTIVE_TERM_IDS } from '../lib/cyberTerms.js'
import { realtimeConnectFailures, syncFailures, realtimeMessageGapMs } from '../lib/metrics.js'

const CONNECTED_PLAYERS = Number(__ENV.REALTIME_PLAYERS || 100)
const WORDS_TO_CALL = Number(__ENV.REALTIME_WORDS || 8)
const LISTEN_SECONDS = 45

export const options = {
  scenarios: {
    realtime_listeners: {
      executor: 'per-vu-iterations',
      vus: CONNECTED_PLAYERS,
      iterations: 1,
      maxDuration: `${LISTEN_SECONDS + 30}s`,
    },
    host_caller: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      startTime: '5s', // give listeners time to connect & join first
      maxDuration: `${LISTEN_SECONDS}s`,
      exec: 'hostCallWords',
    },
  },
  thresholds: {
    realtime_connect_failures: ['count==0'],
    sync_failures: ['count<5'], // allow a little slack; see README interpretation notes
  },
}

const eventsReceived = new Counter('realtime_events_received')

export function setup() {
  assertSafeTarget()
  if (!GAME_ID || !HOST_SECRET) {
    throw new Error('GAME_ID and HOST_SECRET env vars are required for scenario 04.')
  }
  return { gameId: GAME_ID }
}

export default function (data) {
  const receivedTermIds = []
  let joined = false
  let connectedAt = 0

  const ws = connectToGameChannel(data.gameId, ['games', 'called_terms'], {
    onJoined: () => {
      joined = true
      connectedAt = Date.now()
    },
    onError: () => {
      realtimeConnectFailures.add(1)
    },
    onEvent: (table, eventType, row) => {
      if (table === 'called_terms' && eventType === 'INSERT' && row && row.term_id) {
        receivedTermIds.push(row.term_id)
        eventsReceived.add(1)
        realtimeMessageGapMs.add(Date.now() - connectedAt)
      }
    },
  })

  sleep(LISTEN_SECONDS)

  if (!joined) {
    realtimeConnectFailures.add(1)
  }

  // Compare this VU's locally observed called-word history against the
  // authoritative REST read, to check "called-word history stays
  // synchronized" per the request.
  const authoritative = restGet('called_terms', `game_id=eq.${data.gameId}&select=term_id`)
  const authoritativeIds = authoritative.status === 200 ? JSON.parse(authoritative.body).map((r) => r.term_id) : []

  const missed = authoritativeIds.filter((id) => !receivedTermIds.includes(id))
  if (missed.length > 0) {
    syncFailures.add(missed.length)
  }
  check(missed, { 'VU received every called word the backend recorded': (m) => m.length === 0 })

  ws.close()
}

export function hostCallWords() {
  for (let i = 0; i < WORDS_TO_CALL; i++) {
    callNextWord(GAME_ID, HOST_SECRET, ACTIVE_TERM_IDS)
    sleep(3) // space out calls to resemble real host pacing, not a hot loop
  }
}

export { textSummaryHandler as handleSummary } from '../lib/summary.js'
