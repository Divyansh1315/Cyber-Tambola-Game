import { createClient, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js'

/**
 * One Supabase client per browser tab, created from Vite-exposed env vars.
 * Never hard-coded; missing vars are handled explicitly by
 * `getSupabaseConfig` rather than left to throw deep inside supabase-js -
 * `npm run dev` must still start cleanly with no `.env.local` at all (see
 * design.md's "Environment Configuration" section).
 */
export interface SupabaseConfig {
  url: string
  anonKey: string
}

export function getSupabaseConfig(): SupabaseConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null
  return { url, anonKey }
}

let client: SupabaseClient | null = null

/** Lazily create the singleton client, or null if unconfigured (dev fallback mode). */
export function getSupabaseClient(): SupabaseClient | null {
  if (client) return client
  const config = getSupabaseConfig()
  if (!config) return null
  client = createClient(config.url, config.anonKey)
  return client
}

/**
 * Normalized shape of one authoritative row change, delivered either from a
 * Realtime `postgres_changes` event or synthesized from an initial fetch.
 * Matches `MockRemoteChange` in `testSupport/mockSupabaseClient.ts` exactly,
 * so tests built against the mock exercise the same shape production code
 * consumes.
 */
export interface RemoteChange {
  table: 'games' | 'called_terms' | 'players' | 'tickets' | 'marks' | 'claims' | 'winners'
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  row: Record<string, unknown>
}

/**
 * Subscribe to every row change for one game_id across all six shared
 * tables, scoped by Postgres Changes' built-in per-table `filter`. Each
 * event is normalized into a RemoteChange the reducer's SYNC_REMOTE action
 * consumes directly - see gameSessionReducer.ts.
 *
 * `games` itself is filtered by its own `id` column, not a `game_id` foreign
 * key (it *is* the game); every other table is filtered by `game_id`.
 */
export function subscribeToGame(
  gameId: string,
  onChange: (change: RemoteChange) => void,
): RealtimeChannel | null {
  const supabase = getSupabaseClient()
  if (!supabase) return null

  const channel = supabase.channel(`game:${gameId}`)
  const tables: RemoteChange['table'][] = [
    'games',
    'called_terms',
    'players',
    'tickets',
    'marks',
    'claims',
    'winners',
  ]

  for (const table of tables) {
    const filterColumn = table === 'games' ? 'id' : 'game_id'
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter: `${filterColumn}=eq.${gameId}` },
      (payload) =>
        onChange({
          table,
          eventType: payload.eventType as RemoteChange['eventType'],
          row: (payload.new ?? payload.old) as Record<string, unknown>,
        }),
    )
  }

  channel.subscribe((status, err) => {
    // No callback was previously passed to .subscribe(), so a failed
    // subscription (CHANNEL_ERROR, TIMED_OUT, or the socket simply never
    // reaching SUBSCRIBED -- e.g. a mobile network/proxy blocking the
    // underlying WebSocket handshake even though plain HTTPS RPC calls
    // work fine) was completely invisible: no console output, no visible
    // error, and the affected device would never receive ANY live update
    // again.
    console.info(`[realtime] game:${gameId} channel status: ${status}`, err ?? '')
  })
  return channel
}

/**
 * Typed error thrown by every RPC wrapper below when the underlying
 * `supabase.rpc(...)` call resolves with a non-null `error`. Carries the
 * Postgres exception code raised inside the RPC (e.g. `GAME_NOT_FOUND`,
 * `NOT_AUTHORIZED`, `TERM_NOT_REVEALED`) so callers (GameSessionContext) can
 * branch on it without string-matching a message.
 */
export class RpcError extends Error {
  /** The RPC's raised exception code, e.g. "GAME_NOT_FOUND". */
  readonly code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'RpcError'
    this.code = code
  }
}

/**
 * Postgres raises a plain `raise exception 'CODE'` as a Postgrest error
 * whose `message` is exactly that code (no wrapping text) in this
 * codebase's RPC convention - see design.md's RPC function bodies. Falling
 * back to the raw message (or a generic code) keeps this resilient if a
 * driver ever nests the code differently.
 */
function toRpcError(error: { message?: string; code?: string } | null | undefined): RpcError {
  const code = error?.message?.trim() || error?.code?.trim() || 'RPC_ERROR'
  return new RpcError(code, error?.message)
}

/** Runs one `.rpc(name, args)` call, throwing a typed RpcError on failure. */
async function callRpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const supabase = getSupabaseClient()
  if (!supabase) {
    throw new RpcError('SUPABASE_NOT_CONFIGURED', 'Supabase client is not configured')
  }
  const { data, error } = await supabase.rpc(name, args)
  if (error) {
    throw toRpcError(error)
  }
  return data as T
}

// --- Thin RPC wrappers, one per RPC authored in the Group A migrations ---
// Each is a direct pass-through to `callRpc`; argument names mirror the SQL
// function signatures in design.md exactly (snake_case on the wire, mapped
// from camelCase parameters here).

export interface GetOrCreateGameResult {
  id: string
  code: string
  host_secret: string
  status: string
  current_round: number
  current_term_id: string | null
  previous_status: string | null
  created_at: string
  started_at: string | null
  ended_at: string | null
  updated_at: string
}

export function getOrCreateGame(code: string): Promise<GetOrCreateGameResult> {
  return callRpc<GetOrCreateGameResult>('get_or_create_game', { p_code: code })
}

export interface JoinGameResult {
  player_id: string
  ticket_id: string
}

/**
 * join_game is declared "returns table(player_id uuid, ticket_id uuid)" in
 * SQL, which PostgREST always resolves to an array of rows (even for
 * exactly one row) - never a single flat object, unlike every other RPC
 * here that returns a single games/marks/claims/winners row type. This
 * wrapper unwraps that one-row array so every caller gets a flat result.
 */
export async function joinGame(
  gameCode: string,
  displayName: string,
  employeeDemoId: string,
  activeTermIds: string[],
): Promise<JoinGameResult> {
  const rows = await callRpc<JoinGameResult[]>('join_game', {
    p_game_code: gameCode,
    p_display_name: displayName,
    p_employee_demo_id: employeeDemoId,
    p_active_term_ids: activeTermIds,
  })
  const row = rows[0]
  if (!row) {
    throw new RpcError('JOIN_GAME_EMPTY_RESULT', 'join_game returned no rows')
  }
  return row
}

export function callNextWord(
  gameId: string,
  hostSecret: string,
  activeTermIds: string[],
): Promise<GetOrCreateGameResult> {
  return callRpc<GetOrCreateGameResult>('call_next_word', {
    p_game_id: gameId,
    p_host_secret: hostSecret,
    p_active_term_ids: activeTermIds,
  })
}

export function pauseGame(gameId: string, hostSecret: string): Promise<GetOrCreateGameResult> {
  return callRpc<GetOrCreateGameResult>('pause_game', {
    p_game_id: gameId,
    p_host_secret: hostSecret,
  })
}

export function resumeGame(gameId: string, hostSecret: string): Promise<GetOrCreateGameResult> {
  return callRpc<GetOrCreateGameResult>('resume_game', {
    p_game_id: gameId,
    p_host_secret: hostSecret,
  })
}

export function endGame(gameId: string, hostSecret: string): Promise<GetOrCreateGameResult> {
  return callRpc<GetOrCreateGameResult>('end_game', {
    p_game_id: gameId,
    p_host_secret: hostSecret,
  })
}

export function resetGame(gameId: string, hostSecret: string): Promise<GetOrCreateGameResult> {
  return callRpc<GetOrCreateGameResult>('reset_game', {
    p_game_id: gameId,
    p_host_secret: hostSecret,
  })
}

export interface MarkRow {
  id: string
  game_id: string
  player_id: string
  ticket_id: string
  term_id: string
  marked_at: string
}

export function submitMark(playerId: string, termId: string): Promise<MarkRow> {
  return callRpc<MarkRow>('submit_mark', {
    p_player_id: playerId,
    p_term_id: termId,
  })
}

export interface ClaimRow {
  id: string
  game_id: string
  player_id: string
  ticket_id: string
  prize_id: string
  submitted_at: string
  validation_status: string
  host_decision: string
  rejection_reason: string | null
  decided_at: string | null
  prize_label: string
  player_name: string
  ticket_ref: string
}

export function submitClaim(playerId: string, prizeId: string): Promise<ClaimRow> {
  return callRpc<ClaimRow>('submit_claim', {
    p_player_id: playerId,
    p_prize_id: prizeId,
  })
}

export interface WinnerRow {
  id: string
  game_id: string
  prize_id: string
  player_id: string
  ticket_id: string
  claim_id: string
  confirmed_at: string
  prize_label: string
  player_name: string
  ticket_ref: string
}

export function confirmClaim(claimId: string, hostSecret: string): Promise<WinnerRow> {
  return callRpc<WinnerRow>('confirm_claim', {
    p_claim_id: claimId,
    p_host_secret: hostSecret,
  })
}

export function rejectClaim(
  claimId: string,
  hostSecret: string,
  reason?: string,
): Promise<ClaimRow> {
  return callRpc<ClaimRow>('reject_claim', {
    p_claim_id: claimId,
    p_host_secret: hostSecret,
    p_reason: reason,
  })
}

// --- Active_Game pointer and winner history (winner-history-and-game-reset) ---
// Additive exports: resolving/following the Active_Game via a singleton
// server-side pointer, resetting to a fresh game, and reading the complete,
// unscoped winner history. See design.md's "realtimeClient.ts additions".

export interface ActiveGamePointerRow {
  id: true
  active_game_id: string | null
  updated_at: string
}

/** Resolves the Active_Game via get_active_game(). Returns undefined when none exists (Req 3.4). */
export async function getActiveGame(): Promise<GetOrCreateGameResult | undefined> {
  const supabase = getSupabaseClient()
  if (!supabase) return undefined
  const { data, error } = await supabase.rpc('get_active_game')
  if (error) throw toRpcError(error)
  const rows = data as GetOrCreateGameResult[] | GetOrCreateGameResult | null
  const row = Array.isArray(rows) ? rows[0] : rows
  return row ?? undefined
}

export interface ResetGameToNewResult {
  old_game_id: string
  new_game: GetOrCreateGameResult
}

/**
 * reset_game_to_new is declared "returns table(old_game_id uuid, new_game
 * games)" in SQL, which PostgREST always resolves to an array of rows -
 * mirroring join_game's own array-unwrapping convention above. Unwraps the
 * single returned row for callers.
 */
export function resetGameToNew(
  oldGameId: string,
  hostSecret: string,
): Promise<ResetGameToNewResult> {
  return callRpc<ResetGameToNewResult[]>('reset_game_to_new', {
    p_old_game_id: oldGameId,
    p_host_secret: hostSecret,
  }).then((rows) => rows[0])
}

/**
 * Subscribes to the single active_game_pointer row. Unlike subscribeToGame,
 * there is no game_id to filter by - the table has exactly one row, so
 * every change event is relevant. Fires onChange with the new
 * active_game_id (string) or null (Req 3.4, 6.1, 6.5).
 */
export function subscribeToActiveGamePointer(
  onChange: (activeGameId: string | null) => void,
): RealtimeChannel | null {
  const supabase = getSupabaseClient()
  if (!supabase) return null

  const channel = supabase.channel('active-game-pointer')
  channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'active_game_pointer' },
    (payload) => onChange((payload.new as { active_game_id: string | null }).active_game_id),
  )
  channel.subscribe((status, err) => {
    console.info(`[realtime] active-game-pointer channel status: ${status}`, err ?? '')
  })
  return channel
}

/**
 * Fetches every winners row across every game, plus every game's own
 * id/code/created_at for Winner_History's group headers (Req 2.1-2.4). Both
 * selects are plain, unfiltered reads (no RPC, no game_id filter) run in
 * parallel - deliberately unlike every other table read in this codebase.
 */
export async function fetchAllWinnersWithGames(): Promise<{
  winners: Record<string, unknown>[]
  games: Record<string, unknown>[]
}> {
  const supabase = getSupabaseClient()
  if (!supabase) return { winners: [], games: [] }
  const [{ data: winners }, { data: games }] = await Promise.all([
    supabase.from('winners').select('*'),
    supabase.from('games').select('id, code, created_at'),
  ])
  return { winners: winners ?? [], games: games ?? [] }
}
