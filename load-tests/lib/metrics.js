// Custom k6 metrics shared across scenarios so the end-of-run summary
// (see lib/summary.js) can report the exact fields requested:
// realtime connection failures, DB/API errors, duplicate prize winners,
// synchronization failures — none of which k6's built-in HTTP metrics
// capture on their own.
import { Counter, Trend } from 'k6/metrics'

export const dbErrors = new Counter('db_errors') // non-2xx / PostgREST error payloads
export const duplicateWinners = new Counter('duplicate_prize_winners') // should always stay 0
export const realtimeConnectFailures = new Counter('realtime_connect_failures')
export const realtimeMessageGapMs = new Trend('realtime_message_gap_ms') // host-call -> player-receive latency
export const syncFailures = new Counter('sync_failures') // player never saw an update it should have
export const duplicateJoins = new Counter('duplicate_player_sessions')
export const lostMarks = new Counter('lost_ticket_markings')
export const reconnectFailures = new Counter('reconnect_failures')

/**
 * Classify a PostgREST RPC response: true if it should count as a DB/API
 * error. PostgREST maps a raised plpgsql exception (e.g. a validation gate
 * failing) to HTTP 400 with a JSON error body, and a unique_violation
 * (e.g. a duplicate mark/claim racing the UNIQUE constraint) to HTTP 409 —
 * both are EXPECTED business-rule outcomes in this app, not backend
 * failures (see submit_mark's and submit_claim's own code comments: a
 * duplicate insert is explicitly "treated identically to no-op"). Callers
 * that want to additionally exclude a specific expected status for their
 * scenario (e.g. a scenario that treats 400 as fully expected noise) can
 * still check res.status themselves; this function only encodes the two
 * universally-expected non-error codes.
 */
export function isRpcError(res) {
  if (res.status === 400 || res.status === 409) return false
  if (res.status >= 400) return true
  return false
}
