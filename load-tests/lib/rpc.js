// Thin wrappers around the Supabase PostgREST RPC endpoint
// (`${SUPABASE_URL}/rest/v1/rpc/<function_name>`), mirroring exactly what
// src/state/realtimeClient.ts does via the JS SDK. Raw HTTP is used instead
// of the SDK because RLS + the RPC's own SECURITY DEFINER checks are what
// gate behavior — not SDK-side logic — so plain HTTP exercises the real
// path a browser client takes.
import http from 'k6/http'
import { REST_URL, headers } from './config.js'

// submit_mark/submit_claim legitimately return 400 (a failed validation
// gate, e.g. TERM_NOT_ON_TICKET / NOT_ELIGIBLE) or 409 (a unique_violation
// from a duplicate mark/claim racing a constraint) as part of NORMAL
// business behavior — the app's own RPC comments describe both as
// expected, not errors. Without this, k6's built-in http_req_failed metric
// (and its default threshold) would count every such business rejection
// as a request failure, drowning out genuine backend errors in the
// summary. This callback marks 200/201/400/409 as "not failed" for RPCs
// tagged expectBusinessRejections, leaving true 401/403/404/5xx responses
// (and anything else unexpected) counted as real failures.
const expectBusinessRejections = http.expectedStatuses(200, 201, 400, 409)

function rpc(fnName, body, tags) {
  const allowBusinessRejections = tags && tags.expectBusinessRejections
  const res = http.post(`${REST_URL}/rpc/${fnName}`, JSON.stringify(body), {
    headers: headers(),
    tags: Object.assign({ rpc: fnName }, tags || {}),
    responseCallback: allowBusinessRejections ? expectBusinessRejections : undefined,
  })
  return res
}

/** join_game(p_game_code, p_display_name, p_device_join_token, p_active_term_ids) */
export function joinGame(gameCode, displayName, deviceJoinToken, activeTermIds) {
  return rpc(
    'join_game',
    {
      p_game_code: gameCode,
      p_display_name: displayName,
      p_device_join_token: deviceJoinToken,
      p_active_term_ids: activeTermIds,
    },
    { action: 'join' }
  )
}

/** call_next_word(p_game_id, p_host_secret, p_active_term_ids) — host-only */
export function callNextWord(gameId, hostSecret, activeTermIds) {
  return rpc(
    'call_next_word',
    {
      p_game_id: gameId,
      p_host_secret: hostSecret,
      p_active_term_ids: activeTermIds,
    },
    { action: 'call_next_word' }
  )
}

/** submit_mark(p_player_id, p_term_id) */
export function submitMark(playerId, termId) {
  return rpc(
    'submit_mark',
    {
      p_player_id: playerId,
      p_term_id: termId,
    },
    { action: 'mark', expectBusinessRejections: true }
  )
}

/** submit_claim(p_player_id, p_prize_id) */
export function submitClaim(playerId, prizeId) {
  return rpc(
    'submit_claim',
    {
      p_player_id: playerId,
      p_prize_id: prizeId,
    },
    { action: 'claim', expectBusinessRejections: true }
  )
}

/** get_active_game() — read-only, resolves the current game via the pointer */
export function getActiveGame() {
  return rpc('get_active_game', {}, { action: 'get_active_game' })
}

/** Plain REST read, e.g. GET /rest/v1/tickets?player_id=eq.<id>&select=* */
export function restGet(table, query, tags) {
  const res = http.get(`${REST_URL}/${table}?${query}`, {
    headers: headers(),
    tags: Object.assign({ table }, tags || {}),
  })
  return res
}
