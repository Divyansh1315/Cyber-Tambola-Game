import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { cyberTerms, findCyberTerm } from '../data/cyberTerms'
import type { CyberTerm } from '../types/cyberTerm'
import type { Mark } from '../types/mark'
import type { Player } from '../types/player'
import type { PrizeProgress } from '../types/prize'
import type { Ticket } from '../types/ticket'
import { getAllPrizeProgress, getPlayerTicketMarks } from '../utils/prizeEngine'
import {
  gameSessionReducer,
  type GameSessionAction,
  type RemoteSnapshot,
  type RollbackCollection,
} from './gameSessionReducer'
import {
  gameSessionInitialState,
  type GameSessionState,
} from './gameSessionInitialState'
import {
  readCurrentPlayerId,
  readEnvelope,
  writeCurrentPlayerId,
  writeEnvelope,
} from './persistence'
import { createSyncChannel, type SyncChannel } from './syncChannel'
import {
  getSupabaseClient,
  getActiveGame,
  subscribeToGame,
  subscribeToActiveGamePointer,
  resetGameToNew as rpcResetGameToNew,
  callNextWord as rpcCallNextWord,
  pauseGame as rpcPauseGame,
  resumeGame as rpcResumeGame,
  endGame as rpcEndGame,
  joinGame as rpcJoinGame,
  submitMark as rpcSubmitMark,
  submitClaim as rpcSubmitClaim,
  confirmClaim as rpcConfirmClaim,
  rejectClaim as rpcRejectClaim,
  type GetOrCreateGameResult,
} from './realtimeClient'
import {
  mapRowToClaim,
  mapRowToMark,
  mapRowToPlayer,
  mapRowToTicket,
  mapRowToWinner,
} from './remoteRowMappers'

/**
 * This device's per-game Host secret, obtained once via `get_or_create_game`
 * and required as an argument by every host-only RPC (Req 10.3, 10.4). Kept
 * only in `sessionStorage` (survives a refresh of the SAME tab, never sent
 * anywhere else) plus an in-memory ref inside the provider — never written
 * to any shared table, never included in any Realtime payload, and never
 * exposed via `GameSessionContextValue` (so no Player- or Presentation-
 * facing consumer can read it).
 */
const HOST_SECRET_STORAGE_KEY = 'cyber-tambola-v2:hostSecret'

function readHostSecret(): string | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.sessionStorage.getItem(HOST_SECRET_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function writeHostSecret(secret: string): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(HOST_SECRET_STORAGE_KEY, secret)
  } catch {
    // Best-effort; a failed write just means this device re-fetches it later.
  }
}

/**
 * Status of the initial fetch-and-subscribe against Supabase (Req 17.1).
 * `not-configured` covers the local-only dev fallback (no VITE_SUPABASE_*
 * env vars) -- there is nothing to sync in that mode, so it is never an
 * error. `error` is reached only after every retry attempt has been
 * exhausted; until then a transient failure keeps `syncing` (Req 24.5-ish:
 * a phone on flaky Wi-Fi should retry, not silently keep stale local data
 * forever with no indication anything is wrong).
 */
export type RemoteSyncStatus = 'not-configured' | 'syncing' | 'synced' | 'error'

/** Values exposed to consumers of the session context. */
export interface GameSessionContextValue {
  state: GameSessionState
  /**
   * Status of the initial Supabase fetch-and-subscribe (Req 17.1). Screens
   * that must never silently render stale local/cached data as if it were
   * live (e.g. PlayerGame) should show a retry/reload affordance while this
   * is `'error'`, rather than rendering the (possibly stale) `state` as-is.
   */
  remoteSyncStatus: RemoteSyncStatus
  /**
   * Dispatches the given optimistic action immediately (unchanged local
   * validation/behavior), then — when Supabase is configured — calls the
   * matching RPC and, on rejection, dispatches `ROLLBACK_OPTIMISTIC` for the
   * just-added optimistic entry (Req 3.1, 3.6, 6.1, 8.4, 12.5, 13.5, 14.1-
   * 14.3). Screens keep their existing `dispatch({ type: '...' })` call
   * shape by calling this instead of the raw reducer dispatch for every
   * host-only or player-mutating action. When Supabase is not configured,
   * this is equivalent to the raw dispatch (no RPC call attempted).
   */
  dispatch: (action: GameSessionAction) => void
  /**
   * Join a game from any device. When Supabase is configured, resolves via
   * the `join_game` RPC (authoritative game-code-exists / duplicate-
   * employee-id decision) and dispatches `RESTORE_PLAYER` for the resolved
   * player id; the caller's device then receives that player's full ticket
   * once `HYDRATE_FROM_REMOTE`/`SYNC_REMOTE` catch up, exactly as a
   * reconnect would. When Supabase is not configured, resolves to
   * `undefined` and the caller falls back to `joinService.ts`'s pure local
   * `buildJoinOutcome` + a direct `JOIN_PLAYER`/`RESTORE_PLAYER` dispatch
   * (unchanged local-only behavior, Req 17.2).
   */
  joinGame: (args: {
    gameCode: string
    displayName: string
    employeeDemoId: string
  }) => Promise<{ playerId: string; ticketId: string } | undefined>
  /** The full CyberTerm currently in play, or undefined in the lobby. */
  currentTerm?: CyberTerm
  /** Reveal history (newest first) resolved from revealedTermIds. */
  revealHistory: CyberTerm[]
  /** True when at least one active, unused term remains. */
  hasRemainingTerms: boolean
  /** The player for the active session, resolved from currentPlayerId. */
  currentPlayer?: Player
  /** The ticket owned by the current player, resolved from ticketId. */
  currentTicket?: Ticket
  /** Current_Player's Valid_Marks for Current_Ticket (Req 7.2). */
  currentPlayerMarks: Mark[]
  /** All 5 Prize_Progress entries for Current_Ticket, or [] with no ticket (Req 7.4, 15.1). */
  currentPrizeProgress: PrizeProgress[]
  /**
   * True once the initial local restore (shared envelope + client-local
   * currentPlayerId) has completed. In this app hydration is fully
   * synchronous (localStorage reads happen inside `initState`, which runs
   * synchronously as the reducer's initializer during the first render), so
   * this is `true` immediately — there is no real async gap to model. It is
   * still exposed explicitly so consumers like PlayerGame have an explicit
   * signal to gate their redirect-to-join guard on, rather than relying on
   * implicit synchronous timing.
   */
  isHydrated: boolean
  /**
   * True once an Active_Game has been resolved via the pointer-follow
   * effect (set on any successful `HYDRATE_FROM_REMOTE`); false whenever
   * `NO_ACTIVE_GAME` is the most recently dispatched outcome of that effect
   * (Req 3.4, 4.3). Deliberately NOT derived from `state.game.id`'s
   * truthiness -- that would conflate "no active game" with "local-only
   * fallback mode," which this flag must keep distinct. Local Fallback
   * (no Supabase configured) never dispatches either action, so this stays
   * at its initial `true` in that mode -- there is always a client-local
   * seed game to show.
   */
  hasActiveGame: boolean
}

const GameSessionContext = createContext<GameSessionContextValue | null>(null)

/**
 * Restore the persisted SHARED session envelope (Req 16.1, 16.2, 17.3). If a
 * valid slice is present, merge the restored `game`, `players`, `tickets`,
 * `marks`, `claims`, and `winners` over the seed. A missing/malformed
 * envelope falls back cleanly to the seed. This restore is always the LOCAL
 * fallback — when Supabase is configured, the mount-time effect below
 * immediately overwrites this with `HYDRATE_FROM_REMOTE` once the initial
 * fetch resolves (Req 17.1), so a device never acts on stale local data for
 * longer than that first round trip.
 *
 * `currentPlayerId` is client-local identity and is restored SEPARATELY from
 * its own dedicated storage key, then reconciled against whichever `players`
 * array ends up in the returned state (dangling-id handling moved here from
 * persistence.ts, since it must run against the final restored `players`,
 * not the raw envelope in isolation).
 */
function initState(): GameSessionState {
  const restored = readEnvelope()
  const base: GameSessionState = restored
    ? {
        ...gameSessionInitialState,
        game: restored.game,
        players: restored.players,
        tickets: restored.tickets,
        marks: restored.marks,
        claims: restored.claims,
        winners: restored.winners,
      }
    : gameSessionInitialState

  const savedPlayerId = readCurrentPlayerId()
  const currentPlayerId =
    savedPlayerId && base.players.some((p) => p.id === savedPlayerId)
      ? savedPlayerId
      : undefined

  return { ...base, currentPlayerId }
}

/** A structural subset of the Supabase client this module calls directly (`.from(...)`). */
interface SupabaseLike {
  from(table: string): {
    select(columns?: string): {
      eq(
        column: string,
        value: unknown,
      ): Promise<{ data: Record<string, unknown>[] | null; error: unknown }>
    }
  }
}

/**
 * Read every row for one `game_id` from a shared table via a plain read-only
 * `SELECT` (Req 14.2 — no RPC side effects). Returns `[]` on any error
 * rather than throwing, so one failed table read during the initial fetch
 * degrades gracefully instead of blocking hydration entirely.
 */
async function selectRows(
  supabase: SupabaseLike,
  table: string,
  gameId: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase.from(table).select('*').eq('game_id', gameId)
  if (error || !data) return []
  return data
}

/**
 * Fetch the full current state of one game via read-only `SELECT`s (Req
 * 14.1, 14.2): the game row itself (already available from
 * `get_or_create_game`), `called_terms` (folded into `revealedTermIds`),
 * `players`, `tickets`, `marks`, `claims`, and `winners`. Assembles a
 * `RemoteSnapshot` ready for `HYDRATE_FROM_REMOTE`.
 */
async function fetchFullGameState(
  supabase: SupabaseLike,
  gameRow: Record<string, unknown>,
): Promise<RemoteSnapshot> {
  const gameId = gameRow.id as string

  const [calledTermRows, playerRows, ticketRows, markRows, claimRows, winnerRows] =
    await Promise.all([
      selectRows(supabase, 'called_terms', gameId),
      selectRows(supabase, 'players', gameId),
      selectRows(supabase, 'tickets', gameId),
      selectRows(supabase, 'marks', gameId),
      selectRows(supabase, 'claims', gameId),
      selectRows(supabase, 'winners', gameId),
    ])

  const tickets: Ticket[] = ticketRows.map(mapRowToTicket)
  const ticketByPlayerId = new Map(tickets.map((t) => [t.playerId, t]))
  const players: Player[] = playerRows.map((row) =>
    mapRowToPlayer(row, ticketByPlayerId.get(row.id as string)),
  )

  const revealedTermIds = calledTermRows.map((row) => row.term_id as string)

  const game: GameSessionState['game'] = {
    id: gameId,
    code: gameRow.code as string,
    status: gameRow.status as GameSessionState['game']['status'],
    createdAt: gameRow.created_at as string,
    startedAt: (gameRow.started_at as string | null) ?? undefined,
    endedAt: (gameRow.ended_at as string | null) ?? undefined,
    currentRound: gameRow.current_round as number,
    currentTermId: (gameRow.current_term_id as string | null) ?? undefined,
    revealedTermIds,
    previousStatus:
      (gameRow.previous_status as GameSessionState['game']['status'] | null) ?? undefined,
  }

  return {
    game,
    players,
    tickets,
    marks: markRows.map(mapRowToMark),
    claims: claimRows.map(mapRowToClaim),
    winners: winnerRows.map(mapRowToWinner),
  }
}

/**
 * Given an optimistic action just dispatched and the state that resulted
 * from it, resolve which local collection + id `ROLLBACK_OPTIMISTIC` should
 * remove if the matching RPC rejects. Only actions that add exactly one new
 * row to an addressable collection have a rollback target; lifecycle
 * actions (`START_GAME`/`CALL_NEXT_WORD`/`PAUSE_GAME`/`RESUME_GAME`/
 * `END_GAME`/`RESET_GAME`) mutate the single `games` row instead, which has
 * no per-row id to roll back — for those, a failed RPC is simply left for
 * the next `SYNC_REMOTE`/`HYDRATE_FROM_REMOTE` to reconcile.
 */
function resolveRollbackTarget(
  action: GameSessionAction,
  before: GameSessionState,
  after: GameSessionState,
): { collection: RollbackCollection; id: string } | undefined {
  switch (action.type) {
    case 'MARK_TERM': {
      const added = after.marks.find((m) => !before.marks.some((b) => b.id === m.id))
      return added ? { collection: 'marks', id: added.id } : undefined
    }
    case 'SUBMIT_PRIZE_CLAIM': {
      const added = after.claims.find((c) => !before.claims.some((b) => b.id === c.id))
      return added ? { collection: 'claims', id: added.id } : undefined
    }
    case 'CONFIRM_CLAIM': {
      const added = after.winners.find((w) => !before.winners.some((b) => b.id === w.id))
      return added ? { collection: 'winners', id: added.id } : undefined
    }
    default:
      return undefined
  }
}

export function GameSessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(
    gameSessionReducer,
    undefined,
    initState,
  )

  // Always holds the latest state, for the wrapped dispatch below (it needs
  // the state as it was BEFORE and AFTER a given optimistic dispatch, but a
  // closure captured at render time would only ever see "before").
  const stateRef = useRef(state)
  stateRef.current = state

  // Tracks the initial fetch-and-subscribe's outcome (Req 17.1) -- see
  // RemoteSyncStatus's doc comment. Starts at 'not-configured'; the mount
  // effect below flips it to 'syncing' the instant it finds a configured
  // Supabase client, then to 'synced' or (after exhausting retries) 'error'.
  const [remoteSyncStatus, setRemoteSyncStatus] = useState<RemoteSyncStatus>('not-configured')

  // Whether an Active_Game is currently resolved (Req 3.4, 4.3) -- see
  // GameSessionContextValue.hasActiveGame's doc comment. Starts `true`:
  // Local Fallback always has a client-local seed game, and the
  // Supabase-configured mount effect only ever flips this to `false` if/when
  // it actually discovers there is no Active_Game to follow (task 7.1 wires
  // that dispatch/set up; this task only adds the flag itself).
  const [hasActiveGame, setHasActiveGame] = useState<boolean>(true)

  // This device's Host secret, once obtained. Never exposed via context
  // value.
  const hostSecretRef = useRef<string | undefined>(readHostSecret())
  // The Supabase-assigned game id, once resolved via get_or_create_game.
  const gameIdRef = useRef<string | undefined>(undefined)

  // One sync channel per provider instance (per tab). Created lazily so the id
  // is stable for this tab's lifetime.
  const channelRef = useRef<SyncChannel | null>(null)
  if (channelRef.current === null) {
    channelRef.current = createSyncChannel()
  }

  // True while applying a snapshot received from another tab, so the persist +
  // broadcast effect below does NOT echo it back (loop guard #2; the channel's
  // senderId check is loop guard #1).
  const applyingRemoteRef = useRef(false)

  // Subscribe to snapshots from other tabs once, on mount. Incoming payloads
  // are applied via SYNC_LOCAL; the reducer ignores malformed ones
  // (fail-safe). This is a same-browser-tab, zero-authority convenience
  // (design.md Decision 7) — it never competes with the Supabase-backed
  // fetch/subscribe effect below.
  useEffect(() => {
    const channel = channelRef.current
    if (!channel) return
    const unsubscribe = channel.subscribe((payload) => {
      applyingRemoteRef.current = true
      dispatch({ type: 'SYNC_LOCAL', payload })
    })
    return () => {
      unsubscribe()
      channel.close()
      channelRef.current = null
    }
  }, [])

  // Initial resolve + subscribe against Supabase: runs once, only when
  // Supabase is configured (Req 17.1, 17.2). Resolves the current
  // Active_Game strictly through the server-side pointer (get_active_game),
  // fetches its full current state via read-only SELECTs, replaces local
  // state outright via HYDRATE_FROM_REMOTE (Req 14.1-14.4), then subscribes
  // to Realtime for this game_id and folds every incoming row change in via
  // SYNC_REMOTE. A second subscription follows the pointer itself for the
  // lifetime of this provider (Req 4.4, 6.1): whenever it changes, the old
  // per-game channel is unsubscribed and a new one opened for the newly
  // announced game, or NO_ACTIVE_GAME is dispatched if the pointer clears to
  // null. When Supabase is NOT configured, this effect is a no-op and the
  // app stays on the local/seed fallback (Req 17.2) established by
  // initState above.
  useEffect(() => {
    const supabase = getSupabaseClient()
    if (!supabase) return // dev fallback: no Supabase configured, stay local

    let gameChannel: RealtimeChannel | null = null
    let cancelled = false

    async function hydrateForGame(gameRow: GetOrCreateGameResult) {
      gameIdRef.current = gameRow.id
      // host_secret is only meaningful if THIS device is the Host;
      // Presentation View simply never calls a host-only RPC, so storing it
      // unconditionally here is unchanged from today's behavior.
      writeHostSecret(gameRow.host_secret)
      hostSecretRef.current = gameRow.host_secret

      const snapshot = await fetchFullGameState(
        supabase as unknown as SupabaseLike,
        gameRow as unknown as Record<string, unknown>,
      )
      if (cancelled) return
      dispatch({ type: 'HYDRATE_FROM_REMOTE', snapshot })
      setHasActiveGame(true)

      // Req 6.2: tear down the OLD per-game channel before/while
      // establishing the new one. Unsubscribing first (rather than after)
      // means a stale event from the old game_id can never be delivered
      // once this function returns (Req 6.3) — there is a brief window with
      // zero subscriptions, never a window with two.
      gameChannel?.unsubscribe()
      gameChannel = subscribeToGame(gameRow.id, (change) => {
        dispatch({ type: 'SYNC_REMOTE', change })
      })
    }

    ;(async () => {
      try {
        const activeGame = await getActiveGame()
        if (cancelled) return
        if (activeGame) {
          await hydrateForGame(activeGame)
        } else {
          // Req 4.3: no Active_Game exists — explicit "no active game"
          // state, never a fallback to any previously resolved game.
          gameIdRef.current = undefined
          setHasActiveGame(false)
          dispatch({ type: 'NO_ACTIVE_GAME' })
        }
      } catch {
        // Initial resolve/fetch failed (e.g. a transient network issue) —
        // the app keeps rendering the local/seed fallback already in state
        // rather than crashing.
      }
    })()

    // Req 4.4, 6.1: keep listening for pointer changes for the lifetime of
    // this provider, whether or not an Active_Game is currently held.
    const pointerChannel = subscribeToActiveGamePointer((newActiveGameId) => {
      if (cancelled) return
      if (newActiveGameId === gameIdRef.current) return // no-op: same game re-announced
      if (newActiveGameId === null) {
        gameChannel?.unsubscribe()
        gameChannel = null
        gameIdRef.current = undefined
        setHasActiveGame(false)
        dispatch({ type: 'NO_ACTIVE_GAME' })
        return
      }
      getActiveGame()
        .then((row) => {
          if (!cancelled && row) return hydrateForGame(row)
          return undefined
        })
        .catch(() => {
          // Transient fetch failure following a pointer-change event — stay
          // on whatever state is already rendered rather than crashing.
        })
    })

    return () => {
      cancelled = true
      gameChannel?.unsubscribe()
      pointerChannel?.unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount
  }, [])

  // Persist the SHARED session envelope so a refresh resumes the game (Req
  // 16.1, 16.2, 17.3) AND broadcast it to other tabs for live sync. When the
  // change came from a remote snapshot we still persist (so a refresh
  // restores it) but skip re-broadcasting to prevent an infinite tab-to-tab
  // loop. `currentPlayerId` is deliberately excluded from both the envelope
  // and the broadcast — it is client-local identity, persisted via its own
  // effect below and never synchronized across tabs.
  useEffect(() => {
    const slice = {
      game: state.game,
      players: state.players,
      tickets: state.tickets,
      marks: state.marks,
      claims: state.claims,
      winners: state.winners,
    }
    writeEnvelope(slice)

    if (applyingRemoteRef.current) {
      applyingRemoteRef.current = false
      return
    }
    channelRef.current?.post(slice)
  }, [
    state.game,
    state.players,
    state.tickets,
    state.marks,
    state.claims,
    state.winners,
  ])

  // Persist THIS tab's client-local player identity under its own dedicated
  // key, independent of the shared-state effect above. Never broadcast.
  useEffect(() => {
    writeCurrentPlayerId(state.currentPlayerId)
  }, [state.currentPlayerId])

  const value = useMemo<GameSessionContextValue>(() => {
    const currentTerm = state.game.currentTermId
      ? findCyberTerm(state.game.currentTermId)
      : undefined

    // Reveal history newest-first, resolved against the central bank.
    const revealHistory = [...state.game.revealedTermIds]
      .reverse()
      .map((id) => findCyberTerm(id))
      .filter((t): t is CyberTerm => Boolean(t))

    const usedCount = state.game.revealedTermIds.length
    const activeCount = cyberTerms.filter((t) => t.active).length

    // Derived session selectors (Req 9.1).
    const currentPlayer = state.players.find((p) => p.id === state.currentPlayerId)
    const currentTicket = currentPlayer
      ? state.tickets.find((t) => t.id === currentPlayer.ticketId)
      : undefined

    // Derived marking + prize-progress selectors (Req 7.2, 7.4, 15.1).
    const currentPlayerMarks =
      currentPlayer && currentTicket
        ? getPlayerTicketMarks(state.marks, currentPlayer.id, currentTicket.id)
        : []

    const currentPrizeProgress = currentTicket
      ? getAllPrizeProgress(currentTicket, currentPlayerMarks)
      : []

    /**
     * Wraps every host-only and player-mutating dispatch call site: dispatch
     * the existing optimistic action first (unchanged), then — only when
     * Supabase is configured — call the matching RPC. On rejection, dispatch
     * ROLLBACK_OPTIMISTIC for the just-added optimistic entry (row-level
     * actions only; see resolveRollbackTarget).
     */
    function wrappedDispatch(action: GameSessionAction) {
      const before = stateRef.current
      dispatch(action)

      const supabase = getSupabaseClient()
      if (!supabase) return // local-only fallback: optimistic dispatch is the whole story

      const gameId = gameIdRef.current
      const hostSecret = hostSecretRef.current

      const after = gameSessionReducer(before, action)
      const rollbackTarget = resolveRollbackTarget(action, before, after)

      function rollback() {
        if (rollbackTarget) {
          dispatch({
            type: 'ROLLBACK_OPTIMISTIC',
            collection: rollbackTarget.collection,
            id: rollbackTarget.id,
          })
        }
      }

      switch (action.type) {
        case 'START_GAME':
          // Starting the game and calling the first word are the same
          // server-side operation: call_next_word's own LOBBY branch
          // handles the LOBBY -> WORD_ACTIVE transition, picks the first
          // term, and sets started_at (0004_rpc_word_and_marks.sql). The
          // previous version of this case made no RPC call at all here,
          // relying on a false assumption that get_or_create_game already
          // reached WORD_ACTIVE during hydration -- it never does, so a
          // fresh LOBBY game's first word only ever updated the Host's own
          // optimistic local state, never the database, leaving every
          // other device stuck in LOBBY until the Host's NEXT click.
          if (gameId && hostSecret) {
            rpcCallNextWord(
              gameId,
              hostSecret,
              cyberTerms.filter((t) => t.active).map((t) => t.id),
            ).catch(rollback)
          }
          break
        case 'CALL_NEXT_WORD':
          if (gameId && hostSecret) {
            rpcCallNextWord(
              gameId,
              hostSecret,
              cyberTerms.filter((t) => t.active).map((t) => t.id),
            ).catch(rollback)
          }
          break
        case 'PAUSE_GAME':
          if (gameId && hostSecret) rpcPauseGame(gameId, hostSecret).catch(rollback)
          break
        case 'RESUME_GAME':
          if (gameId && hostSecret) rpcResumeGame(gameId, hostSecret).catch(rollback)
          break
        case 'END_GAME':
          if (gameId && hostSecret) rpcEndGame(gameId, hostSecret).catch(rollback)
          break
        case 'RESET_GAME':
          // Reset now creates a brand-new game and repoints the server-side
          // Active_Game pointer at it (Req 5.1); this device (and every
          // other open Host/Presentation tab) picks up the new game via the
          // pointer-follow effect's subscribeToActiveGamePointer callback
          // once that change event arrives — NOT via a direct local dispatch
          // of the new game here. The optimistic RESET_GAME dispatch above
          // still applies immediately for this tab's own rendering, but the
          // pointer event's HYDRATE_FROM_REMOTE is what ultimately reconciles
          // it against the real new game (Req 9.3 covers Local Fallback,
          // where no Supabase client exists and this branch is never taken).
          if (gameId && hostSecret) rpcResetGameToNew(gameId, hostSecret).catch(rollback)
          break
        case 'MARK_TERM': {
          const player = before.players.find((p) => p.id === before.currentPlayerId)
          if (player) rpcSubmitMark(player.id, action.termId).catch(rollback)
          break
        }
        case 'SUBMIT_PRIZE_CLAIM':
          rpcSubmitClaim(action.playerId, action.prizeId).catch(rollback)
          break
        case 'CONFIRM_CLAIM':
          if (hostSecret) rpcConfirmClaim(action.claimId, hostSecret).catch(rollback)
          break
        case 'REJECT_CLAIM':
          if (hostSecret) {
            rpcRejectClaim(action.claimId, hostSecret, action.rejectionReason).catch(rollback)
          }
          break
        default:
          break
      }
    }

    /**
     * Join from any device (Req 3.1, 3.6). When Supabase is configured,
     * resolves via the `join_game` RPC and dispatches RESTORE_PLAYER for the
     * resolved player id — the full ticket/marks/claims for that player
     * arrive moments later via SYNC_REMOTE (or the next HYDRATE_FROM_REMOTE
     * on a subsequent mount), exactly like a reconnect. When Supabase is not
     * configured, resolves to undefined so the caller falls back to
     * joinService.ts's pure local outcome (Req 17.2).
     */
    async function joinGame(args: {
      gameCode: string
      displayName: string
      employeeDemoId: string
    }) {
      const supabase = getSupabaseClient()
      if (!supabase) return undefined
      const activeTermIds = cyberTerms.filter((t) => t.active).map((t) => t.id)
      const result = await rpcJoinGame(
        args.gameCode,
        args.displayName,
        args.employeeDemoId,
        activeTermIds,
      )
      // Fetch this player's own player + ticket rows directly rather than
      // relying on RESTORE_PLAYER (which requires the player to already be
      // present in local state) or waiting on Realtime's SYNC_REMOTE to
      // catch up (Req 3.6): the RPC path always joins a player this device
      // has never seen before, so JOIN_PLAYER (append player + ticket, set
      // currentPlayerId) is the correct action here, not RESTORE_PLAYER.
      const [{ data: playerRows }, { data: ticketRows }] = await Promise.all([
        supabase.from('players').select('*').eq('id', result.player_id),
        supabase.from('tickets').select('*').eq('id', result.ticket_id),
      ])
      const playerRow = playerRows?.[0] as Record<string, unknown> | undefined
      const ticketRow = ticketRows?.[0] as Record<string, unknown> | undefined
      if (playerRow && ticketRow) {
        const ticket = mapRowToTicket(ticketRow)
        const player = mapRowToPlayer(playerRow, ticket)
        // join_game restores an existing player's id on a duplicate join
        // (Req 3.6): if this device already has that player locally (e.g.
        // an earlier SYNC_REMOTE/HYDRATE already added them), use
        // RESTORE_PLAYER so JOIN_PLAYER's unconditional append never
        // duplicates them in state.players/state.tickets.
        if (state.players.some((p) => p.id === player.id)) {
          dispatch({ type: 'RESTORE_PLAYER', playerId: player.id })
        } else {
          dispatch({ type: 'JOIN_PLAYER', player, ticket })
        }
      } else {
        // Defensive fallback if either read failed: at least point
        // currentPlayerId so a subsequent SYNC_REMOTE/HYDRATE can catch up.
        dispatch({ type: 'RESTORE_PLAYER', playerId: result.player_id })
      }

      return { playerId: result.player_id, ticketId: result.ticket_id }
    }

    return {
      state,
      remoteSyncStatus,
      dispatch: wrappedDispatch,
      joinGame,
      currentTerm,
      revealHistory,
      hasRemainingTerms: usedCount < activeCount,
      currentPlayer,
      currentTicket,
      currentPlayerMarks,
      currentPrizeProgress,
      // Hydration is synchronous in this app (see initState's doc comment),
      // so this is true from the very first render.
      isHydrated: true,
      hasActiveGame,
    }
  }, [state, remoteSyncStatus, hasActiveGame])

  return (
    <GameSessionContext.Provider value={value}>
      {children}
    </GameSessionContext.Provider>
  )
}

/** Hook for consuming the session context; throws if used outside the provider. */
export function useGameSession(): GameSessionContextValue {
  const ctx = useContext(GameSessionContext)
  if (!ctx) {
    throw new Error('useGameSession must be used within a GameSessionProvider')
  }
  return ctx
}
